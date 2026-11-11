import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/validators";

/**
 * Shared logic for creating or updating a text-only file inside an agent.
 *
 * Used by:
 *   1. POST /api/agents/[id]/edit  (user-initiated edits from the sidebar)
 *   2. POST /api/chat/stream       (AI-generated [NEW_FILE: xxx] blocks)
 *
 * Behavior:
 *   - If a document with the same title (filename) exists for this agent:
 *     update its parsed_content with the new content.
 *   - If not: create both an agent_files row AND a documents row, and bump
 *     the agent's files_count.
 *
 * Notes:
 *   - Text-only — no Storage upload, no OCR, no chunking/embedding. This is
 *     intentional: AI-generated files are typically code (.html, .js, .py,
 *     .md, .json, .txt) where RAG retrieval adds no value.
 *   - Uses the admin client (service role) so it can run from any context,
 *     including the chat stream route which already uses an admin client.
 *
 * Returns: { success, documentId?, created?, error? }
 */
export interface SaveAgentFileResult {
  success: boolean;
  documentId?: string;
  created?: boolean;
  error?: string;
}

export async function saveAgentFileInternal(
  agentId: string,
  filename: string,
  newContent: string
): Promise<SaveAgentFileResult> {
  // Validate inputs
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" };
  }
  if (!filename || !filename.trim()) {
    return { success: false, error: "Invalid filename" };
  }
  if (typeof newContent !== "string" || !newContent.trim()) {
    return { success: false, error: "Invalid content" };
  }

  const supabase = createAdminClient();

  // Verify the agent exists (don't check user_id — this is called from
  // server-side code that has already verified auth in the chat route)
  const { data: agent } = await supabase
    .from("agents")
    .select("id, files_count")
    .eq("id", agentId)
    .single();

  if (!agent) {
    return { success: false, error: "Agent not found" };
  }

  // Try to find an existing document by filename (title)
  let docId: string | null = null;
  const { data: existingDoc } = await supabase
    .from("documents")
    .select("id, title")
    .eq("agent_id", agentId)
    .eq("title", filename)
    .limit(1)
    .single();

  if (existingDoc) {
    docId = existingDoc.id;
  }

  // Also check if there's an agent_files row with the same file_name
  // (the document might exist under a slightly different title — be defensive)
  if (!docId) {
    const { data: existingFile } = await supabase
      .from("agent_files")
      .select("id")
      .eq("agent_id", agentId)
      .eq("file_name", filename)
      .limit(1)
      .single();

    if (existingFile) {
      // Found a file record — look up its document row
      const { data: fileDoc } = await supabase
        .from("documents")
        .select("id")
        .eq("source_file_id", existingFile.id)
        .eq("agent_id", agentId)
        .single();

      if (fileDoc) {
        docId = fileDoc.id;
      }
    }
  }

  // ── Case 1: Document exists → update content ──
  if (docId && isValidUUID(docId)) {
    const { error: updateError } = await supabase
      .from("documents")
      .update({ parsed_content: newContent.slice(0, 500_000) })
      .eq("id", docId);

    if (updateError) {
      console.error("[saveAgentFileInternal] Update error:", updateError);
      return { success: false, error: "Failed to update document" };
    }

    console.log(
      `[saveAgentFileInternal] Updated "${filename}" (${newContent.length} chars) in agent ${agentId}`
    );
    return { success: true, documentId: docId, created: false };
  }

  // ── Case 2: Document not found → create file + document + bump count ──

  // Determine MIME type from extension (for the file_type column)
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeByExt: Record<string, string> = {
    html: "text/html", htm: "text/html",
    css: "text/css",
    js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
    jsx: "text/jsx",
    ts: "text/typescript", tsx: "text/tsx",
    json: "application/json",
    py: "text/x-python",
    md: "text/markdown", markdown: "text/markdown",
    txt: "text/plain",
    xml: "application/xml",
    svg: "image/svg+xml",
    yml: "application/x-yaml", yaml: "application/x-yaml",
    sh: "application/x-sh", bash: "application/x-sh",
    sql: "application/sql",
  };
  const fileType = mimeByExt[ext] || "text/plain";

  // Insert agent_files row
  const { data: agentFile, error: fileError } = await supabase
    .from("agent_files")
    .insert({
      agent_id: agentId,
      file_name: filename,
      file_type: fileType,
      status: "indexed", // mark as indexed immediately — content is ready
    })
    .select()
    .single();

  if (fileError || !agentFile) {
    console.error("[saveAgentFileInternal] Failed to create file record:", fileError);
    return { success: false, error: "Failed to create file record" };
  }

  // Insert document row (with the actual content)
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .insert({
      agent_id: agentId,
      source_file_id: agentFile.id,
      title: filename,
      parsed_content: newContent.slice(0, 500_000),
    })
    .select()
    .single();

  if (docError || !doc) {
    // Clean up the agent_files row to avoid an orphaned record
    await supabase.from("agent_files").delete().eq("id", agentFile.id);
    console.error("[saveAgentFileInternal] Failed to create document:", docError);
    return { success: false, error: "Failed to create document" };
  }

  // Bump the agent's files_count
  await supabase
    .from("agents")
    .update({ files_count: (agent.files_count || 0) + 1 })
    .eq("id", agentId);

  console.log(
    `[saveAgentFileInternal] Created new file "${filename}" (${newContent.length} chars) in agent ${agentId}`
  );

  return {
    success: true,
    documentId: doc.id,
    created: true,
  };
}

