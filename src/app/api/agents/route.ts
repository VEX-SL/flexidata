import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const startedAt = performance.now();

  try {
    const authStart = performance.now();

    const supabase = await createClient();
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

    console.log("[AGENTS PERFORMANCE]", {
      agents_count: agents?.length || 0,
      auth: Math.round(authTime * 100) / 100,
      database: Math.round(queryTime * 100) / 100,
      total: Math.round(totalTime * 100) / 100,
    });

    return NextResponse.json(agents || [], {
      headers: {
        "Server-Timing": [
          `auth;dur=${authTime}`,
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