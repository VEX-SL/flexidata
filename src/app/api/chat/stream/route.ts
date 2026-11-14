import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { validateMessage, isValidUUID } from "@/lib/validators";
import { getProviderManager } from "@/lib/ai/manager";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import { searchRelevantChunks, buildRAGContext } from "@/lib/rag/search";
import { buildAgentDocumentContext } from "@/lib/agent/document-context";
import { generateImage } from "@/lib/ai/image-generation";
import { saveAgentFileInternal, applyFileEditInternal } from "@/lib/agent-files";

const MAX_HISTORY = 20;

const EDIT_FOLLOWUP_PROMPT = `You failed to output the FILE_EDIT block in your previous response. You MUST fix this NOW.

Output ALL file edits in this EXACT format (one block per file):

[FILE_EDIT: exact-filename.py]
<<<<<<< ORIGINAL
(paste the EXACT old code here, line by line)
=======
(paste the COMPLETE new code here, the entire file)
>>>>>>> END

You can output MULTIPLE FILE_EDIT blocks if multiple files need changes.

RULES:
- ORIGINAL = ONLY the old code being replaced (exact copy)
- After ======= = ONLY the new code (complete replacement)
- Code MUST have proper newlines and indentation
- NEVER output code on a single line
- The ======= separator MUST be on its own line
- After ALL blocks, write a 1-line summary with **bold** key changes`;

const EDIT_KEYWORDS_AR = [
  "عدّل", "تعديل", "حسّن", "تحسين", "أضف", "اضف", "احذف", "حذف",
  "غيّر", "تغيير", "بدّل", "استبدل", "شغّل", "شغّل",
  "حسّن الكود", "اضف كود", "ازالة", "اجعل", "حسّنه", "عدّل عليه",
  "ترجم", "حول", "حوّل", "اجعله", "بدّل ل", "استبدل ب",
];
const EDIT_KEYWORDS_EN = [
  "edit", "modify", "improve", "update", "add", "remove", "delete",
  "change", "replace", "fix", "refactor", "rewrite",
  "rename", "reformat", "clean up", "optimize", "simplify",
  "translate", "convert", "transform", "swap to", "change to",
];

// ✅ Read-only intent: the user is ASKING ABOUT the files, not requesting a
// modification. Questions like "show me the changes in a table" or
// "اشرح التعديلات" contain edit-ish words ("change", "تعديل") as substrings
// but are clearly questions — they must NEVER trigger the forced FILE_EDIT
// follow-up. Rule: if a read-only word appears BEFORE the first edit
// keyword (or no edit keyword exists at all), the message is a question.
const READ_ONLY_KEYWORDS_AR = [
  "اشرح", "شوف", "شورني", "ورني", "اعرض", "وضّح", "وضح", "ليه", "لماذا",
  "ازاي", "إزاي", "ايه", "إيه", "مين", "فين", "كام", "ما هو", "ما هي",
  "الفرق", "فارق", "ممكن اعرف", "عايز اعرف", "عايز اشوف", "لخص", "ملخص",
];
const READ_ONLY_KEYWORDS_EN = [
  "show", "explain", "describe", "list", "summarize", "summary", "display",
  "print", "view", "what is", "what are", "what was", "what did", "which",
  "why", "how ", "tell me", "review", "compare", "walk me through",
  "give me an overview", "in a table",
];

// Multi-word English phrases (can't be matched word-by-word below)
const EDIT_PHRASES_EN = ["clean up", "swap to", "change to", "turn into", "convert to"];

function firstKeywordIndex(msg: string, keywords: string[]): number {
  let best = -1;
  for (const k of keywords) {
    const i = msg.indexOf(k);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

function isEditRequest(msg: string, fileContext: string): boolean {
  if (!fileContext) return false;
  const lower = msg.toLowerCase();

  // 1) Read-only priority: a question wins over edit words that appear later.
  const editIdx = firstKeywordIndex(lower, [...EDIT_KEYWORDS_AR, ...EDIT_KEYWORDS_EN]);
  const readIdx = firstKeywordIndex(lower, [...READ_ONLY_KEYWORDS_AR, ...READ_ONLY_KEYWORDS_EN]);
  if (readIdx !== -1 && (editIdx === -1 || readIdx <= editIdx)) return false;

  // 2) Arabic keywords: substring match — Arabic morphology adds prefixes
  //    and suffixes, so "التعديلات" must match "تعديل".
  if (EDIT_KEYWORDS_AR.some((k) => lower.includes(k))) return true;

  // 3) English keywords: whole-word match — prevents false positives like
  //    "add" inside "address" or "change" inside "unchanged".
  const words = lower.match(/\b[a-z]+\b/g) || [];
  if (words.some((w) => EDIT_KEYWORDS_EN.includes(w))) return true;

  // 4) Multi-word English phrases.
  return EDIT_PHRASES_EN.some((p) => lower.includes(p));
}

// ─── Image attachments ([IMAGE_ATTACHMENT: url] markers) ────────────────────
// The chat composer prepends this marker to a user message that carries an
// attached image (see the agent chat page). The marker is STORED with the
// message — the UI renders the thumbnail from it and it survives reloads —
// but it must be stripped everywhere the TEXT reaches the model (prompt
// history, RAG query, title fallback, Arabic detection) so the storage URL
// never pollutes the LLM context.
const IMAGE_ATTACHMENT_LINE_RE = /^[ \t]*\[IMAGE_ATTACHMENT:[ \t]*[^\]\n]+\][ \t]*\r?\n?/gm;

function stripImageAttachments(content: string): string {
  if (!content) return content;
  return content.replace(IMAGE_ATTACHMENT_LINE_RE, "").trim();
}

// Pulls the stored public URL out of the marker (which may also carry the
// file name after a "|"): [IMAGE_ATTACHMENT: <url> | <name>]
const IMAGE_ATTACHMENT_URL_RE = /\[IMAGE_ATTACHMENT:[ \t]*([^\]\n|]+)[^\]\n]*\]/;

function extractAttachedImageUrl(content: string): string | null {
  const m = content.match(IMAGE_ATTACHMENT_URL_RE);
  return m ? m[1].trim() : null;
}

/**
 * Normalize [NEW_FILE: xxx] and [FILE_EDIT: xxx] blocks in the model output:
 * if a block's content is NOT already wrapped in a fenced code block (```...```),
 * wrap it automatically. This fixes the common failure mode where the model
 * outputs raw HTML/JS/CSS without fences and the markdown renderer eats the
 * tags (user sees a blank message).
 *
 * ⚠️ PRESERVATION RULE: text written AFTER a block (the 1–2 line summary, an
 * explanation, a table — anything between ">>>>>>> END" and the next marker)
 * belongs to the chat reply and MUST survive normalization. The previous
 * version returned only marker+fence here, which silently deleted everything
 * the model wrote after an unfenced FILE_EDIT block (the reported
 * "continuation of the response never showed" bug).
 *
 * Returns the fixed content.
 */