/**
 * Apply a [FILE_EDIT: xxx] block to an existing file in the agent.
 *
 * Format of the diff:
 *   <<<<<<< ORIGINAL
 *   <exact original code being replaced>
 *   =======
 *   <complete replacement code>
 *   >>>>>>> END
 *
 * Behavior:
 *   - If the file exists AND the ORIGINAL section is found in its current
 *     content: replace that exact section with the new code, save the
 *     updated full content.
 *   - If the file exists but ORIGINAL is not found: replace the entire
 *     file content with the new code (lenient mode — the model may have
 *     paraphrased the original; this still gives the user a working file).
 *   - If the file doesn't exist: create it with the new code (treats
 *     FILE_EDIT like NEW_FILE when the target file is missing).
 */
export interface ApplyFileEditResult {
  success: boolean;
  documentId?: string;
  created?: boolean;
  replaced?: boolean;
  fallback?: boolean; // true if we couldn't find ORIGINAL and replaced whole content
  updatedContent?: string;
  error?: string;
}

export async function applyFileEditInternal(
  agentId: string,
  filename: string,
  originalCode: string,
  newCode: string
): Promise<ApplyFileEditResult> {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" };
  }
  if (!filename || !filename.trim()) {
    return { success: false, error: "Invalid filename" };
  }

  const supabase = createAdminClient();

  // Find existing document by filename
  const { data: existingDoc } = await supabase
    .from("documents")
    .select("id, title, parsed_content")
    .eq("agent_id", agentId)
    .eq("title", filename)
    .limit(1)
    .single();

  // ── Case 1: file doesn't exist → create it with the new code ──
  if (!existingDoc) {
    console.log(
      `[applyFileEditInternal] File "${filename}" not found, creating as new file`
    );
    const createResult = await saveAgentFileInternal(agentId, filename, newCode);
    if (!createResult.success) {
      return { success: false, error: createResult.error };
    }
    return {
      success: true,
      documentId: createResult.documentId,
      created: true,
      updatedContent: newCode,
    };
  }

  // ── File exists → try exact-match replace first ──
  const currentContent = existingDoc.parsed_content || "";

  if (originalCode && currentContent.includes(originalCode)) {
    // Replace the first occurrence of ORIGINAL with the new code
    const updatedContent = currentContent.replace(originalCode, newCode);
    const { error: updateError } = await supabase
      .from("documents")
      .update({ parsed_content: updatedContent.slice(0, 500_000) })
      .eq("id", existingDoc.id);

    if (updateError) {
      console.error("[applyFileEditInternal] Update error:", updateError);
      return { success: false, error: "Failed to update document" };
    }

    console.log(
      `[applyFileEditInternal] Applied exact-match edit to "${filename}" (${updatedContent.length} chars)`
    );
    return {
      success: true,
      documentId: existingDoc.id,
      replaced: true,
      updatedContent,
    };
  }

  // ── Fallback: ORIGINAL not found → replace entire file content ──
  // The model may have paraphrased the original code, or the file may have
  // been edited manually since the model last saw it. Replacing the whole
  // file with the new content is more useful than failing.
  console.warn(
    `[applyFileEditInternal] ⚠️  ORIGINAL section not found in "${filename}" — falling back to full content replace`
  );

  const { error: fullUpdateError } = await supabase
    .from("documents")
    .update({ parsed_content: newCode.slice(0, 500_000) })
    .eq("id", existingDoc.id);

  if (fullUpdateError) {
    console.error("[applyFileEditInternal] Fallback update error:", fullUpdateError);
    return { success: false, error: "Failed to update document" };
  }

  return {
    success: true,
    documentId: existingDoc.id,
    replaced: true,
    fallback: true,
    updatedContent: newCode,
  };
}
