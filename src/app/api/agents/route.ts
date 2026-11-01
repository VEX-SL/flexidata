import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // جلب الوكلاء الخاصين بالمستخدم
    const { data: agents, error } = await supabase
      .from("agents")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // حساب عدد الملفات والمحادثات لكل وكيل بشكل دقيق
    const agentsWithCounts = await Promise.all(
      (agents || []).map(async (agent) => {
        // عد الملفات المرتبطة بالوكيل
        const { count: filesCount } = await supabase
          .from("agent_files")
          .select("*", { count: "exact", head: true })
          .eq("agent_id", agent.id);

        // عد المحادثات المرتبطة بالوكيل
        const { count: chatsCount } = await supabase
          .from("chats")
          .select("*", { count: "exact", head: true })
          .eq("agent_id", agent.id);

        return {
          ...agent,
          files_count: filesCount || 0,
          chats_count: chatsCount || 0,
        };
      })
    );

    return NextResponse.json(agentsWithCounts);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name, description } = body;

    if (!name || !name.trim()) {
      return NextResponse.json({ error: "Agent name is required" }, { status: 400 });
    }

    const shareToken = Math.random().toString(36).substring(2) + Date.now().toString(36);

    // إدخال وكيل جديد
    const { data: newAgent, error } = await supabase
      .from("agents")
      .insert({
        user_id: user.id,
        name: name.trim(),
        description: description?.trim() || null,
        share_token: shareToken,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ...newAgent,
      files_count: 0,
      chats_count: 0,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}