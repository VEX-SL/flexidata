import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("files")
    .select("id, original_name, name, url, mime_type, size_bytes, status, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch files" }, { status: 500 });
  }

  return NextResponse.json(data || []);
}

export async function DELETE(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get("id");

  if (!fileId || !isValidUUID(fileId)) {
    return NextResponse.json({ error: "Invalid file ID" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { error } = await supabase
    .from("files")
    .delete()
    .eq("id", fileId)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: "Failed to delete file" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
