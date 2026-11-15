// /src/app/api/browser/settings/route.ts
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/validators";

export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;
  const supabase = createAdminClient();

  const { data: agents, error: agentsError } = await supabase
    .from("agents")
    .select("id, name, description")
    .eq("user_id", user.id);
  if (agentsError) {
    return NextResponse.json({ error: "Failed to fetch agents" }, { status: 500 });
  }

  const agentIds = (agents ?? []).map((agent) => agent.id);
  const settingsByAgent: Record<string, { enabled: boolean; enabled_at: string | null }> = {};
  if (agentIds.length > 0) {
    const { data: rows, error: settingsError } = await supabase
      .from("agent_browser_settings")
      .select("agent_id, enabled, enabled_at")
      .eq("user_id", user.id)
      .in("agent_id", agentIds);
    if (settingsError) {
      return NextResponse.json({ error: "Failed to fetch browser settings" }, { status: 500 });
    }
    for (const row of rows ?? []) {
      settingsByAgent[row.agent_id] = { enabled: row.enabled, enabled_at: row.enabled_at };
    }
  }

  return NextResponse.json({
    agents: (agents ?? []).map((agent) => ({
      ...agent,
      enabled: settingsByAgent[agent.id]?.enabled ?? false,
      enabled_at: settingsByAgent[agent.id]?.enabled_at ?? null,
    })),
    settings: settingsByAgent,
  });
}

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { agentId, enabled } = body as { agentId?: unknown; enabled?: unknown };
  if (!isValidUUID(agentId) || typeof enabled !== "boolean") {
    return NextResponse.json({ error: "agentId must be a UUID and enabled must be a boolean" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: agent, error: ownershipError } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (ownershipError) {
    return NextResponse.json({ error: "Failed to verify agent ownership" }, { status: 500 });
  }
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const enabledAt = enabled ? new Date(Date.now()).toISOString() : null;
  const { data, error } = await supabase
    .from("agent_browser_settings")
    .upsert(
      { user_id: user.id, agent_id: agentId, enabled, enabled_at: enabledAt },
      { onConflict: "user_id,agent_id" }
    )
    .select("agent_id, enabled, enabled_at")
    .single();
  if (error) {
    return NextResponse.json({ error: "Failed to save browser settings" }, { status: 500 });
  }

  return NextResponse.json({ success: true, setting: data });
}