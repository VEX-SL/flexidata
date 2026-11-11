import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";


export async function GET(request: Request) {
  const startedAt = performance.now();

  try {
    // 1. Measure Supabase client creation
    const clientStart = performance.now();
    const supabase = await createClient();
    const clientTime = performance.now() - clientStart;

    // 2. Measure authentication
    const authStart = performance.now();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    const authTime = performance.now() - authStart;

    if (userError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // 3. Measure database RPC
    const queryStart = performance.now();

    const { data: agents, error } = await supabase.rpc(
      "get_agents_with_counts"
    );

    const queryTime = performance.now() - queryStart;
    const totalTime = performance.now() - startedAt;

    if (error) {
      console.error("[AGENTS RPC ERROR]", error);

      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    // 4. Performance logs
    console.log("[AGENTS PERFORMANCE]", {
      agents_count: agents?.length || 0,
      client_creation: Math.round(clientTime * 100) / 100,
      get_user: Math.round(authTime * 100) / 100,
      database: Math.round(queryTime * 100) / 100,
      total: Math.round(totalTime * 100) / 100,
    });

    return NextResponse.json(agents || [], {
      headers: {
        "Server-Timing": [
          `client;dur=${clientTime}`,
          `getUser;dur=${authTime}`,
          `database;dur=${queryTime}`,
        ].join(", "),
      },
    });
  } catch (err: any) {
    console.error("[AGENTS ERROR]", err);

    return NextResponse.json(
      { error: err.message || "Internal Server Error" },
      { status: 500 }
    );
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