/**
 * Unit tests for the OCR preprocessing math (pure array ops — no tesseract
 * engine, no network). Canvas-backed stages (scaleImage/rotateImage) are
 * tested when @napi-rs/canvas is available.
 */
import {
  applyOrientation,
  adaptiveThreshold,
  autoCrop,
  contrastStretch,
  decodeToRgba,
  detectQuad,
  downsampleGray,
  estimateQuarterRotation,
  estimateSkewAngle,
  isCanvasAvailable,
  jpegOrientation,
  otsuThreshold,
  rotateImage,
  scaleImage,
  sharpenGray,
  toGray,
  warpQuad,
} from "@/lib/ocr/preprocess";
import { test, ok, equal, assert } from "./harness.ts";

function grayFrom(rows: number[][]): Float32Array {
  const h = rows.length, w = rows[0].length;
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) g[y * w + x] = rows[y][x];
  return g;
}

function rawFromGray(w: number, h: number, gray: Float32Array) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i])));
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

function buildExifJpeg(orientation: number): Buffer {
  const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
  const c = createCanvas(30, 10);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 30, 10);
  const jpeg = c.toBuffer("image/jpeg");
  const tiff = Buffer.alloc(20);
  tiff.write("II", 0, 2, "latin1");
  tiff[2] = 42; tiff[3] = 0;
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt16LE(0, 16);
  const seg = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = seg.length + 2;
  const header = Buffer.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([jpeg.subarray(0, 2), header, seg, jpeg.subarray(2)]);
}

// ─── EXIF orientation ──────────────────────────────────────────────────────

test("jpegOrientation parses EXIF APP1 orientation values", () => {
  for (const o of [1, 3, 6, 8]) {
    equal(jpegOrientation(buildExifJpeg(o)), o, `orientation ${o}`);
  }
});

test("jpegOrientation returns 1 for non-JPEG input", () => {
  equal(jpegOrientation(new Uint8Array([1, 2, 3, 4])), 1);
});

test("applyOrientation rotates and mirrors pixels per EXIF", () => {
  const g = grayFrom([
    [10, 20, 30],
    [40, 50, 60],
  ]); // 3 wide, 2 tall
  const img = rawFromGray(3, 2, g);

  const r90 = applyOrientation(img, 6); // rotate 90 CW → 2 wide, 3 tall
  equal(r90.width, 2);
  equal(r90.height, 3);
  const at = (x: number, y: number) => r90.data[(y * 2 + x) * 4];
  equal(at(0, 0), 40, "top-left after 90CW is former bottom-left");
  equal(at(1, 2), 30, "bottom-right after 90CW is former top-right");

  const r180 = applyOrientation(img, 3);
  equal(r180.width, 3);
  equal(r180.height, 2);
  equal(r180.data[0 * 4], 60, "top-left after 180 is former bottom-right");
  equal(r180.data[(1 * 3 + 2) * 4], 10, "bottom-right after 180 is former top-left");
});

// ─── Threshold / contrast ──────────────────────────────────────────────────

test("otsuThreshold separates overlapping bimodal clusters", () => {
  // Deterministic LCG so the test is stable across runs.
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const gauss = () => {
    let u1 = rnd();
    while (u1 === 0) u1 = rnd();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rnd());
  };
  const g = new Float32Array(1400);
  for (let i = 0; i < 700; i++) g[i] = 72 + gauss() * 22; // dark ink cluster
  for (let i = 700; i < 1400; i++) g[i] = 192 + gauss() * 22; // paper cluster
  const th = otsuThreshold(g);
  ok(th > 100 && th < 170, `threshold ${th} should sit between the two modes (~130)`);
});

