import { test, equal, ok } from "./harness";
import {
  parseBBox,
  parseLines,
  visionNormalizedBBoxToPixelBox,
} from "../src/lib/ocr/vision-service";
import { imageDimensionsFromBuffer } from "../src/lib/ocr/image-dims";

// ─── 1. parseBBox: canonical array form (0..1000) ─────────────────────────

test("parseBBox accepts a normalized [ymin, xmin, ymax, xmax] array", () => {
  equal(parseBBox([410, 40, 470, 700]), [410, 40, 470, 700]);
});

test("parseBBox scales a 0..1 unit box into 0..1000", () => {
  equal(parseBBox([0.05, 0.1, 0.2, 0.7]), [50, 100, 200, 700]);
});

test("parseBBox accepts object forms the model may drift toward", () => {
  equal(parseBBox({ ymin: 5, xmin: 10, ymax: 20, xmax: 90 }), [5, 10, 20, 90]);
  equal(parseBBox({ y1: 5, x1: 10, y2: 20, x2: 90 }), [5, 10, 20, 90]);
  equal(parseBBox({ x: 10, y: 5, width: 80, height: 15 }), [5, 10, 20, 90]);
});

test("parseBBox rejects unusable geometry", () => {
  equal(parseBBox(null), undefined);
  equal(parseBBox([1, 2]), undefined);
  equal(parseBBox([1, 2, 3, "x"]), undefined);
  equal(parseBBox([-1, 0, 10, 10]), undefined);
  equal(parseBBox([20, 0, 10, 10]), undefined); // inverted y
  equal(parseBBox([0, 30, 10, 10]), undefined); // inverted x
  equal(parseBBox({ ymin: 0, xmin: 0, ymax: 10 }), undefined); // missing one
});

// ─── 2. parseLines: model output → OCRResultItem[] with optional bbox ───

test("parseLines passes normalized bboxes through and skips bad lines", () => {
  const out = parseLines([
    { text: "SuperPay", confidence: 0.98, bbox: [10, 20, 40, 900] },
    { text: " ", confidence: 0.9, bbox: [0, 0, 1, 1] }, // blank text dropped
    { text: "68.38", bbox: [0.3, 0.2, 0.4, 0.6] }, // unit-space box
    { text: "broken", bbox: [1, 2, 3] },
  ]);
  equal(out.length, 3);
  equal(out[0].bbox, [10, 20, 40, 900]);
  equal(out[1].bbox, [300, 200, 400, 600]);
  ok(out[2].bbox === undefined, "unparseable bbox degrades to none");
});

test("parseLines keeps working when no bbox is present", () => {
  const out = parseLines([{ text: "plain", confidence: 0.5 }]);
  equal(out.length, 1);
  equal(out[0].text, "plain");
  equal(out[0].bbox, undefined);
});

// ─── 3. visionNormalizedBBoxToPixelBox ────────────────────────────────────

test("normalized box converts into pixel-space BBox", () => {
  const box = visionNormalizedBBoxToPixelBox([500, 100, 800, 700], 1000, 2000);
  equal(box, { x: 100, y: 1000, width: 600, height: 600 });
});

test("normalized box conversion is image-size aware", () => {
  const box = visionNormalizedBBoxToPixelBox([0, 0, 1000, 1000], 400, 300);
  equal(box, { x: 0, y: 0, width: 400, height: 300 });
});

// ─── 4. imageDimensionsFromBuffer: dependency-free header parsing ─────────

function pngBuf(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpegBuf(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffc0, 2);
  b.writeUInt16BE(23, 4);
  b.writeUInt8(8, 6);
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

function gifBuf(w: number, h: number): Buffer {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function bmpBuf(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("BM", 0, "ascii");
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  return b;
}

function webpVp8lBuf(w: number, h: number): Buffer {
  const b = Buffer.alloc(25);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b.writeUInt8(0x2f, 20); // VP8L lossless signature byte
  const packed = (w - 1) | ((h - 1) << 14);
  b.writeUInt32LE(packed, 21);
  return b;
}

test("image dims: PNG", () => {
  equal(imageDimensionsFromBuffer(pngBuf(10, 8)), { w: 10, h: 8 });
});

test("image dims: JPEG (SOF0)", () => {
  equal(imageDimensionsFromBuffer(jpegBuf(320, 240)), { w: 320, h: 240 });
});

test("image dims: GIF", () => {
  equal(imageDimensionsFromBuffer(gifBuf(24, 32)), { w: 24, h: 32 });
});

test("image dims: BMP", () => {
  equal(imageDimensionsFromBuffer(bmpBuf(5, 9)), { w: 5, h: 9 });
});

test("image dims: WebP (VP8L)", () => {
  equal(imageDimensionsFromBuffer(webpVp8lBuf(30, 20)), { w: 30, h: 20 });
});

test("image dims: unknown/truncated buffers return null, never throw", () => {
  equal(imageDimensionsFromBuffer(Buffer.alloc(0)), null);
  equal(imageDimensionsFromBuffer(Buffer.from("hello world")), null);
  equal(imageDimensionsFromBuffer(pngBuf(10, 8).subarray(0, 12)), null);
  equal(imageDimensionsFromBuffer(Buffer.alloc(100, 0xab)), null);
});

// ─── 5. end-to-end: inspector-like derivation from a vision line box ──────

test("vision bbox flows into an OcrDocument line as a pixel box", () => {
  const lines = parseLines([
    { text: "رقم العملية", confidence: 0.95, bbox: [120, 60, 170, 640] },
  ]);
  const dims = imageDimensionsFromBuffer(pngBuf(1000, 2000));
  const line = lines[0];
  ok(line.bbox !== undefined, "line carries a normalized bbox");
  equal(dims, { w: 1000, h: 2000 });
  const pixel = visionNormalizedBBoxToPixelBox(line.bbox!, dims!.w, dims!.h);
  equal(pixel, { x: 60, y: 240, width: 580, height: 100 });
});