import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { loadOwnedFileBytes } from "@/lib/file-access";

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

  const owned = await loadOwnedFileBytes(user.id, id);
  if (!owned) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const contentType = owned.mimeType || "application/octet-stream";
  const disposition = /image\//i.test(contentType)
    ? "inline"
    : `attachment; filename="${encodeURIComponent(owned.originalName ?? "file")}"`;

  return new Response(new Uint8Array(owned.buffer), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Cache-Control": "private, max-age=300",
    },
  });
}
