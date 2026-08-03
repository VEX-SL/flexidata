import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/files/{id} — stream the original file back to the authenticated
 * owner (used by the Documents review's OCR preview panel). Bytes are read
 * from Supabase Storage with the service role and returned inline.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "Invalid file id" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: file } = await supabase
    .from("files")
    .select("id, name, url, mime_type, original_name")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  let buffer: Buffer | null = null;
  try {
    const { data, error } = await supabase.storage
      .from("files")
      .download(file.name);
    if (error || !data) throw new Error(error?.message ?? "no data");
    buffer = Buffer.from(await data.arrayBuffer());
  } catch {
    if (file.url) {
      const res = await fetch(file.url);
      if (res.ok) buffer = Buffer.from(await res.arrayBuffer());
    }
  }

  if (!buffer) {
    return NextResponse.json(
      { error: "Failed to read file from storage" },
      { status: 502 }
    );
  }

  const contentType = file.mime_type || "application/octet-stream";
  const disposition = /image\//i.test(contentType)
    ? "inline"
    : `attachment; filename="${encodeURIComponent(file.original_name ?? "file")}"`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Cache-Control": "private, max-age=300",
    },
  });
}