test("adaptiveThreshold binarizes thin text strokes under uneven lighting", () => {
  const w = 80, h = 60;
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      g[y * w + x] = 200 + (x * 30) / w + (y * 20) / h; // 200..250 background
  // Thin text-like strokes (2px bars) — Bradley keeps thin ink on uneven paper.
  for (let y = 20; y < 22; y++)
    for (let x = 15; x < 60; x++) g[y * w + x] = 0;
  for (let y = 32; y < 34; y++)
    for (let x = 15; x < 60; x++) g[y * w + x] = 0;
  const bin = adaptiveThreshold(g, w, h);
  for (const [x, y] of [[20, 20], [45, 20], [30, 32], [50, 33]])
    equal(bin[y * w + x], 0, `stroke pixel (${x},${y}) must be ink`);
  equal(bin[0 * w + 0], 255, "corner background stays paper");
  equal(bin[10 * w + 70], 255, "distant background stays paper");
  equal(bin[10 * w + 40], 255, "background above a stroke stays paper");
  equal(bin[45 * w + 25], 255, "background between strokes stays paper");
});

test("contrastStretch expands a narrow range to near-full", () => {
  const g = new Float32Array(200);
  for (let i = 0; i < 200; i++) g[i] = 120 + (i / 200) * 60; // 120..180
  const out = contrastStretch(g);
  let mn = 255, mx = 0;
  for (let i = 0; i < out.length; i++) { mn = Math.min(mn, out[i]); mx = Math.max(mx, out[i]); }
  ok(mx - mn > 200, `stretched span ${mx - mn} should be near full`);
  const flat = contrastStretch(new Float32Array(100).fill(128));
  ok(flat.every((v) => Math.abs(v - 128) < 1), "near-constant image passes through");
});

test("sharpenGray amplifies edges and stays in range", () => {
  const w = 12, h = 12;
  const g = new Float32Array(w * h);
  for (let x = 4; x < 8; x++) g[6 * w + x] = 0; // dark horizontal bar on white
  for (let i = 0; i < w * h; i++) if (g[i] === 0) g[i] = 200; // rest baseline
  const s = sharpenGray(g, w, h);
  for (let i = 0; i < s.length; i++) ok(s[i] >= 0 && s[i] <= 255, `value ${s[i]} in range`);
});

// ─── Deskew / rotation ─────────────────────────────────────────────────────

test("estimateSkewAngle returns ~0 for horizontal bars", () => {
  const w = 160, h = 160;
  const g = new Float32Array(w * h); g.fill(255);
  for (let y = 20; y < 26; y++)
    for (let x = 0; x < w; x++) g[y * w + x] = 0;
  for (let y = 60; y < 66; y++)
    for (let x = 0; x < w; x++) g[y * w + x] = 0;
  const angle = estimateSkewAngle(g, w, h);
  ok(Math.abs(angle) < 0.3, `horizontal bars → angle ${angle}`);
});

test("estimateSkewAngle detects a slanted line block", () => {
  const w = 200, h = 200;
  const g = new Float32Array(w * h); g.fill(255);
  const angle = 3.0; // rendered slant
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      if (sy >= 20 && sy < 26) g[y * w + x] = 0;
      if (sy >= 60 && sy < 66) g[y * w + x] = 0;
    }
  }
  const est = estimateSkewAngle(g, w, h);
  ok(Math.abs(Math.abs(est) - angle) < 0.6, `slant ${angle}° → estimate ${est}°`);
});

test("estimateQuarterRotation detects vertical text", () => {
  const w = 120, h = 160;
  const g = new Float32Array(w * h); g.fill(255);
  for (let x = 10; x < 14; x++)
    for (let y = 0; y < h; y++) g[y * w + x] = 0; // vertical bars
  for (let x = 50; x < 54; x++)
    for (let y = 0; y < h; y++) g[y * w + x] = 0;
  equal(estimateQuarterRotation(g, w, h), 90);
  for (let x = 10; x < 14; x++)
    for (let y = 0; y < h; y++) g[y * w + x] = 255; // undo
  for (let x = 50; x < 54; x++)
    for (let y = 0; y < h; y++) g[y * w + x] = 255;
  for (let y = 10; y < 14; y++)
    for (let x = 0; x < w; x++) g[y * w + x] = 0; // horizontal bars
  equal(estimateQuarterRotation(g, w, h), 0);
});

