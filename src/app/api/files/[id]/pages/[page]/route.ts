import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { loadOwnedFileBytes } from "@/lib/file-access";
import { renderPdfPageToPng } from "@/lib/pdf-render";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * GET /api/files/{id}/pages/{page} — render one PDF page to a PNG so the
 * Documents review's inspector can show per-page geometry for OCR documents.
 * Rendered server-side via unpdf + @napi-rs/canvas (no browser pdf.js needed);
 * unpdf owns its pdf.js worker/CanvasFactory setup, which is the same machinery
 * the PDF text extractor already uses successfully on serverless. The response
 * carries `X-Page-Width` / `X-Page-Height` (the PNG's pixel size) so clients
 * can scale normalized per-page bboxes onto the image.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; page: string }> }
): Promise<Response> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id, page: pageParam } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "Invalid file id" }, { status: 400 });
  }
  const pageNum = Number(pageParam);
  if (!Number.isInteger(pageNum) || pageNum < 1) {
    return NextResponse.json({ error: "Invalid page number" }, { status: 400 });
  }

  const owned = await loadOwnedFileBytes(user.id, id);
  if (!owned) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  if (!/application\/pdf/i.test(owned.mimeType ?? "") && !/%PDF-/.test(owned.buffer.subarray(0, 5).toString("ascii"))) {
    return NextResponse.json(
      { error: "File is not a PDF" },
      { status: 415 }
    );
  }

  try {
    const { png, dimensions } = await renderPdfPageToPng(owned.buffer, pageNum);
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
        "X-Page-Width": String(dimensions.width),
        "X-Page-Height": String(dimensions.height),
      },
    });
  } catch (err) {
    console.error(`[PdfPage] render page ${pageNum} failed:`, err);
    return NextResponse.json(
      { error: "Failed to render PDF page" },
      { status: 502 }
    );
  }
}
