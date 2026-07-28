import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId");

  const supabase = createAdminClient();

  let query = supabase
    .from("chats")
    .select("id, title, agent_id, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (agentId) {
    query = query.eq("agent_id", agentId);
  } else {
    query = query.is("agent_id", null);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: "Failed to fetch chats" }, { status: 500 });
  }

  return NextResponse.json(data || []);
}
