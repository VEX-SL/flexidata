import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { loadOwnedFileBytes } from "@/lib/file-access";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * GET /api/files/{id}/pages/{page} — render one PDF page to a PNG so the
 * Documents review's inspector can show per-page geometry for OCR documents.
 * Rendered server-side with pdfjs + canvas (no browser pdf.js needed). The
 * response carries `X-Page-Width` / `X-Page-Height` (the PNG's pixel size) so
 * clients can scale normalized per-page bboxes onto the image.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; page: string }> }
): Promise<NextResponse> {
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
    const png = await renderPdfPageToPng(owned.buffer, pageNum);
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
        ...(png.dimensions
          ? {
              "X-Page-Width": String(png.dimensions.width),
              "X-Page-Height": String(png.dimensions.height),
            }
          : {}),
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

let pdfjsModule: Promise<any> | null = null;
async function loadPdfJs(): Promise<any> {
  if (!pdfjsModule) {
    pdfjsModule = (async () => {
      try {
        return await import("pdfjs-dist/legacy/build/pdf.mjs");
      } catch {
        return await import("pdfjs-dist/build/pdf.mjs");
      }
    })();
  }
  return pdfjsModule;
}

/** Render a single PDF page to a PNG (long side capped at 1200 px). */
async function renderPdfPageToPng(
  buffer: Buffer,
  pageIndex: number
): Promise<Buffer & { dimensions?: { width: number; height: number } }> {
  const { isCanvasAvailable, createCanvas } = await import("@/lib/pdf-canvas");
  if (!isCanvasAvailable()) {
    throw new Error("Canvas unavailable");
  }
  const pdfjsLib = await loadPdfJs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = "";
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  if (pageIndex > doc.numPages) {
    throw new Error(`Page ${pageIndex} exceeds document (${doc.numPages} pages)`);
  }
  const page = await doc.getPage(pageIndex);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, 1200 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  await page.render({
    canvasContext: ctx as never,
    canvas: canvas as never,
    viewport,
  }).promise;
  const buf = Buffer.from(canvas.toBuffer("image/png"));
  return Object.assign(buf, {
    dimensions: {
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
    },
  }) as Buffer & { dimensions: { width: number; height: number } };
}