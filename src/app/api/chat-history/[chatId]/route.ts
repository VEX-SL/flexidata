import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { chatId } = await params;

  if (!isValidUUID(chatId)) {
    return NextResponse.json({ error: "Invalid chat ID" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId");
  const scope = searchParams.get("scope");

  const supabase = createAdminClient();

  const { data: chat } = await supabase
    .from("chats")
    .select("id, agent_id")
    .eq("id", chatId)
    .eq("user_id", user.id)
    .single();

  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  // Strict scope: /chat only sees general chats; an agent page only sees
  // chats that belong to that exact agent.
  if (agentId && chat.agent_id !== agentId) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }
  if (scope === "general" && chat.agent_id) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  const { data: messages, error } = await supabase
    .from("messages")
    .select("id, role, content, tool_steps, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch messages" }, { status: 500 });
  }

  return NextResponse.json(messages || []);
}
