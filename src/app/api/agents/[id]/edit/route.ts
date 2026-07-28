import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id: agentId } = await params;
  if (!isValidUUID(agentId)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { documentId, filename, newContent, isNewFile } = body as {
    documentId?: string;
    filename?: string;
    newContent?: string;
    isNewFile?: boolean;
  };

  if (typeof newContent !== "string" || !newContent.trim()) {
    return NextResponse.json({ error: "Invalid content" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("id, files_count")
    .eq("id", agentId)
    .eq("user_id", user.id)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  let docId = documentId;

  // Try to find existing document
  if (!docId || !isValidUUID(docId)) {
    if (!filename) {
      return NextResponse.json({ error: "Invalid document ID or filename" }, { status: 400 });
    }
    const { data: docByName } = await supabase
      .from("documents")
      .select("id, title")
      .eq("agent_id", agentId)
      .eq("title", filename)
      .limit(1)
      .single();
    if (docByName) {
      docId = docByName.id;
    }
  }

  // If document found, update it
  if (docId && isValidUUID(docId)) {
    const { data: doc } = await supabase
      .from("documents")
      .select("id, title")
      .eq("id", docId)
      .eq("agent_id", agentId)
      .single();

    if (doc) {
      const { error: updateError } = await supabase
        .from("documents")
        .update({ parsed_content: newContent.slice(0, 500_000) })
        .eq("id", docId);

      if (updateError) {
        console.error("[Edit] Update error:", updateError);
        return NextResponse.json({ error: "Failed to update document" }, { status: 500 });
      }

      console.log(`[Edit] Updated document ${doc.title} (${newContent.length} chars) in agent ${agentId}`);
      return NextResponse.json({
        success: true,
        document: { id: doc.id, title: doc.title },
      });
    }
  }

  // Document not found — create it as a new file
  if (!filename) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  console.log(`[Edit] Creating new file "${filename}" in agent ${agentId}`);

  const { data: agentFile, error: fileError } = await supabase
    .from("agent_files")
    .insert({
      agent_id: agentId,
      file_name: filename,
      file_type: "text/plain",
      status: "indexed",
    })
    .select()
    .single();

  if (fileError || !agentFile) {
    console.error("[Edit] Failed to create file record:", fileError);
    return NextResponse.json({ error: "Failed to create file" }, { status: 500 });
  }

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
    console.error("[Edit] Failed to create document:", docError);
    return NextResponse.json({ error: "Failed to create document" }, { status: 500 });
  }

  // Update agent files count
  await supabase
    .from("agents")
    .update({ files_count: (agent.files_count || 0) + 1 })
    .eq("id", agentId);

  console.log(`[Edit] Created new file "${filename}" (${newContent.length} chars) in agent ${agentId}`);

  return NextResponse.json({
    success: true,
    document: { id: doc.id, title: filename },
    created: true,
  });
}
