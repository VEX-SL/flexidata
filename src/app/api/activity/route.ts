import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const supabase = createAdminClient();

  const { data: agents, error } = await supabase
    .from("agents")
    .select("id, name")
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch activity" }, { status: 500 });
  }

  if (!agents || agents.length === 0) {
    return NextResponse.json([]);
  }

  const agentIds = agents.map((a) => a.id);
  const agentNames: Record<string, string> = {};
  for (const a of agents) agentNames[a.id] = a.name;

  const [filesRes, chatsRes] = await Promise.all([
    supabase
      .from("agent_files")
      .select("id, file_name, status, agent_id, created_at")
      .in("agent_id", agentIds)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("chats")
      .select("id, title, agent_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  type ActivityItem = {
    type: "upload" | "chat";
    text: string;
    agent: string | null;
    status?: string;
    created_at: string;
  };

  const items: ActivityItem[] = [];

  for (const f of filesRes.data || []) {
    items.push({
      type: "upload",
      text: f.file_name,
      agent: f.agent_id ? agentNames[f.agent_id] ?? null : null,
      status: f.status,
      created_at: f.created_at,
    });
  }

  for (const c of chatsRes.data || []) {
    items.push({
      type: "chat",
      text: c.title || "",
      agent: c.agent_id ? agentNames[c.agent_id] ?? null : null,
      created_at: c.created_at,
    });
  }

  items.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return NextResponse.json(items.slice(0, 10));
}