function normalizeFileBlocks(content: string): string {
  if (!content) return content;

  // Match [NEW_FILE: filename.ext] OR [FILE_EDIT: filename.ext] followed by
  // anything (non-greedy) up to the next [NEW_FILE/[FILE_EDIT or end of string.
  const blockPattern = /\[(NEW_FILE|FILE_EDIT|DELETE_FILE):[ \t]*([^\]\n]+)\]([\s\S]*?)(?=\[(?:NEW_FILE|FILE_EDIT|DELETE_FILE):|$)/g;

  return content.replace(blockPattern, (match, kind: string, filename: string, body: string) => {
    // DELETE_FILE markers have no body — leave them untouched (they are
    // executed and stripped further down).
    if (kind === "DELETE_FILE") return match;

    // Already wrapped in a fenced code block? Keep the matched region EXACTLY
    // as-is — any text after the fence (summary, table, …) stays untouched.
    const bodyStart = body.trimStart();
    if (bodyStart.startsWith("```")) {
      return match;
    }

    // Unfenced body → wrap it. For FILE_EDIT the block ends at ">>>>>>> END";
    // everything after the END marker is chat text and must be preserved.
    let trailing = "";
    if (kind === "FILE_EDIT") {
      const endMarker = body.indexOf(">>>>>>> END");
      if (endMarker >= 0) {
        trailing = body.slice(endMarker + ">>>>>>> END".length);
        body = body.slice(0, endMarker + ">>>>>>> END".length);
        if (trailing && !trailing.startsWith("\n")) trailing = "\n" + trailing;
      }
    }

    // Pick a language tag based on the file extension
    const ext = filename.trim().split(".").pop()?.toLowerCase() || "";
    const langByExt: Record<string, string> = {
      html: "html", htm: "html",
      css: "css",
      js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
      ts: "typescript", tsx: "tsx",
      json: "json",
      py: "python",
      sh: "bash", bash: "bash",
      sql: "sql",
      md: "markdown", markdown: "markdown",
      yml: "yaml", yaml: "yaml",
      xml: "xml",
      svg: "xml",
      txt: "text",
    };
    const lang = langByExt[ext] || "";

    // Wrap the body in a fenced code block, then re-attach the chat text
    // that followed the block (summary / explanation / table).
    const fenced = "```" + lang + "\n" + body.trim() + "\n```";

    return `[${kind}: ${filename}]\n${fenced}\n${trailing}`;
  });
}

/**
 * Extract [NEW_FILE: filename.ext] blocks (with fenced code) from content.
 * Returns array of { filename, content, language }.
 */
function extractNewFileBlocks(content: string): Array<{
  filename: string;
  content: string;
  language: string;
}> {
  const blocks: Array<{ filename: string; content: string; language: string }> = [];
  // Match [NEW_FILE: filename] followed by ```lang\n...\n```
  const pattern = /\[NEW_FILE:\s*([^\]]+)\]\s*```(\w*)\n?([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    blocks.push({
      filename: match[1].trim(),
      language: match[2] || "",
      content: match[3],
    });
  }
  return blocks;
}

/**
 * Extract [FILE_EDIT: filename.ext] blocks (with ORIGINAL/=======/END markers)
 * from content. Returns array of { filename, originalCode, newCode }.
 *
 * Expected format (after normalizeFileBlocks has wrapped the body in fences):
 *
 *   [FILE_EDIT: filename.ext]
 *   ```<lang>
 *   <<<<<<< ORIGINAL
 *   <old code>
 *   =======
 *   <new code>
 *   >>>>>>> END
 *   ```
 */
function extractFileEditBlocks(content: string): Array<{
  filename: string;
  originalCode: string;
  newCode: string;
}> {
  const blocks: Array<{ filename: string; originalCode: string; newCode: string }> = [];
  // Match [FILE_EDIT: filename] followed by ```lang\n<body>```
  const pattern = /\[FILE_EDIT:\s*([^\]]+)\]\s*```(\w*)\n?([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const filename = match[1].trim();
    const body = match[3];
    // Parse the ORIGINAL/=======/END markers from the body
    const diffMatch = body.match(
      /<<<<<<<\s*ORIGINAL\s*\n([\s\S]*?)\n=======\s*\n([\s\S]*?)\n>>>>>>> END/
    );
    if (diffMatch) {
      blocks.push({
        filename,
        originalCode: diffMatch[1],
        newCode: diffMatch[2],
      });
    } else {
      // Malformed FILE_EDIT block — log it so we can see why
      console.warn(`[Chat Stream] ⚠️  Malformed FILE_EDIT block for "${filename}" — missing ORIGINAL/=======/END markers`);
    }
  }
  return blocks;
}

/**
 * Strip [NEW_FILE: xxx] and [FILE_EDIT: xxx] block bodies from content.
 * Used AFTER we've extracted + processed the blocks: the file edit info is
 * captured in a tool_step, so we don't want the raw diff/code text in the
 * displayed/saved message.
 *
 * This scans marker-by-marker instead of one big regex:
 * - FILE_EDIT → body ends at ">>>>>>> END" (or the next marker / EOF).
 * - NEW_FILE  → body ends at the closing ``` fence when present, otherwise
 *   at the next marker / EOF.
 * Text BETWEEN blocks (summaries, explanations, tables) is always preserved.
 * Works on fenced AND unfenced blocks (belt & suspenders alongside
 * normalizeFileBlocks), and never leaves a half-strip behind when the code
 * itself contains ``` fences.
 *
 * Also strips [USE_SKILL: xxx] markers anywhere in the content (the model
 * sometimes puts them at the end instead of the start — we just remove
 * them from the user-facing text either way).
 *
 * IMPORTANT: This does NOT strip "Available Skills" headings or skill
 * descriptions (which are normal text content the model outputs when
 * the user asks "what skills do you have?"). Only the markers themselves
 * are stripped.
 */
function stripFileBlocks(content: string): string {
  if (!content) return content;
  const MARKER_RE = /\[(NEW_FILE|FILE_EDIT|DELETE_FILE):[ \t]*[^\]\n]+\]/g;
  let out = "";
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(content)) !== null) {
    if (m.index < pos) continue; // marker inside an already-consumed body
    out += content.slice(pos, m.index);
    const kind = m[1];
    if (kind === "DELETE_FILE") {
      // Marker-only operation — remove the marker and its line.
      let deleteEnd = m.index + m[0].length;
      if (content[deleteEnd] === "\r") deleteEnd++;
      if (content[deleteEnd] === "\n") deleteEnd++;
      pos = deleteEnd;
      MARKER_RE.lastIndex = pos;
      continue;
    }
    const bodyStart = m.index + m[0].length;
    // First marker after this one — hard boundary for an unterminated body
    MARKER_RE.lastIndex = bodyStart;
    const next = MARKER_RE.exec(content);
    const nextIdx = next ? next.index : -1;

    let bodyEnd: number;
    if (kind === "FILE_EDIT") {
      const endIdx = content.indexOf(">>>>>>> END", bodyStart);
      bodyEnd =
        endIdx !== -1 && (nextIdx === -1 || endIdx < nextIdx)
          ? endIdx + ">>>>>>> END".length
          : nextIdx === -1
            ? content.length
            : nextIdx;
    } else {
      // NEW_FILE: cut at the closing fence when the body is fenced.
      // Allow leading whitespace/newlines — normalizeFileBlocks emits
      // "[NEW_FILE: x]\n```lang", so the fence never starts flush.
      const after = content.slice(bodyStart);
      const fenceOpen = after.match(/^[ \t\r\n]*```/);
      if (fenceOpen) {
        const firstNl = after.indexOf("\n", fenceOpen[0].length);
        const closeRel = firstNl === -1 ? -1 : after.indexOf("```", firstNl);
        bodyEnd =
          closeRel !== -1
            ? bodyStart + closeRel + 3
            : nextIdx === -1
              ? content.length
              : nextIdx;
      } else {
        bodyEnd = nextIdx === -1 ? content.length : nextIdx;
      }
    }
    pos = bodyEnd;
    MARKER_RE.lastIndex = pos;
  }
  out += content.slice(pos);
  // Remove standalone [USE_SKILL: xxx] markers anywhere.
  // Note: the marker pattern is strict (`[USE_SKILL: skill_name]`), so it
  // won't match prose like "I'll use the skill: clean_code_architect".
  out = out.replace(/\[USE_SKILL:\s*[a-zA-Z0-9_-]+\s*\]/g, "");
  // Clean up extra blank lines
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

