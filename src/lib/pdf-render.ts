import { Buffer } from "node:buffer";

/**
 * Server-side PDF page rasterizer.
 *
 * Rendering goes through unpdf, which owns its own pdf.js worker + canvas
 * bootstrap. Driving pdf.js directly (`getDocument` with
 * `GlobalWorkerOptions.workerSrc = ""`) cannot work on Node: with no workerSrc
 * pdf.js tries to `import("")` for its fake worker, so every `getDocument()`
 * rejects with `Setting up fake worker failed` and page rendering dies with a
 * 502 — which is exactly what the Documents Inspector showed ("Could not
 * render this page"). unpdf is the same path the PDF text extractor already
 * uses successfully on serverless, so page rendering now shares it.
 */

/** Canvas importer handed to unpdf, normalizing the CJS default export. */
export async function loadCanvas(): Promise<any> {
  const mod: any = await import("@napi-rs/canvas");
  return mod?.default ?? mod;
}

/** Longest rendered side, in pixels — the Inspector scales boxes onto this. */
export const MAX_PAGE_EDGE_PX = 1200;

export interface RenderedPage {
  /** The encoded PNG bytes. */
  png: Buffer;
  /** The PNG's pixel size, for the `X-Page-*` response headers. */
  dimensions: { width: number; height: number };
}

/**
 * Render one PDF page to a PNG (long side capped at MAX_PAGE_EDGE_PX).
 *
 * pdf.js takes ownership of — and detaches — the typed array it is handed, so
 * every call gets its own copy of the document bytes; reusing one buffer makes
 * the second call fail with `DataCloneError`.
 */
export async function renderPdfPageToPng(
  buffer: Buffer | Uint8Array,
  pageIndex: number
): Promise<RenderedPage> {
  const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  if (pageIndex > doc.numPages) {
    throw new Error(`Page ${pageIndex} exceeds document (${doc.numPages} pages)`);
  }
  const page = await doc.getPage(pageIndex);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, MAX_PAGE_EDGE_PX / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const png = Buffer.from(
    await renderPageAsImage(new Uint8Array(buffer), pageIndex, {
      canvasImport: loadCanvas,
      scale,
    })
  );
  return {
    png,
    dimensions: {
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
    },
  };
}
