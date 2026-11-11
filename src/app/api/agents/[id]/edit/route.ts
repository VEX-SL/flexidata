import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { saveAgentFileInternal } from "@/lib/agent-files";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id: agentId } = await params;
  if (!isValidUUID(agentId)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { documentId, filename, newContent, isNewFile } = body as {
    documentId?: string;
    filename?: string;
    newContent?: string;
    isNewFile?: boolean;
  };

  if (typeof newContent !== "string" || !newContent.trim()) {
    return NextResponse.json({ error: "Invalid content" }, { status: 400 });
  }
  if (!filename) {
    return NextResponse.json({ error: "Filename required" }, { status: 400 });
  }

  // Verify the agent belongs to the user (auth check stays in the route)
  const supabaseAdmin = (await import("@/lib/supabase/admin")).createAdminClient();
  const { data: agent } = await supabaseAdmin
    .from("agents")
    .select("id, user_id")
    .eq("id", agentId)
    .single();

  if (!agent || agent.user_id !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // If documentId is provided AND valid, we update that specific document
  // directly (this preserves backward-compat with the sidebar's edit flow
  // which knows the documentId). Otherwise we use the shared helper which
  // matches by filename.
  if (documentId && isValidUUID(documentId)) {
    const { data: doc } = await supabaseAdmin
      .from("documents")
      .select("id, title")
      .eq("id", documentId)
      .eq("agent_id", agentId)
      .single();

    if (doc) {
      const { error: updateError } = await supabaseAdmin
        .from("documents")
        .update({ parsed_content: newContent.slice(0, 500_000) })
        .eq("id", documentId);

      if (updateError) {
        console.error("[Edit] Update error:", updateError);
        return NextResponse.json(
          { error: "Failed to update document" },
          { status: 500 }
        );
      }

      console.log(
        `[Edit] Updated document ${doc.title} (${newContent.length} chars) in agent ${agentId}`
      );
      return NextResponse.json({
        success: true,
        document: { id: doc.id, title: doc.title },
      });
    }
  }

  // Fall back to the shared helper (matches by filename, creates if needed)
  const result = await saveAgentFileInternal(agentId, filename, newContent);
  if (!result.success) {
    return NextResponse.json({ error: result.error || "Failed" }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    document: { id: result.documentId!, title: filename },
    created: result.created === true,
  });
}
