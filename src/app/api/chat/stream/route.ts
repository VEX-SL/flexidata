import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { validateMessage, isValidUUID } from "@/lib/validators";
import { getProviderManager } from "@/lib/ai/manager";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { createAdminClient } from "@/lib/supabase/admin";
import { searchRelevantChunks, buildRAGContext } from "@/lib/rag/search";
import { generateImage } from "@/lib/ai/image-generation";

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

function isEditRequest(msg: string, fileContext: string): boolean {
  if (!fileContext) return false;
  const lower = msg.toLowerCase();
  return EDIT_KEYWORDS_AR.some((k) => lower.includes(k)) ||
    EDIT_KEYWORDS_EN.some((k) => lower.includes(k));
}

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

  const { chatId, content, agentId } = body as {
    chatId?: string;
    content: string;
    agentId?: string;
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

  // Save user message
  await supabase.from("messages").insert({
    chat_id: chat.id,
    role: "user",
    content: msgValidation.value!,
  });

  // Get chat history
  const { data: history } = await supabase
    .from("messages")
    .select("role, content")
    .eq("chat_id", chat.id)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY);

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

      // Always inject the full list of attached files so the agent knows
      // which files exist — even when RAG retrieval returns no matches.
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

      // Try RAG semantic search first
      try {
        const searchResults = await searchRelevantChunks(
          effectiveAgentId,
          msgValidation.value!,
          8
        );

        if (searchResults.length > 0) {
          fileContext = buildRAGContext(searchResults);
          console.log(
            `[Chat] RAG: found ${searchResults.length} relevant chunks for agent ${effectiveAgentId}`
          );
        }
      } catch (e: any) {
        console.warn("[Chat] RAG search failed, falling back to full text:", e?.message);
      }

      // Fallback: if no RAG results, load full documents (for pre-RAG uploads)
      if (!fileContext) {
        const { data: docs } = await supabase
          .from("documents")
          .select("title, parsed_content")
          .eq("agent_id", effectiveAgentId)
          .order("created_at", { ascending: false })
          .limit(5);

        if (docs && docs.length > 0) {
          fileContext = docs
            .map(
              (d) =>
                `### ${d.title}\n${d.parsed_content?.slice(0, 30_000) || ""}`
            )
            .join("\n\n---\n\n");
          console.log(
            `[Chat] Fallback: loaded ${docs.length} full documents (${fileContext.length} chars)`
          );
        }
      }
    }
  }

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

  const chatIdFinal = chat.id;
  const titleFinal = chat.title;
  const isNewChatFinal = isNewChat;
  const msgContent = msgValidation.value!;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      let fullContent = "";

      try {
        const manager = getProviderManager();
        const streamGen = manager.streamChatCompletion({
          messages: [
            { role: "system", content: systemPrompt },
            ...(history || []).map((m: any) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
          ],
        });

        for await (const chunk of streamGen) {
          fullContent += chunk;
          sendEvent("token", chunk);
        }

        if (effectiveAgentId && !fullContent.includes("[FILE_EDIT:") && !fullContent.includes("[GENERATE_IMAGE:") && isEditRequest(msgContent, fileContext)) {
          // Extract raw file contents for the follow-up
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

              if (followUpResult.content.includes("[FILE_EDIT:") && followUpResult.content.includes("<<<<<<< ORIGINAL")) {
                fullContent += "\n\n" + followUpResult.content;
                sendEvent("token", "\n\n" + followUpResult.content);
                break;
              }
            } catch (e) {
              console.error(`[Chat Stream] Follow-up attempt ${attempt + 1} failed:`, e);
            }
          }
        }

        // Generate images if AI requested them (agent chats only)
        const imagePrompts = effectiveAgentId
          ? [...fullContent.matchAll(/\[GENERATE_IMAGE:\s*(.+?)\]/g)].map(m => m[1].trim())
          : [];
        const imageResults: { url: string; prompt: string }[] = [];

        if (imagePrompts.length > 0) {
          const results = await Promise.allSettled(
            imagePrompts.map(async (prompt) => {
              const result = await generateImage(prompt);
              return { url: result.url, prompt };
            })
          );

          for (const r of results) {
            if (r.status === "fulfilled") {
              imageResults.push(r.value);
              sendEvent("image", JSON.stringify(r.value));
            } else {
              console.error("[Chat Stream] Image generation failed:", r.reason);
            }
          }

          // Replace [GENERATE_IMAGE: ...] blocks in saved content with markdown images
          for (const img of imageResults) {
            fullContent = fullContent.replace(
              `[GENERATE_IMAGE: ${img.prompt}]`,
              `\n\n![${img.prompt}](${img.url})\n`
            );
          }
        }

        await supabase.from("messages").insert({
          chat_id: chatIdFinal,
          role: "assistant",
          content: fullContent,
        });

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

        sendEvent("done", JSON.stringify({ chatId: chatIdFinal, title }));
      } catch (err: any) {
        console.error("[Chat Stream] Error:", err);
        sendEvent("error", err?.message || "Stream failed");
      } finally {
        controller.close();
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
