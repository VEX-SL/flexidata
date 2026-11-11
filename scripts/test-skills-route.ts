import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Skills Diagnostic Endpoint
 * --------------------------
 * Verifies that the agent_skills table is queryable and shows what the
 * chat route will see. Open in browser:
 *
 *   /api/skills/test
 *
 * Or curl:
 *   curl -H "Cookie: ..." http://localhost:3000/api/skills/test
 */

export async function GET(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const supabase = createAdminClient();

  const result: any = {
    timestamp: new Date().toISOString(),
    user: { id: user.id, email: user.email },
    steps: [],
  };

  // Step 1: Test basic table access
  result.steps.push({ step: "1. Query agent_skills (no filter)" });
  try {
    const { data: allSkills, error: allError } = await supabase
      .from("agent_skills")
      .select("*");

    result.steps.push({
      step: "1. Result",
      ok: !allError,
      count: allSkills?.length ?? 0,
      error: allError?.message,
      skills: (allSkills ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        display_name: s.display_name,
        is_active: s.is_active,
        priority: s.priority,
        required_tools: s.required_tools,
        description_length: s.description?.length ?? 0,
      })),
    });
  } catch (e: any) {
    result.steps.push({ step: "1. EXCEPTION", error: e.message });
  }

  // Step 2: Test the active-only filter (this is what the chat route uses)
  result.steps.push({ step: "2. Query agent_skills WHERE is_active = true" });
  try {
    const { data: activeSkills, error: activeError } = await supabase
      .from("agent_skills")
      .select("id, name, display_name, description, required_tools, priority")
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .order("name", { ascending: true });

    result.steps.push({
      step: "2. Result",
      ok: !activeError,
      count: activeSkills?.length ?? 0,
      error: activeError?.message,
      active_skills: (activeSkills ?? []).map((s: any) => ({
        name: s.name,
        display_name: s.display_name,
        description_preview: s.description?.slice(0, 100),
        required_tools: s.required_tools,
      })),
    });
  } catch (e: any) {
    result.steps.push({ step: "2. EXCEPTION", error: e.message });
  }

  // Step 3: Check skill_resources table
  result.steps.push({ step: "3. Query skill_resources" });
  try {
    const { data: resources, error: resError } = await supabase
      .from("skill_resources")
      .select("id, skill_id, filename, content_type, is_primary, sort_order");

    result.steps.push({
      step: "3. Result",
      ok: !resError,
      count: resources?.length ?? 0,
      error: resError?.message,
      resources: resources ?? [],
    });
  } catch (e: any) {
    result.steps.push({ step: "3. EXCEPTION", error: e.message });
  }

  // Step 4: Build the "availableTools" array like the chat route would
  result.steps.push({ step: "4. Build availableTools array" });
  try {
    const { data: skills } = await supabase
      .from("agent_skills")
      .select("required_tools")
      .eq("is_active", true);

    const toolsSet = new Set<string>();
    for (const s of skills ?? []) {
      if (Array.isArray(s.required_tools)) {
        for (const t of s.required_tools) {
          if (t) toolsSet.add(t);
        }
      }
    }
    result.steps.push({
      step: "4. Result",
      availableTools: Array.from(toolsSet),
      count: toolsSet.size,
    });
  } catch (e: any) {
    result.steps.push({ step: "4. EXCEPTION", error: e.message });
  }

  return NextResponse.json(result, { status: 200 });
}