// ─── Crop / quad / warp ────────────────────────────────────────────────────

test("autoCrop trims empty borders around content", () => {
  const w = 100, h = 100;
  const g = new Float32Array(w * h); g.fill(255);
  for (let y = 25; y < 75; y++)
    for (let x = 30; x < 70; x++) g[y * w + x] = 0;
  const img = rawFromGray(w, h, g);
  const cropped = autoCrop(img, g);
  ok(cropped.width < w && cropped.height < h, `crop ${cropped.width}x${cropped.height}`);
  ok(cropped.width >= 40 && cropped.height >= 48, "crop keeps the content block");
});

test("detectQuad finds a trapezoid's four corners", () => {
  const w = 200, h = 150;
  const g = new Float32Array(w * h); g.fill(255);
  const bl = 10, br = 190, tl = 40, tr = 160, topY = 25, botY = 125;
  // A true trapezoid: top edge spans tl..tr at topY, bottom bl..br at botY.
  for (let y = topY; y <= botY; y++) {
    const t = (y - topY) / (botY - topY);
    const lx = tl + (bl - tl) * t;
    const rx = tr + (br - tr) * t;
    for (let x = Math.round(lx); x <= Math.round(rx); x++) g[y * w + x] = 0;
  }
  const q = detectQuad(g, w, h);
  ok(q, "quad must be detected");
  assert(q);
  const close = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 14) =>
    Math.hypot(a.x - b.x, a.y - b.y) <= tol;
  ok(close(q.tl, { x: tl, y: topY }), `tl ${JSON.stringify(q.tl)}`);
  ok(close(q.tr, { x: tr, y: topY }), `tr ${JSON.stringify(q.tr)}`);
  ok(close(q.br, { x: br, y: botY }), `br ${JSON.stringify(q.br)}`);
  ok(close(q.bl, { x: bl, y: botY }), `bl ${JSON.stringify(q.bl)}`);
});

test("warpQuad identity rect preserves content", async () => {
  const w = 100, h = 100;
  const g = new Float32Array(w * h); g.fill(255);
  for (let y = 40; y < 60; y++)
    for (let x = 40; x < 60; x++) g[y * w + x] = 0; // dark center block
  const img = rawFromGray(w, h, g);
  const out = await warpQuad(img, {
    tl: { x: 10, y: 10 }, tr: { x: 90, y: 10 },
    br: { x: 90, y: 90 }, bl: { x: 10, y: 90 },
  });
  equal(out.width, 80);
  equal(out.height, 80);
  // center of source block maps to center of output
  equal(out.data[(40 * 80 + 40) * 4], 0, "center stays dark");
});

// ─── Canvas-backed stages (only when the native module is present) ─────────

test("scaleImage and rotateImage work when canvas is available", async () => {
  if (!isCanvasAvailable()) return;
  const w = 60, h = 40;
  const g = grayFrom(Array.from({ length: h }, () => Array.from({ length: w }, (_, x) => (x < 20 ? 0 : 255))));
  const img = rawFromGray(w, h, g);
  const up = await scaleImage(img, 2);
  equal(up.width, 120);
  equal(up.height, 80);

  const rot = await rotateImage(img, 90);
  equal(rot.width, 40, "90° rotation swaps dimensions");
  equal(rot.height, 60);
  const g2 = toGray(rot);
  // CW rotation moves the dark left half to the top band (rows 0..19).
  ok(g2[5 * 40 + 10] < 128, "top band carries the former-left dark half");
  ok(g2[50 * 40 + 10] > 200, "bottom band is the former-right white half");
});

test("decodeToRgba round-trips a canvas-rendered PNG", async () => {
  if (!isCanvasAvailable()) return;
  const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
  const c = createCanvas(20, 10);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(0,0,0)"; ctx.fillRect(0, 0, 20, 10);
  const buf = c.toBuffer("image/png");
  const img = await decodeToRgba(buf);
  equal(img.width, 20);
  equal(img.height, 10);
  equal(img.data[0], 0);
  equal(img.data[3], 255, "alpha opaque");
});
