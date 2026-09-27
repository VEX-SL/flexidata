import { test, ok, equal, assert } from "./harness.ts";
import { renderPdfPageToPng, MAX_PAGE_EDGE_PX } from "@/lib/pdf-render";

/**
 * PDF page rasterizer — the exact code the Documents Inspector's page endpoint
 * runs, exercised against a real PDF.
 *
 * Regression: the endpoint used to drive pdf.js directly with
 * `GlobalWorkerOptions.workerSrc = ""`. On Node that makes pdf.js try to
 * `import("")` for its fake worker, so `getDocument()` rejected with
 * `Setting up fake worker failed: "No GlobalWorkerOptions.workerSrc
 * specified."` and every page request 502'd — the Inspector showed "Could not
 * render this page." for all 8 pages. This test renders a real PDF through the
 * production path, so that failure mode cannot come back unnoticed.
 */

/** A minimal valid 3-page PDF with a visible filled rectangle per page. */
function makePdf(): Buffer {
  const page = (w: number, h: number) =>
    `${w} ${h} 0 0 0 0 0 0 0 0 cm 0 0 1 rg 20 20 ${w - 40} ${h - 40} re f\n`;
  // 1: small landscape, 2: small portrait, 3: large (exercises the 1200px cap).
  const sizes: Array<[number, number]> = [
    [400, 300],
    [300, 500],
    [2400, 1800],
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>`,
    ...sizes.map(
      ([w, h], i) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${6 + i} 0 R /Resources << >> >>`
    ),
    ...sizes.map(([w, h]) => {
      const content = page(w, h);
      return `<< /Length ${content.length} >>\nstream\n${content}endstream`;
    }),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const PDF = makePdf();
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("render: a real PDF page rasterizes to a valid PNG", async () => {
  const { png, dimensions } = await renderPdfPageToPng(PDF, 1);

  ok(png.length > 0, "produced PNG bytes");
  equal(
    png.subarray(0, 8).toString("hex"),
    PNG_MAGIC.toString("hex"),
    "output starts with the PNG signature"
  );
  // IHDR width/height live at fixed byte offsets 16..24 of a PNG.
  equal(png.readUInt32BE(16), dimensions.width, "PNG header width matches dimensions");
  equal(png.readUInt32BE(20), dimensions.height, "PNG header height matches dimensions");
});

test("render: a small page is upscaled 2x, never beyond", async () => {
  // 400x300 would need scale 3 to hit the 1200px cap; the renderer caps the
  // upscale at 2x so tiny pages are not blown up into blurry mush.
  const p1 = await renderPdfPageToPng(PDF, 1);
  equal(p1.dimensions, { width: 800, height: 600 }, "landscape page renders at 2x");

  const p2 = await renderPdfPageToPng(PDF, 2); // 300x500 portrait
  equal(p2.dimensions, { width: 600, height: 1000 }, "portrait page renders at 2x");
});

test("render: a large page is capped at the long-side limit, aspect preserved", async () => {
  const p3 = await renderPdfPageToPng(PDF, 3); // 2400x1800
  equal(p3.dimensions.width, MAX_PAGE_EDGE_PX, "long side capped at 1200px");
  equal(
    p3.dimensions.height,
    Math.ceil((1800 / 2400) * MAX_PAGE_EDGE_PX),
    "aspect ratio preserved when scaling down"
  );
  equal(
    Math.max(p3.dimensions.width, p3.dimensions.height),
    MAX_PAGE_EDGE_PX,
    "no page ever exceeds the long-side cap"
  );
});

test("render: consecutive pages both render (buffer is never detached)", async () => {
  // pdf.js transfers (detaches) the bytes it is handed, so a reused buffer
  // made the second page fail with DataCloneError.
  const first = await renderPdfPageToPng(PDF, 1);
  const second = await renderPdfPageToPng(PDF, 2);
  ok(first.png.length > 0, "page 1 rendered");
  ok(second.png.length > 0, "page 2 rendered");
  assert(
    first.png.length !== second.png.length,
    "different pages produce different images"
  );
});

test("render: a page beyond the document is rejected", async () => {
  let message = "";
  try {
    await renderPdfPageToPng(PDF, 9);
  } catch (e) {
    message = (e as Error).message;
  }
  ok(/exceeds document \(3 pages\)/.test(message), `clear error — got: ${message}`);
});