// Pattern to detect [USE_SKILL: skill_name] marker at the start of a response
const SKILL_MARKER_PATTERN = /^\s*\[USE_SKILL:\s*([a-zA-Z0-9_-]+)\s*\]/i;

export async function POST(request: Request) {
  const identifier = getClientIdentifier(request);
  const rateCheck = checkRateLimit(identifier, "chat");
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many requests." },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.ceil((rateCheck.resetAt - Date.now()) / 1000)
          ),
        },
      }
    );
  }

  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { chatId, content, agentId, replaceMessageId } = body as {
    chatId?: string;
    content: string;
    agentId?: string;
    replaceMessageId?: string;
  };

  const msgValidation = validateMessage(content);
  if (!msgValidation.valid) {
    return NextResponse.json({ error: msgValidation.error }, { status: 400 });
  }

  if (chatId && !isValidUUID(chatId)) {
    return NextResponse.json({ error: "Invalid chat ID" }, { status: 400 });
  }

  if (agentId && !isValidUUID(agentId)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  // ✅ Regenerate mode: if replaceMessageId is provided, we'll UPDATE that
  // existing assistant message instead of inserting a new one. This prevents
  // duplicate messages when the user regenerates a response in place.
  if (replaceMessageId && !isValidUUID(replaceMessageId)) {
    return NextResponse.json({ error: "Invalid replaceMessageId" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Get or create chat
  let chat: { id: string; title: string | null; agent_id: string | null } | null = null;
  let isNewChat = false;

  if (chatId) {
    const { data } = await supabase
      .from("chats")
      .select("id, title, agent_id")
      .eq("id", chatId)
      .eq("user_id", user.id)
      .single();

    if (!data) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
    chat = data;
  } else if (replaceMessageId) {
    // ✅ Regenerate mode requires an existing chatId
    return NextResponse.json({ error: "chatId required for regenerate mode" }, { status: 400 });
  }

  if (chat) {
    const requestedAgentId = agentId || null;
    const chatAgentId = chat.agent_id || null;
    if (chatAgentId !== requestedAgentId) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
  }

  if (!chat) {
    isNewChat = true;
    const { data, error } = await supabase
      .from("chats")
      .insert({ user_id: user.id, agent_id: agentId || null })
      .select()
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "Failed to create chat" }, { status: 500 });
    }
    chat = data;
  }

  if (!chat) {
    return NextResponse.json({ error: "Failed to resolve chat" }, { status: 500 });
  }

  // Save user message (only for NEW chats — skip in regenerate mode where
  // the user message already exists from the original turn)
  // ✅ Real-ids fix: capture the real DB id so the frontend can replace its
  // temporary id — otherwise regenerating that message later sends a
  // non-UUID id and the route rejects it with "Invalid replaceMessageId".
  let insertedUserMessageId: string | null = null;
  if (!replaceMessageId) {
    const { data: insertedUserMsg, error: userMsgError } = await supabase
      .from("messages")
      .insert({
        chat_id: chat.id,
        role: "user",
        content: msgValidation.value!,
      })
      .select("id")
      .single();
    if (userMsgError) {
      console.error("[Chat Stream] Failed to save user message:", userMsgError);
    } else if (insertedUserMsg) {
      insertedUserMessageId = insertedUserMsg.id;
    }
  }

  // Get chat history
  // ✅ Regenerate history filter: in regenerate mode, include ONLY messages
  // BEFORE the target message. The target's OLD answer and everything AFTER
  // it must never reach the model — otherwise it sees the task as already
  // done (lazy "anything else?" replies) or answers a LATER question
  // instead of the one being regenerated.
  let history: Array<{ role: string; content: string }> = [];

  if (replaceMessageId) {
    const { data: targetMsg } = await supabase
      .from("messages")
      .select("id, role, created_at")
      .eq("id", replaceMessageId)
      .eq("chat_id", chat.id)
      .single();

    if (!targetMsg || targetMsg.role !== "assistant") {
      return NextResponse.json({ error: "Replace target message not found" }, { status: 404 });
    }

    const { data: priorMessages, error: regenHistoryError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("chat_id", chat.id)
      .neq("id", replaceMessageId) // safety: never include the old answer
      .lt("created_at", targetMsg.created_at) // only messages before it
      .order("created_at", { ascending: false })
      .limit(MAX_HISTORY);

    if (regenHistoryError) {
      console.error("[Chat Stream] Failed to load regenerate history:", regenHistoryError.message);
    }
    history = priorMessages || [];
    console.log(`[Chat Stream] Regenerate mode: ${history.length} message(s) BEFORE the target sent as context`);
  } else {
    const { data } = await supabase
      .from("messages")
      .select("role, content")
      .eq("chat_id", chat.id)
      .order("created_at", { ascending: false })
      .limit(MAX_HISTORY);
    history = data || [];
  }

  // Build context: only for agent chats
  let fileContext = "";
  let useAgentMode = false;
  let attachedFilesList: string[] = [];
  const effectiveAgentId = agentId || chat.agent_id;

  if (effectiveAgentId) {
    const { data: agent } = await supabase
      .from("agents")
      .select("id")
      .eq("id", effectiveAgentId)
      .eq("user_id", user.id)
      .single();

    if (agent) {
      useAgentMode = true;

      try {
        const { data: files } = await supabase
          .from("agent_files")
          .select("file_name")
          .eq("agent_id", effectiveAgentId)
          .order("created_at", { ascending: false });
        if (files && files.length > 0) {
          attachedFilesList = files.map((f: any) => f.file_name);
        }
      } catch (e: any) {
        console.warn("[Chat] Failed to fetch attached files list:", e?.message);
      }

      try {
        const { data: docs } = await supabase
          .from("documents")
          .select("title, parsed_content, structured_content")
          .eq("agent_id", effectiveAgentId)
          .order("created_at", { ascending: false })
          .limit(5);

        if (docs && docs.length > 0) {
          const built = buildAgentDocumentContext(docs);
          fileContext = built.context;
          console.log(
            `[Chat] Agent ${effectiveAgentId}: ${built.structuredCount} structured + ${built.rawCount} raw documents (${fileContext.length} chars)`
          );
        }
      } catch (e: any) {
        console.warn("[Chat] Failed to load document context:", e?.message);
      }

      try {
        // ✅ Image-only messages leave an empty query after stripping the
        // marker — skip RAG entirely (embedding an empty string is useless).
        const ragQuery = stripImageAttachments(msgValidation.value!);
        if (ragQuery.trim()) {
          const searchResults = await searchRelevantChunks(
            effectiveAgentId,
            ragQuery,
            8
          );

          if (searchResults.length > 0) {
            const ragContext = buildRAGContext(searchResults);
            if (ragContext) {
              fileContext +=
                (fileContext ? "\n\n---\n\n" : "") +
                "## Relevant passages (supporting raw text)\n\n" +
                ragContext;
              console.log(
                `[Chat] RAG: found ${searchResults.length} relevant chunks for agent ${effectiveAgentId}`
              );
            }
          }
        }
      } catch (e: any) {
        console.warn("[Chat] RAG search failed:", e?.message);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // SKILL DISCOVERY: query active skills from agent_skills table
  // ────────────────────────────────────────────────────────────────
  console.log("=".repeat(60));
  console.log("[Chat Stream V2] SKILL DISCOVERY starting");
  console.log("[Chat Stream V2] user:", user.id, "| agentId:", agentId || "(general)");
  console.log("=".repeat(60));

  let activeSkills: Array<{
    id: string;
    name: string;
    display_name: string;
    description: string;
    required_tools: string[];
    priority: number;
  }> = [];
  let availableTools: string[] = [];

  try {
    const { data: skillsData, error: skillsError } = await supabase
      .from("agent_skills")
      .select("id, name, display_name, description, required_tools, priority")
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .order("name", { ascending: true });

    if (skillsError) {
      console.error("[Chat Stream V2] ❌ Skills query error:", skillsError.message);
    } else if (skillsData && skillsData.length > 0) {
      activeSkills = skillsData as any;
      const toolsSet = new Set<string>();
      for (const s of activeSkills) {
        if (Array.isArray(s.required_tools)) {
          for (const t of s.required_tools) {
            if (t) toolsSet.add(t);
          }
        }
      }
      availableTools = Array.from(toolsSet);
      console.log(`[Chat Stream V2] ✅ Discovered ${activeSkills.length} active skills:`);
      for (const s of activeSkills) {
        console.log(`   - ${s.name} (${s.display_name}) | tools: ${(s.required_tools || []).join(", ") || "(none)"}`);
      }
      console.log(`[Chat Stream V2] Available tools (${availableTools.length}):`, availableTools.join(", "));
    } else {
      console.warn("[Chat Stream V2] ⚠️  No active skills found in agent_skills table!");
      console.warn("[Chat Stream V2]    Check: is_active = true for your skills in Supabase");
    }
  } catch (e: any) {
    console.error("[Chat Stream V2] ❌ Skill discovery EXCEPTION:", e?.message);
  }
  console.log("=".repeat(60));

  const promptMode = useAgentMode ? "agent" : "general";
  let systemPrompt = buildSystemPrompt(promptMode);

  if (useAgentMode && attachedFilesList.length > 0) {
    systemPrompt += `\n\n## Attached Files:\n${attachedFilesList
      .map((f) => `- ${f}`)
      .join("\n")}`;
  }

  if (fileContext) {
    systemPrompt += `\n\n## Provided Context:\n${fileContext}`;
  }

  // ────────────────────────────────────────────────────────────────
  // SKILL INJECTION: tell the model what skills are available
  // (discovery only — content is lazy-loaded when the model picks a skill)
  // ────────────────────────────────────────────────────────────────
  if (activeSkills.length > 0) {
    const skillsList = activeSkills
      .map(s => `- ${s.name}: ${s.description}`)
      .join("\n");

    systemPrompt += `

## Available Skills
You have access to the following registered skills. Use them when the user's request matches one of them:

${skillsList}

### How to invoke a skill
If the user's request matches one of these skills AND you actually want to use it, output ONLY this single line at the very START of your response:
[USE_SKILL: skill_name]

The system will load the skill's full content and re-prompt you to answer using it. Do NOT explain that you are going to use the skill — just output the marker.

### When NOT to use the marker
- Do NOT output [USE_SKILL: ...] when the user merely asks "what skills do you have?" or "show me your skills" — in that case, LIST the skills as normal text (use the \`name: description\` format above) WITHOUT any [USE_SKILL: ...] markers.
- Do NOT output [USE_SKILL: ...] at the END of a response (after a file edit or summary). It only goes at the very START, and ONLY when the entire response is meant to invoke that skill.
- Do NOT output [USE_SKILL: ...] as part of a sentence (e.g. "I'll use [USE_SKILL: clean_code_architect] now") — that is invalid.

### Quick guide
| User says | You output |
|---|---|
| "what skills do you have?" | Plain text list of skills (no markers) |
| "use the clean code skill" | \`[USE_SKILL: clean_code_architect]\` at the start, nothing else |
| "edit login.html" | Normal response + [FILE_EDIT: login.html] block (no skill marker unless the skill clearly applies) |

If NO skill clearly matches, answer the user normally without any marker.`;
  }

  const chatIdFinal = chat.id;
  const titleFinal = chat.title;
  const isNewChatFinal = isNewChat;
  // ✅ Model-facing text: image attachment markers stripped (the saved user
  // message keeps the marker so the UI can render the thumbnail). An
  // image-only message strips to nothing — a short note is used for the
  // title/edit detection paths, while the vision request gets the actual
  // image (see historyMessages below).
  const msgContent = stripImageAttachments(msgValidation.value!) || "[The user sent an image]";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // ✅ Abort-tolerant: once the user presses Stop the client disconnects
      // and the controller closes — enqueue() would throw and kill the whole
      // save path. Swallow it instead so the partial content is still saved.
      const sendEvent = (event: string, data: string) => {
        if (request.signal.aborted) return;
        try {
          // SSE requires every physical line of a multi-line payload to have
          // its own `data:` field. Raw newlines here split/drop Markdown lines
          // (code fences, lists, headings) in the browser's EventSource parser.
          const dataLines = data.replace(/\r\n?/g, "\n").split("\n");
          const framedData = dataLines.map((line) => `data: ${line}`).join("\n");
          controller.enqueue(encoder.encode(`event: ${event}\n${framedData}\n\n`));
        } catch {
          // Client disconnected — keep executing so partial content is persisted.
        }
      };

      let fullContent = "";
      // Track every tool step (skill invocations, file edits, images, etc.)
      // so we can save them to the messages.tool_steps column and stream
      // them to the frontend live.
      const toolSteps: Array<{
        type: "thinking" | "skill" | "file_edit" | "new_file" | "file_delete" | "image" | "search" | "cmd";
        title: string;
        content?: string;
        duration_ms?: number;
        timestamp?: number;
      }> = [];

      const recordStep = (step: typeof toolSteps[number]) => {
        const enriched = { ...step, timestamp: Date.now() };
        toolSteps.push(enriched);
        // Emit to frontend immediately so the UI updates live
        sendEvent("tool_step", JSON.stringify(enriched));
        console.log(`[Chat Stream V2] 📌 Tool step recorded: ${step.type} - ${step.title}`);
      };

      try {
        // ── 0. Meta event FIRST: chat + user-message ids before any token.
        // The frontend stores them immediately, so even an aborted stream
        // knows which chat / user message it belongs to.
        sendEvent("meta", JSON.stringify({
          chatId: chatIdFinal,
          userMessageId: insertedUserMessageId,
        }));

        // ── 1. Send tools_available event FIRST (before any token) ──
        console.log(`[Chat Stream V2] 📤 Sending tools_available event with:`, {
          toolsCount: availableTools.length,
          skillsCount: activeSkills.length,
          tools: availableTools,
          skillNames: activeSkills.map(s => s.name)
        });
        sendEvent("tools_available", JSON.stringify({
          tools: availableTools,
          skills: activeSkills.map(s => ({ name: s.name, display_name: s.display_name }))
        }));
        console.log("[Chat Stream V2] ✅ tools_available event sent");

        const manager = getProviderManager();
        const reversedHistory = (history || []).slice().reverse();

        // ✅ Only the CURRENT (last) user message's image goes to the vision
        // model as an actual image part. Older image turns degrade to a text
        // note — otherwise every turn would re-send every past image and the
        // model would describe them all merged together (the "describes 3
        // images as one" bug).
        let lastUserIdx = -1;
        for (let i = reversedHistory.length - 1; i >= 0; i--) {
          if (reversedHistory[i].role === "user") { lastUserIdx = i; break; }
        }

        const historyMessages = reversedHistory.map((m: any, i: number) => {
          const text = stripImageAttachments(m.content);

          if (m.role === "user") {
            const imageUrl = i === lastUserIdx ? extractAttachedImageUrl(m.content) : null;
            if (imageUrl) {
              const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
              parts.push({ type: "text", text: text || "[The user sent an image]" });
              parts.push({ type: "image_url", image_url: { url: imageUrl } });
              return { role: "user" as const, content: parts };
            }
            // An OLDER image turn: keep a text note so the model knows an
            // image existed, without re-sending the image itself.
            if (extractAttachedImageUrl(m.content)) {
              return {
                role: "user" as const,
                content: text || "[An image was shared earlier in this conversation]",
              };
            }
          }

          return { role: m.role as "user" | "assistant", content: text };
        });

        // ── 2. Stream the first response with [USE_SKILL: xxx] detection ──
        const streamGen = manager.streamChatCompletion({
          messages: [
            { role: "system", content: systemPrompt },
            ...historyMessages,
          ],
        });

        let streamResult: { provider: string } | undefined;
        let pendingBuffer = "";
        let skillMarkerDetected = false;
        let detectedSkillName = "";
        const MARKER_BUFFER_SIZE = 25; // enough to detect "[USE_SKILL: skill_name]"

        while (true) {
          if (request.signal.aborted) break; // ✅ Stop pressed — stop consuming the model
          const result = await streamGen.next();
          if (result.done) {
            streamResult = result.value as { provider: string } | undefined;
            break;
          }

          if (skillMarkerDetected) {
            // We're in skill mode — accumulate but don't stream (we'll re-prompt)
            pendingBuffer += result.value;
            continue;
          }

          pendingBuffer += result.value;

          // Check if buffer matches the marker pattern at the start
          const match = pendingBuffer.match(SKILL_MARKER_PATTERN);
          if (match) {
            skillMarkerDetected = true;
            detectedSkillName = match[1];
            pendingBuffer = ""; // discard the marker
            console.log(`[Chat Stream] Skill marker detected: ${detectedSkillName}`);
            continue;
          }

          // If buffer is long enough that the marker can't fit, flush it
          if (pendingBuffer.length >= MARKER_BUFFER_SIZE) {
            sendEvent("token", pendingBuffer);
            fullContent += pendingBuffer;
            pendingBuffer = "";
          }
        }

        // Flush any remaining buffer (only if no marker was detected)
        if (!skillMarkerDetected && pendingBuffer) {
          sendEvent("token", pendingBuffer);
          fullContent += pendingBuffer;
        }

        // ── 3. If skill was detected, lazy-load + re-prompt ──
        if (skillMarkerDetected && detectedSkillName && !request.signal.aborted) {
          const skillMeta = activeSkills.find(s => s.name === detectedSkillName);

          if (skillMeta) {
            // Record the skill invocation step (for live UI + DB save)
            const skillStartTime = Date.now();
            recordStep({
              type: "skill",
              title: `Invoking skill: ${skillMeta.display_name || skillMeta.name}`,
            });

            // Lazy-load skill resources (content only)
            let skillContent = "";
            try {
              const { data: resources, error: resError } = await supabase
                .from("skill_resources")
                .select("content, filename, is_primary, sort_order")
                .eq("skill_id", skillMeta.id)
                .order("sort_order", { ascending: true });

              if (resError) {
                console.warn(`[Chat Stream] Failed to load skill resources:`, resError.message);
              } else if (resources && resources.length > 0) {
                skillContent = resources
                  .filter(r => r.content)
                  .map(r => r.content)
                  .join("\n\n---\n\n");
                console.log(
                  `[Chat Stream] Loaded skill "${detectedSkillName}": ${skillContent.length} chars from ${resources.length} resources`
                );
              } else {
                console.warn(`[Chat Stream] Skill "${detectedSkillName}" has no resources`);
              }
            } catch (e: any) {
              console.warn(`[Chat Stream] Skill load error:`, e?.message);
            }

            // Update the last skill step with content
            const lastStep = toolSteps[toolSteps.length - 1];
            if (lastStep && lastStep.type === "skill") {
              lastStep.content = skillContent || `(Skill "${detectedSkillName}" — no additional content)`;
              lastStep.duration_ms = Date.now() - skillStartTime;
              // Re-emit with the updated content
              sendEvent("tool_step", JSON.stringify(lastStep));
            }

            // Send clear event to reset the frontend display
            sendEvent("clear", "");
            fullContent = "";

            // Re-prompt with skill content injected
            const skillEnhancedPrompt = systemPrompt + `

## Active Skill: ${skillMeta.display_name || skillMeta.name}
${skillMeta.description}

### Skill Content / Instructions:
${skillContent || "(No additional content for this skill — use the description above.)"}`;

            const streamGen2 = manager.streamChatCompletion({
              messages: [
                { role: "system", content: skillEnhancedPrompt },
                ...historyMessages,
              ],
            });

            let streamResult2: { provider: string } | undefined;
            while (true) {
              if (request.signal.aborted) break;
              const result = await streamGen2.next();
              if (result.done) {
                streamResult2 = result.value as { provider: string } | undefined;
                break;
              }
              fullContent += result.value;
              sendEvent("token", result.value);
            }

            // Use the second provider if it was different
            if (streamResult2?.provider) {
              streamResult = streamResult2;
            }

            // Log skill usage to skill_usage_logs
            try {
              await supabase.from("skill_usage_logs").insert({
                skill_id: skillMeta.id,
                conversation_id: chatIdFinal,
                tokens_used: Math.ceil(fullContent.length / 4),
                latency_ms: Date.now() - skillStartTime,
                success: true,
                error_message: null,
              });
            } catch (e: any) {
              console.warn(`[Chat Stream] Failed to log skill usage:`, e?.message);
            }
          } else {
            console.warn(`[Chat Stream] Skill "${detectedSkillName}" not found in active skills`);
            recordStep({
              type: "skill",
              title: `Skill "${detectedSkillName}" not available`,
              content: "Answering from general knowledge.",
            });
            sendEvent("token", `(Skill "${detectedSkillName}" was requested but is not available. Answering from general knowledge.)\n\n`);
            fullContent += `(Skill "${detectedSkillName}" was requested but is not available. Answering from general knowledge.)\n\n`;
          }
        }

        // Send provider info event
        if (streamResult?.provider) {
          sendEvent("provider", streamResult.provider);
        }

        // ── 4. FILE_EDIT recovery ──
        // A marker alone is not proof of a usable edit. Models often emit a
        // partial/malformed block; recover those just like a missing block.
        let fileEditRecoveryFailed = false;
        const hasFileEditMarker = /\[FILE_EDIT:/i.test(fullContent);
        // The user's wording classifier can miss an edit request. A generated
        // FILE_EDIT marker is stronger evidence that the model attempted an
        // edit, so malformed blocks must still enter the repair path.
        const isEditIntent = Boolean(
          effectiveAgentId &&
          (isEditRequest(msgContent, fileContext) || hasFileEditMarker)
        );
        const hasValidFileEdit = () =>
          extractFileEditBlocks(normalizeFileBlocks(fullContent)).length > 0;
        if (
          isEditIntent &&
          !request.signal.aborted &&
          !fullContent.includes("[GENERATE_IMAGE:") &&
          !hasValidFileEdit()
        ) {
          console.warn("[Chat Stream] FILE_EDIT_RECOVERY_V2: malformed or missing edit block; starting up to 2 repair attempts");
          recordStep({
            type: "file_edit",
            title: "Editing file...",
          });

          const rawFiles = fileContext.split(/\n\n---\n\n/).map(block => {
            const lines = block.split("\n");
            const header = lines[0] || "";
            const fname = header.replace(/^### Document:\s*/, "").trim();
            const content = lines.slice(1).join("\n").trim();
            return { filename: fname, content };
          });

          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const fileInstruction = rawFiles.map(f =>
                `FILE: ${f.filename}\nCONTENT:\n${f.content.slice(0, 30_000)}`
              ).join("\n\n---\n\n");

              const followUpResult = await manager.chatCompletion({
                messages: [
                  { role: "system", content: systemPrompt + "\n\n" + EDIT_FOLLOWUP_PROMPT },
                  { role: "user", content: `The user asked: "${msgContent}"\n\nHere is the file you must edit:\n\n${fileInstruction}\n\nNow output the FILE_EDIT block.` },
                ],
                maxTokens: 4096,
              });

              const repairedContent = normalizeFileBlocks(followUpResult.content);
              if (extractFileEditBlocks(repairedContent).length > 0) {
                fullContent += "\n\n" + followUpResult.content;
                sendEvent("token", "\n\n" + followUpResult.content);

                // Update the step with content
                const lastEditStep = [...toolSteps].reverse().find(s => s.type === "file_edit");
                if (lastEditStep) {
                  lastEditStep.content = followUpResult.content;
                  sendEvent("tool_step", JSON.stringify(lastEditStep));
                }
                break;
              }
              console.warn(`[Chat Stream] Follow-up attempt ${attempt + 1} returned an invalid FILE_EDIT block`);
            } catch (e) {
              console.error(`[Chat Stream] Follow-up attempt ${attempt + 1} failed:`, e);
            }
          }
          if (!hasValidFileEdit()) {
            fileEditRecoveryFailed = true;
            const lastEditStep = [...toolSteps].reverse().find(s => s.type === "file_edit");
            if (lastEditStep) {
              lastEditStep.title = "Could not safely edit file";
              lastEditStep.content = "The model returned an invalid FILE_EDIT block after two repair attempts. No edit was applied.";
              sendEvent("tool_step", JSON.stringify(lastEditStep));
            }
          }
        }

        // ── 5. GENERATE_IMAGE handling (unchanged) ──
        const imagePrompts = effectiveAgentId
          ? [...fullContent.matchAll(/\[GENERATE_IMAGE:\s*(.+?)\]/g)].map(m => m[1].trim())
          : [];
        const imageResults: { url: string; prompt: string }[] = [];

        if (imagePrompts.length > 0 && !request.signal.aborted) {
          for (const prompt of imagePrompts) {
            recordStep({
              type: "image",
              title: `Generating image: ${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}`,
            });
          }

          const results = await Promise.allSettled(
            imagePrompts.map(async (prompt) => {
              const result = await generateImage(prompt);
              return { url: result.url, prompt };
            })
          );

          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === "fulfilled") {
              imageResults.push(r.value);
              sendEvent("image", JSON.stringify(r.value));

              // Update the matching image step with the URL
              const imgStep = toolSteps.find(
                (s, idx) => s.type === "image" && idx >= toolSteps.length - results.length + i
              );
              if (imgStep && !imgStep.content) {
                imgStep.content = r.value.url;
                sendEvent("tool_step", JSON.stringify(imgStep));
              }
            } else {
              console.error("[Chat Stream] Image generation failed:", r.reason);
            }
          }

          for (const img of imageResults) {
            fullContent = fullContent.replace(
              `[GENERATE_IMAGE: ${img.prompt}]`,
              `\n\n![${img.prompt}](${img.url})\n`
            );
          }
        }

        // ── 6. Normalize file blocks + Save assistant message (with tool_steps) ──
        // Fix any [NEW_FILE: ...] or [FILE_EDIT: ...] blocks the model forgot to
        // wrap in ``` fences. Without this, raw HTML/JS/CSS gets eaten by the
        // markdown renderer and the user sees a blank message.
        const originalContent = fullContent;
        fullContent = normalizeFileBlocks(fullContent);
        if (fullContent !== originalContent) {
          // Emit the normalized version so the live streaming UI updates
          // (replace the previously-streamed content with the fixed version)
          sendEvent("replace_content", fullContent);
          console.log("[Chat Stream V2] 🔧 Normalized file blocks (added missing ``` fences)");
        }

        // ── 6.5. Extract & save any [NEW_FILE: xxx] blocks via the shared
        // saveAgentFileInternal helper (same path the edit endpoint uses).
        // This makes AI-generated files appear in the agent's file list
        // (sidebar) with the same shape as user-uploaded files, so the
        // view/edit/delete/download buttons all work.
        if (effectiveAgentId) {
          const newFileBlocks = extractNewFileBlocks(fullContent);
          if (newFileBlocks.length > 0) {
            console.log(`[Chat Stream V2] 📁 Found ${newFileBlocks.length} NEW_FILE block(s), saving via saveAgentFileInternal...`);
            for (const block of newFileBlocks) {
              const fileStartTime = Date.now();
              // Record a tool step for the file creation (live UI + DB save)
              recordStep({
                type: "new_file",
                title: `Created file: ${block.filename}`,
              });

              try {
                const result = await saveAgentFileInternal(
                  effectiveAgentId,
                  block.filename,
                  block.content
                );

                // Update the tool step with content + duration + result
                const lastNewFileStep = [...toolSteps].reverse().find(s => s.type === "new_file");
                if (lastNewFileStep) {
                  lastNewFileStep.content = block.content;
                  lastNewFileStep.duration_ms = Date.now() - fileStartTime;
                  if (!result.success) {
                    lastNewFileStep.title = `Failed to save file: ${block.filename}`;
                    lastNewFileStep.content = `Error: ${result.error}\n\nFile content:\n${block.content}`;
                  } else if (result.created) {
                    lastNewFileStep.title = `Created file: ${block.filename}`;
                  } else {
                    lastNewFileStep.title = `Updated file: ${block.filename}`;
                  }
                  sendEvent("tool_step", JSON.stringify(lastNewFileStep));
                }
              } catch (e: any) {
                console.warn(`[Chat Stream V2] Failed to save generated file ${block.filename}:`, e?.message);
                const lastNewFileStep = [...toolSteps].reverse().find(s => s.type === "new_file");
                if (lastNewFileStep) {
                  lastNewFileStep.title = `Failed to save file: ${block.filename}`;
                  lastNewFileStep.content = `Error: ${e?.message || "Unknown error"}\n\nFile content:\n${block.content}`;
                  lastNewFileStep.duration_ms = Date.now() - fileStartTime;
                  sendEvent("tool_step", JSON.stringify(lastNewFileStep));
                }
              }
            }
          }

          // ── 6.6. Extract & apply any [FILE_EDIT: xxx] blocks via the shared
          // applyFileEditInternal helper. This applies the diff to the
          // existing file (replaces ORIGINAL section with new code), or
          // creates the file if it doesn't exist, or replaces the whole
          // content if ORIGINAL isn't found.
          const fileEditBlocks = extractFileEditBlocks(fullContent);
          if (fileEditBlocks.length > 0) {
            console.log(`[Chat Stream V2] ✏️  Found ${fileEditBlocks.length} FILE_EDIT block(s), applying via applyFileEditInternal...`);
            for (const block of fileEditBlocks) {
              const editStartTime = Date.now();
              // Record a tool step for the file edit (live UI)
              // NOTE: We emit this with placeholder content first; we re-emit
              // with the actual diff content AFTER the apply completes so
              // the user sees the real diff, not "(No additional content)".
              recordStep({
                type: "file_edit",
                title: `Editing file: ${block.filename}`,
                content: `Original:\n${block.originalCode.slice(0, 1500)}${block.originalCode.length > 1500 ? "..." : ""}\n\nNew:\n${block.newCode.slice(0, 1500)}${block.newCode.length > 1500 ? "..." : ""}`,
              });

              try {
                const result = await applyFileEditInternal(
                  effectiveAgentId,
                  block.filename,
                  block.originalCode,
                  block.newCode
                );

                // Update the tool step with duration + result title
                const lastEditStep = [...toolSteps].reverse().find(s => s.type === "file_edit");
                if (lastEditStep) {
                  lastEditStep.duration_ms = Date.now() - editStartTime;
                  if (!result.success) {
                    lastEditStep.title = `Failed to edit file: ${block.filename}`;
                    lastEditStep.content = `Error: ${result.error}\n\nOriginal:\n${block.originalCode.slice(0, 800)}\n\nNew:\n${block.newCode.slice(0, 800)}`;
                  } else if (result.created) {
                    lastEditStep.title = `Created file: ${block.filename}`;
                  } else if (result.fallback) {
                    lastEditStep.title = `Updated ${block.filename} (full replace — original not found)`;
                  } else {
                    lastEditStep.title = `Edited file: ${block.filename}`;
                  }
                  // Re-emit so the live UI updates with the final title
                  sendEvent("tool_step", JSON.stringify(lastEditStep));
                }
              } catch (e: any) {
                console.warn(`[Chat Stream V2] Failed to apply edit to ${block.filename}:`, e?.message);
                const lastEditStep = [...toolSteps].reverse().find(s => s.type === "file_edit");
                if (lastEditStep) {
                  lastEditStep.title = `Failed to edit file: ${block.filename}`;
                  lastEditStep.content = `Error: ${e?.message || "Unknown error"}\n\nOriginal:\n${block.originalCode.slice(0, 500)}\n\nNew:\n${block.newCode.slice(0, 500)}`;
                  lastEditStep.duration_ms = Date.now() - editStartTime;
                  sendEvent("tool_step", JSON.stringify(lastEditStep));
                }
              }
            }
          }

          // ── 6.6.5. Handle [DELETE_FILE: xxx] markers: ACTUALLY remove the
          // file (agent_files row + its documents row + files_count) instead
          // of letting the model "fake delete" it by writing HTML comments.
          const deleteFileMatches = [...fullContent.matchAll(/\[DELETE_FILE:[ \t]*([^\]\n]+)\]/g)];
          if (deleteFileMatches.length > 0) {
            console.log(`[Chat Stream V2] 🗑️ Found ${deleteFileMatches.length} DELETE_FILE marker(s)`);
            for (const markerMatch of deleteFileMatches) {
              const filename = markerMatch[1].trim();
              const delStartTime = Date.now();
              recordStep({ type: "file_delete", title: `Deleted file: ${filename}` });
              try {
                const { data: fileRow } = await supabase
                  .from("agent_files")
                  .select("id")
                  .eq("agent_id", effectiveAgentId)
                  .eq("file_name", filename)
                  .limit(1)
                  .single();

                if (fileRow) {
                  await supabase
                    .from("documents")
                    .delete()
                    .eq("source_file_id", fileRow.id)
                    .eq("agent_id", effectiveAgentId);
                  await supabase.from("agent_files").delete().eq("id", fileRow.id);
                  const { data: agentRow } = await supabase
                    .from("agents")
                    .select("files_count")
                    .eq("id", effectiveAgentId)
                    .single();
                  if (agentRow) {
                    await supabase
                      .from("agents")
                      .update({ files_count: Math.max(0, (agentRow.files_count || 1) - 1) })
                      .eq("id", effectiveAgentId);
                  }
                  console.log(`[Chat Stream V2] 🗑️ Deleted "${filename}" from agent ${effectiveAgentId}`);
                } else {
                  // No agent_files row — still remove a matching document by title.
                  await supabase
                    .from("documents")
                    .delete()
                    .eq("agent_id", effectiveAgentId)
                    .eq("title", filename);
                  console.warn(`[Chat Stream V2] ⚠️ No agent_files row for "${filename}" — removed document by title (if any)`);
                }

                const lastDeleteStep = [...toolSteps].reverse().find(s => s.type === "file_delete");
                if (lastDeleteStep) {
                  lastDeleteStep.duration_ms = Date.now() - delStartTime;
                  sendEvent("tool_step", JSON.stringify(lastDeleteStep));
                }
              } catch (e: any) {
                console.warn(`[Chat Stream V2] Failed to delete ${filename}:`, e?.message);
                const lastDeleteStep = [...toolSteps].reverse().find(s => s.type === "file_delete");
                if (lastDeleteStep) {
                  lastDeleteStep.title = `Failed to delete file: ${filename}`;
                  lastDeleteStep.content = `Error: ${e?.message || "Unknown error"}`;
                  lastDeleteStep.duration_ms = Date.now() - delStartTime;
                  sendEvent("tool_step", JSON.stringify(lastDeleteStep));
                }
              }
            }
          }
        }

        // ── 6.7. Strip file blocks + USE_SKILL markers from the saved content ──
        // The file edit info is captured in tool_steps (the "Edited file:"
        // collapsible above the message). We don't want the raw [FILE_EDIT: ...]
        // diff text in the displayed/saved message — it's noisy and gets
        // copied when the user presses Copy. After stripping, only the
        // user-facing summary (e.g. "Updated login.html with cleaner CSS...")
        // remains in the message content.
        const beforeStrip = fullContent;
        fullContent = stripFileBlocks(fullContent);
        if (fullContent !== beforeStrip) {
          // Send the stripped version to the frontend so the live UI updates
          // (replaces the streamed FILE_EDIT block with just the summary)
          sendEvent("replace_content", fullContent);
          console.log("[Chat Stream V2] 🧹 Stripped file blocks + USE_SKILL markers from content");
        }

        if (fileEditRecoveryFailed) {
          fullContent = /[\u0600-\u06FF]/.test(msgContent)
            ? "لم أستطع تعديل الملف بأمان لأن تنسيق التعديل الذي أرسله النموذج كان غير مكتمل. لم يتم تطبيق أي تغيير؛ اضغط «إعادة التوليد» للمحاولة مرة أخرى."
            : "I couldn't safely apply this edit because the model returned an incomplete edit block. No changes were applied. Use Regenerate to try again.";
          sendEvent("replace_content", fullContent);
        }

        // ── 6.7.1. If content is empty after stripping (model only emitted
        // FILE_EDIT/NEW_FILE block + USE_SKILL marker with no summary),
        // inject a generic confirmation so the user doesn't see a blank reply.
        if (!fullContent.trim() && toolSteps.length > 0) {
          const lastStep = toolSteps[toolSteps.length - 1];
          if (lastStep.type === "file_edit" || lastStep.type === "new_file") {
            const filename = lastStep.title.includes(":")
              ? lastStep.title.split(":")[1].trim()
              : "the file";
            fullContent = `Done. \`${filename}\` has been updated.`;
            sendEvent("replace_content", fullContent);
            console.log("[Chat Stream V2] ✏️  Content was empty after strip — injected default confirmation");
          } else if (lastStep.type === "skill") {
            fullContent = `Done. Used skill \`${lastStep.title.replace(/^.*skill:\s*/, "")}\`.`;
            sendEvent("replace_content", fullContent);
            console.log("[Chat Stream V2] ✏️  Content was empty after strip — injected skill confirmation");
          }
        }

        // ── 7. Save assistant message (with tool_steps) ──
        // ✅ Regenerate mode: if replaceMessageId is set, UPDATE the existing
        // message row instead of inserting a new one. This prevents duplicate
        // messages in the DB (and on chat-history reload).
        let insertedAssistantMessageId: string | null = null;
        const messageData = {
          content: fullContent,
          tool_steps: toolSteps.length > 0 ? toolSteps : null,
        };

        // ✅ Empty-content guard: an aborted (or failed) generation that
        // produced NO visible text must never be persisted — an empty
        // assistant row is exactly what later shows up as a blank message
        // bubble after a reload (the reported "empty message" bug).
        const saveAssistantMessage = Boolean(fullContent.trim()) || toolSteps.length > 0;
        if (!saveAssistantMessage) {
          console.log("[Chat Stream V2] ⏭️ Skipping assistant message save — empty content (stopped/failed generation)");
        }

        if (replaceMessageId && saveAssistantMessage) {
          // Regenerate: update the existing assistant message
          const { data: updatedMessage, error: updateError } = await supabase.from("messages")
            .update(messageData)
            .eq("id", replaceMessageId)
            .eq("role", "assistant") // safety: only update assistant rows
            .select("id")
            .maybeSingle();

          if (updateError || !updatedMessage) {
            if (!updateError) {
              console.warn(`[Chat Stream] Regenerate target ${replaceMessageId} no longer exists; inserting a replacement message`);
            } else {
              console.error("[Chat Stream] Failed to UPDATE assistant message (regenerate):", updateError.message);
            }
            // Fallback: try inserting a new message instead of failing
            const { data: insertedMsg, error: insertError } = await supabase.from("messages").insert({
              chat_id: chatIdFinal,
              role: "assistant",
              ...messageData,
            }).select("id").single();
            if (insertError) {
              console.error("[Chat Stream] ❌ Fallback insert ALSO failed:", insertError.message);
              sendEvent("error", "Failed to save message: " + insertError.message);
            } else {
              insertedAssistantMessageId = insertedMsg?.id ?? null;
              console.warn("[Chat Stream] ⚠️  Fallback: inserted new message (update failed)");
            }
          } else {
            insertedAssistantMessageId = updatedMessage.id;
            console.log(`[Chat Stream] ✅ Updated existing assistant message (regenerate): ${replaceMessageId}`);
          }
        } else if (saveAssistantMessage) {
          // Normal flow: try with tool_steps first, fall back to without if column missing
          const { data: insertedMsg, error: msgErrorWithSteps } = await supabase.from("messages").insert({
            chat_id: chatIdFinal,
            role: "assistant",
            content: fullContent,
            tool_steps: toolSteps.length > 0 ? toolSteps : null,
          }).select("id").single();
          if (!msgErrorWithSteps && insertedMsg) insertedAssistantMessageId = insertedMsg.id;

          if (msgErrorWithSteps) {
            console.error("[Chat Stream] Insert with tool_steps failed:", msgErrorWithSteps.message);

            const isColumnError =
              msgErrorWithSteps.message.includes("tool_steps") ||
              msgErrorWithSteps.message.includes("column") ||
              msgErrorWithSteps.message.includes("Could not find the column") ||
              msgErrorWithSteps.code === "PGRST2043" ||
              msgErrorWithSteps.code === "42703";

            if (isColumnError || toolSteps.length === 0) {
              const { data: retriedMsg, error: msgErrorWithoutSteps } = await supabase.from("messages").insert({
                chat_id: chatIdFinal,
                role: "assistant",
                content: fullContent,
              }).select("id").single();
              if (!msgErrorWithoutSteps && retriedMsg) insertedAssistantMessageId = retriedMsg.id;

              if (msgErrorWithoutSteps) {
                console.error("[Chat Stream] ❌ Retry without tool_steps ALSO failed:", msgErrorWithoutSteps.message);
                sendEvent("error", "Failed to save message to database: " + msgErrorWithoutSteps.message);
              } else {
                console.warn("[Chat Stream] ⚠️  Saved WITHOUT tool_steps. Run this migration to enable tool_steps:");
                console.warn("    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_steps JSONB DEFAULT NULL;");
              }
            } else {
              console.error("[Chat Stream] ❌ Failed to save assistant message:", msgErrorWithSteps.message);
              sendEvent("error", "Failed to save message: " + msgErrorWithSteps.message);
            }
          } else {
            if (toolSteps.length > 0) {
              console.log(`[Chat Stream] ✅ Saved assistant message with ${toolSteps.length} tool step(s)`);
            }
          }
        }

        // Update chat timestamp
        await supabase
          .from("chats")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", chatIdFinal);

        // Generate title for new chats
        let title = titleFinal;
        if (isNewChatFinal && !title) {
          title = msgContent.slice(0, 80).replace(/\n+/g, " ");
          await supabase.from("chats").update({ title }).eq("id", chatIdFinal);
        }

        // ✅ Real-ids fix: return the real DB ids so the frontend replaces
        // its temporary ids (assistant-<timestamp>) — required for the
        // regenerate feature to work on messages created in this session.
        sendEvent("done", JSON.stringify({
          chatId: chatIdFinal,
          title,
          provider: streamResult?.provider || null,
          userMessageId: insertedUserMessageId,
          assistantMessageId: insertedAssistantMessageId,
        }));
      } catch (err: any) {
        console.error("[Chat Stream] Error:", err);
        sendEvent("error", err?.message || "Stream failed");
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed (client disconnect) — nothing to do.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
