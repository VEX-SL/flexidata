import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { validateMessage, isValidUUID } from "@/lib/validators";
import { getProviderManager } from "@/lib/ai/manager";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { buildAgentDocumentContext } from "@/lib/agent/document-context";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_HISTORY = 20;

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

  // Get chat history (most recent MAX_HISTORY messages, in chronological order)
  const { data: history } = await supabase
    .from("messages")
    .select("role, content")
    .eq("chat_id", chat.id)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY);

  // Build context: only for agent chats
  let fileContext = "";
  let useAgentMode = false;
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
      } else {
        console.log(`[Chat] Agent ${effectiveAgentId}: no documents found`);
      }
    }
  }

  const promptMode = useAgentMode ? "agent" : "general";
  const systemPrompt =
    buildSystemPrompt(promptMode) +
    (fileContext
      ? `\n\n## Provided Context:\n${fileContext}`
      : "");

  // Send to AI
  let aiResponse: { content: string; model: string };
  try {
    const manager = getProviderManager();
    const historyMessages = (history || []).slice().reverse().map((m: any) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    const result = await manager.chatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        ...historyMessages,
      ],
    });
    aiResponse = { content: result.content, model: result.model || "unknown" };
  } catch (err) {
    console.error("[Chat] AI error:", err);
    return NextResponse.json(
      { error: "AI service temporarily unavailable." },
      { status: 503 }
    );
  }

  // Save assistant message
  await supabase.from("messages").insert({
    chat_id: chat.id,
    role: "assistant",
    content: aiResponse.content,
  });

  // Update chat timestamp
  await supabase
    .from("chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", chat.id);

  // Generate title for new chats from message content (no extra AI call)
  let title = chat.title;
  if (isNewChat && !title) {
    title = msgValidation.value!.slice(0, 80).replace(/\n+/g, " ");
    await supabase.from("chats").update({ title }).eq("id", chat.id);
  }

  return NextResponse.json({
    message: aiResponse.content,
    chatId: chat.id,
    title,
  });
}
