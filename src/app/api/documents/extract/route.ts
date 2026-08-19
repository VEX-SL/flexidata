/**
 * Document extraction route — POST /api/documents/extract.
 *
 * Accepts a multipart form with:
 *   file   — the document to analyze (PDF or image, max 10 MB).
 *   schema — optional JSON text describing the fields to extract (a
 *            PipelineSchema: `{ "fields": [{ "key": ..., ... }] }`).
 *
 * The file is converted to a Buffer and run through the full extraction
 * pipeline (OCR → Rescue → Grounding → Transformer). PDFs are rendered to an
 * image first (first page). The response is the FinalExtractionResult with
 * 200 OK; validation problems are 400s; unexpected failures are a safe 500
 * that never leaks internal error details.
 */
import { NextResponse } from "next/server";
import {
  processDocumentPipeline,
  type PipelineSchema,
} from "@/lib/extraction/pipeline";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const PDF_MIME = "application/pdf";
const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

export type DocumentPipeline = typeof processDocumentPipeline;
export type PdfRenderer = (buffer: Buffer) => Promise<Buffer>;

/** A request-level error carrying its HTTP status. */
export class ExtractError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Magic-byte sniffing fallback for clients that send an empty/opaque type. */
export function sniffMime(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
    return "image/jpeg";
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  return undefined;
}

/**
 * Render the first page of a PDF to a PNG buffer so the image pipeline can
 * consume it. Mirrors the page-rendering path used by `file-parser`.
 */
export async function renderFirstPageToPng(buffer: Buffer): Promise<Buffer> {
  const { isCanvasAvailable, createCanvas } = await import("@/lib/pdf-canvas");
  if (!isCanvasAvailable()) {
    throw new ExtractError(500, "PDF rendering unavailable");
  }
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "";
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({
    canvasContext: ctx as never,
    canvas: canvas as never,
    viewport,
  }).promise;
  return Buffer.from(canvas.toBuffer("image/png"));
}

/** Parse the optional `schema` form field into a validated PipelineSchema. */
export async function parseSchema(raw: string | File | null): Promise<PipelineSchema> {
  if (raw == null) return { fields: [] };
  const text = typeof raw === "string" ? raw : await raw.text();
  if (!text.trim()) {
    throw new ExtractError(400, "schema must be a JSON string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExtractError(400, "Invalid schema JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExtractError(400, "schema must be an object with a fields array");
  }
  const fields = (parsed as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) {
    throw new ExtractError(400, "schema must be an object with a fields array");
  }
  for (const field of fields) {
    if (!field || typeof field !== "object" || typeof (field as { key?: unknown }).key !== "string") {
      throw new ExtractError(400, "each schema field must have a string key");
    }
  }
  return { fields: fields as PipelineSchema["fields"] };
}

function resolveMime(declared: string, buffer: Buffer): string {
  const normalized = declared.trim().toLowerCase().split(";")[0].trim();
  if (normalized === PDF_MIME || IMAGE_MIMES.has(normalized)) return normalized;
  return sniffMime(buffer) ?? normalized;
}

/** Build the route handler with injectable dependencies (pipeline, PDF renderer). */
export function createExtractHandler(deps: {
  pipeline: DocumentPipeline;
  renderPdf?: PdfRenderer;
}) {
  return async function POST(request: Request): Promise<NextResponse> {
    try {
      return await handleExtract(request, deps);
    } catch (err) {
      if (err instanceof ExtractError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error("[Extract] Unexpected failure:", err);
      return NextResponse.json({ error: "Extraction failed" }, { status: 500 });
    }
  };
}

async function handleExtract(
  request: Request,
  deps: { pipeline: DocumentPipeline; renderPdf?: PdfRenderer }
): Promise<NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new ExtractError(400, "Invalid form data");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new ExtractError(400, "No file provided");
  }
  if (file.size === 0) {
    throw new ExtractError(400, "Empty file");
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new ExtractError(400, "File too large (max 10 MB)");
  }

  const schema = await parseSchema(formData.get("schema") as string | File | null);

  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = resolveMime(file.type, buffer);
  if (mime !== PDF_MIME && !IMAGE_MIMES.has(mime)) {
    throw new ExtractError(400, `Unsupported file type: ${mime || "unknown"}`);
  }

  const input = mime === PDF_MIME ? await (deps.renderPdf ?? renderFirstPageToPng)(buffer) : buffer;
  const { result, elapsedMs } = await deps.pipeline(input, schema);

  return NextResponse.json({
    data: result.data,
    meta: result.meta,
    issues: result.issues,
    elapsedMs,
  });
}

export const POST = createExtractHandler({
  pipeline: processDocumentPipeline,
  renderPdf: renderFirstPageToPng,
});