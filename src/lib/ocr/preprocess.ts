/**
 * Image preprocessing for OCR — pure pixel-pipeline on top of @napi-rs/canvas.
 *
 * Tesseract is a page-segmentation engine: it assumes near-frontal, roughly
 * horizontal, ink-on-paper input. Real receipt photos break that assumption
 * (rotation, keystone, low contrast, noise, small text), so we normalize the
 * bitmap BEFORE handing it to the engine. Every step is conservative and
 * wrapped so a failure degrades to "pass the image through unchanged" — the
 * engine must never receive worse input than it does today.
 *
 * Pipeline (photo preset): decode → EXIF orientation → 90° orientation check →
 * perspective correction (best-effort) → deskew → auto-crop → contrast
 * stretch → sharpen → adaptive threshold → working-resolution resize.
 *
 * The "scan" preset (rendered PDF pages) skips the aggressive threshold and
 * perspective passes because page renders are already clean.
 */
import { createCanvas, loadImage } from "@/lib/pdf-canvas";
import { isCanvasAvailable } from "@/lib/pdf-canvas";

export { isCanvasAvailable };

export type OcrPreset = "photo" | "scan";

export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Working resolution: text should land in Tesseract's sweet spot (20–70px). */
const MAX_DIM = 2200;
const MIN_DIM = 900;

// ─── Decoding ─────────────────────────────────────────────────────────────

/**
 * Decode an encoded image (JPEG/PNG/WebP/GIF/…) into raw RGBA pixels.
 * NOTE: @napi-rs/canvas does NOT apply EXIF orientation, so callers must
 * call applyOrientation() with jpegOrientation() before processing.
 */
export async function decodeToRgba(buffer: Buffer): Promise<RawImage> {
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
  return { data, width, height };
}

// ─── EXIF orientation (JPEG) ───────────────────────────────────────────────

/**
 * Read the EXIF orientation tag (1–8) from a JPEG buffer. Returns 1 (normal)
 * when absent or unparseable. TIFF spec: IFD0 entry 0x0112.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1; // not a JPEG (SOI)
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = bytes[p + 1];
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    // Standalone markers carry no length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      p += 2;
      continue;
    }
    if (p + 2 + len > bytes.length) break;
    if (marker === 0xe1) {
      const seg = bytes.subarray(p + 4, p + 2 + len);
      // "Exif\0\0"
      if (
        seg[0] === 0x45 && seg[1] === 0x78 && seg[2] === 0x69 &&
        seg[3] === 0x66 && seg[4] === 0 && seg[5] === 0
      ) {
        return tiffOrientation(seg.subarray(6));
      }
    }
    p += 2 + len;
  }
  return 1;
}

function tiffOrientation(t: Uint8Array): number {
  const le = t[0] === 0x49 && t[1] === 0x49;
  const be = t[0] === 0x4d && t[1] === 0x4d;
  if (!le && !be) return 1;
  const u16 = (o: number) =>
    le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1];
  const u32 = (o: number) =>
    le
      ? t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)
      : (t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3];
  if (u16(2) !== 42) return 1;
  const ifd0 = u32(4);
  if (ifd0 + 2 > t.length - 2) return 1;
  const n = u16(ifd0);
  for (let i = 0; i < n; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 10 > t.length) break;
    if (u16(entry) === 0x0112) {
      const v = u16(entry + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** Apply EXIF orientation (1–8) to RGBA pixels. Returns a new image. */
export function applyOrientation(img: RawImage, orientation: number): RawImage {
  if (orientation <= 1) return img;
  const { data, width: w, height: h } = img;

  if (orientation === 3) {
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        const d = ((h - 1 - y) * w + (w - 1 - x)) * 4;
        out[d] = data[s]; out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
      }
    return { data: out, width: w, height: h };
  }

  if (orientation === 6 || orientation === 8) {
    const rot90 = orientation === 6; // 90° CW (6) vs 270° CW (8)
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        let dx: number, dy: number;
        if (rot90) { dx = h - 1 - y; dy = x; }
        else { dx = y; dy = w - 1 - x; }
        const d = (dy * h + dx) * 4;
        out[d] = data[s]; out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
      }
    return { data: out, width: h, height: w };
  }

  if (orientation === 2 || orientation === 4) {
    const flipH = orientation === 2;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        const nx = flipH ? w - 1 - x : x;
        const ny = flipH ? y : h - 1 - y;
        const d = (ny * w + nx) * 4;
        out[d] = data[s]; out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
      }
    return { data: out, width: w, height: h };
  }

  // 5 (transpose) = rotate 90 CW then flip H; 7 (transverse) = rotate 270 CW then flip H.
  const rotated = applyOrientation({ data, width: w, height: h }, orientation === 5 ? 6 : 8);
  return applyOrientation(rotated, 2);
}

// ─── Grayscale + statistics ───────────────────────────────────────────────

export function toGray(img: RawImage): Float32Array {
  const { data, width: w, height: h } = img;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return g;
}

export function rgbaFromGray(width: number, height: number, gray: Float32Array): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i])));
    const j = i * 4;
    data[j] = v; data[j + 1] = v; data[j + 2] = v; data[j + 3] = 255;
  }
  return { data, width, height };
}

/** Global threshold via Otsu's method (maximizes inter-class variance). */
export function otsuThreshold(gray: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) {
    const v = Math.max(0, Math.min(255, gray[i] | 0));
    hist[v]++;
  }
  const total = gray.length;
  if (total === 0) return 128;
  let sum = 0;
  for (let b = 0; b < 256; b++) sum += b * hist[b];
  let sumB = 0, wB = 0;
  let best = 128, maxVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; best = t; }
  }
  return best;
}

/**
 * Bradley adaptive threshold: each pixel is compared against the mean of its
 * neighborhood (integral image), which rescues low-contrast thermal prints and
 * uneven lighting. Output is Uint8 0 (ink) / 255 (paper).
 */
export function adaptiveThreshold(gray: Float32Array, width: number, height: number): Uint8Array {
  const half = Math.max(7, Math.min(40, Math.round(Math.min(width, height) / 16)));
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    const rowBase = (y + 1) * (width + 1);
    const prevBase = y * (width + 1);
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[rowBase + x + 1] = integral[prevBase + x + 1] + rowSum;
    }
  }
  const out = new Uint8Array(width * height);
  const T = 0.15; // pixels darker than (1 - T) × local mean become ink
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(height, y + half);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(width, x + half);
      const b0 = y0 * (width + 1), b1 = y1 * (width + 1);
      const sum =
        integral[b1 + x1] - integral[b1 + x0] -
        integral[b0 + x1] + integral[b0 + x0];
      const n = (x1 - x0) * (y1 - y0);
      const v = gray[y * width + x];
      out[y * width + x] = v * n >= sum * (1 - T) ? 255 : 0;
    }
  }
  return out;
}

/** Percentile-based linear contrast stretch (robust to outliers). */
export function contrastStretch(
  gray: Float32Array,
  loPct = 0.005,
  hiPct = 0.995
): Float32Array {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) {
    const v = Math.max(0, Math.min(255, gray[i] | 0));
    hist[v]++;
  }
  const total = gray.length;
  const loTarget = total * loPct, hiTarget = total * hiPct;
  let lo = 0, hi = 255, cum = 0;
  for (let b = 0; b < 256; b++) { cum += hist[b]; if (cum >= loTarget) { lo = b; break; } }
  cum = 0;
  for (let b = 0; b < 256; b++) { cum += hist[b]; if (cum >= hiTarget) { hi = b; break; } }
  if (hi - lo < 15) { lo = 0; hi = 255; } // near-constant image; no-op
  const span = hi - lo || 1;
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = ((Math.max(lo, Math.min(hi, gray[i])) - lo) * 255) / span;
  }
  return out;
}

/** 3×3 unsharp-mask sharpening — crispens edges without ringing on binarized text. */
export function sharpenGray(gray: Float32Array, width: number, height: number, amount = 0.7): Float32Array {
  const out = new Float32Array(gray);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const blur =
        (gray[i - width - 1] + gray[i - width] + gray[i - width + 1] +
          gray[i - 1] + gray[i] + gray[i + 1] +
          gray[i + width - 1] + gray[i + width] + gray[i + width + 1]) / 9;
      out[i] = gray[i] + amount * (gray[i] - blur);
    }
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0, Math.min(255, out[i]));
  }
  return out;
}

// ─── Scaling / rotation (canvas-backed) ────────────────────────────────────

export function canvasFromImage(img: RawImage) {
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(img.width, img.height);
  imageData.data.set(
    img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data)
  );
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export async function scaleImage(img: RawImage, scale: number): Promise<RawImage> {
  if (Math.abs(scale - 1) < 0.001) return img;
  const w = Math.max(2, Math.round(img.width * scale));
  const h = Math.max(2, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(canvasFromImage(img), 0, 0, w, h);
  const { data, width, height } = ctx.getImageData(0, 0, w, h);
  return { data, width, height };
}

export async function rotateImage(img: RawImage, angleDeg: number): Promise<RawImage> {
  if (Math.abs(angleDeg) < 0.05) return img;
  const w = img.width, h = img.height;
  // Exact quarter turns swap the canvas dimensions so content is never clipped.
  const a = ((angleDeg % 360) + 360) % 360;
  const swap = Math.abs(a - 90) < 2 || Math.abs(a - 270) < 2;
  const cw = swap ? h : w;
  const ch = swap ? w : h;
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(canvasFromImage(img), -w / 2, -h / 2);
  const { data, width, height } = ctx.getImageData(0, 0, cw, ch);
  return { data, width, height };
}

// ─── 90° orientation + deskew (projection-profile) ─────────────────────────

/**
 * Decide whether the page is rotated 90°/270°: for horizontal text the row
 * projection is "banded" (high variance), for vertical text the column
 * projection is. Returns degrees to rotate CW, or 0.
 */
export function estimateQuarterRotation(gray: Float32Array, width: number, height: number): number {
  const scale = Math.min(1, 320 / Math.max(width, height));
  const dw = Math.max(2, Math.round(width * scale));
  const dh = Math.max(2, Math.round(height * scale));
  const small = downsampleGray(gray, width, height, dw, dh);
  const rowVar = rowProjectionVariance(small, dw, dh, true);
  const colVar = rowProjectionVariance(small, dw, dh, false);
  // Text present only when the dominant axis carries clear banding.
  if (colVar > rowVar * 1.6 && colVar > 0) return 90; // lines are vertical → rotate CW
  return 0;
}

/**
 * Estimate the fine rotation angle by maximizing the horizontal-projection
 * variance over a coarse→fine sweep. Positive = clockwise (as displayed).
 */
export function estimateSkewAngle(gray: Float32Array, width: number, height: number): number {
  const scale = Math.min(1, 320 / Math.max(width, height));
  const dw = Math.max(2, Math.round(width * scale));
  const dh = Math.max(2, Math.round(height * scale));
  const small = downsampleGray(gray, width, height, dw, dh);

  let best = 0, bestScore = -1;
  for (let a = -8; a <= 8.001; a += 0.5) {
    const r = rotateSampleNearest(small, dw, dh, a);
    const v = rowProjectionVariance(r, dw, dh, true);
    if (v > bestScore) { bestScore = v; best = a; }
  }
  for (const a of [best - 0.25, best + 0.25, best + 0.15, best - 0.15]) {
    const r = rotateSampleNearest(small, dw, dh, a);
    const v = rowProjectionVariance(r, dw, dh, true);
    if (v > bestScore) { bestScore = v; best = a; }
  }
  return Math.abs(best) < 0.3 ? 0 : best;
}

function rowProjectionVariance(gray: Float32Array, w: number, h: number, rows: boolean): number {
  const n = rows ? h : w;
  const sums = new Float64Array(n);
  if (rows) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      const base = y * w;
      for (let x = 0; x < w; x++) s += 255 - gray[base + x];
      sums[y] = s;
    }
  } else {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 0; y < h; y++) s += 255 - gray[y * w + x];
      sums[x] = s;
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sums[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (sums[i] - mean) * (sums[i] - mean);
  return v / n;
}

/** Nearest-neighbor rotation of a small grayscale image (white fill). */
function rotateSampleNearest(gray: Float32Array, w: number, h: number, angleDeg: number): Float32Array {
  const rad = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = w / 2, cy = h / 2;
  const out = new Float32Array(w * h);
  out.fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      const xi = sx | 0, yi = sy | 0;
      if (xi >= 0 && xi < w && yi >= 0 && yi < h) {
        out[y * w + x] = gray[yi * w + xi];
      }
    }
  }
  return out;
}

/** Box-average downscale (reduces aliasing for profile computations). */
export function downsampleGray(gray: Float32Array, w: number, h: number, dw: number, dh: number): Float32Array {
  if (dw === w && dh === h) return gray;
  const out = new Float32Array(dw * dh);
  const sx = w / dw, sy = h / dh;
  for (let oy = 0; oy < dh; oy++) {
    const y0 = Math.floor(oy * sy), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * sy));
    for (let ox = 0; ox < dw; ox++) {
      const x0 = Math.floor(ox * sx), x1 = Math.max(x0 + 1, Math.floor((ox + 1) * sx));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) { sum += gray[y * w + x]; n++; }
      out[oy * dw + ox] = n ? sum / n : 255;
    }
  }
  return out;
}

// ─── Auto-crop ─────────────────────────────────────────────────────────────

/**
 * Crop to the ink bounding box (Otsu mask) with a small margin. Conservative:
 * never crops away more than 90% or less than 2% of the image.
 */
export function autoCrop(img: RawImage, gray?: Float32Array): RawImage {
  const g = gray ?? toGray(img);
  const { width: w, height: h } = img;
  const th = otsuThreshold(g);
  const minRow = Math.max(1, Math.floor(h * 0.003));
  const minCol = Math.max(1, Math.floor(w * 0.003));

  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = 0; y < h; y++) {
    let c = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) if (g[base + x] <= th) c++;
    if (c >= minRow) { if (top === -1) top = y; bottom = y; }
  }
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) if (g[y * w + x] <= th) c++;
    if (c >= minCol) { if (left === -1) left = x; right = x; }
  }
  if (top === -1 || bottom === -1 || left === -1 || right === -1) return img;

  const margin = Math.max(4, Math.round(0.015 * Math.min(w, h)));
  const x0 = Math.max(0, left - margin);
  const y0 = Math.max(0, top - margin);
  const x1 = Math.min(w, right + margin);
  const y1 = Math.min(h, bottom + margin);
  const area = (x1 - x0) * (y1 - y0);
  const total = w * h;
  if (area > total * 0.985 || area < total * 0.02) return img;
  return subImage(img, x0, y0, x1, y1);
}

function subImage(img: RawImage, x0: number, y0: number, x1: number, y1: number): RawImage {
  const w = x1 - x0, h = y1 - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcBase = (y0 + y) * img.width * 4 + x0 * 4;
    const dstBase = y * w * 4;
    for (let x = 0; x < w * 4; x++) data[dstBase + x] = img.data[srcBase + x];
  }
  return { data, width: w, height: h };
}

// ─── Perspective correction (best-effort) ──────────────────────────────────

export interface Pt { x: number; y: number }
export interface Quad { tl: Pt; tr: Pt; br: Pt; bl: Pt }

interface Line { pt: Pt; dir: Pt }

/**
 * Detect the document quad from the ink boundary: leftmost/rightmost ink per
 * row and topmost/bottommost per column, fit with outlier-trimmed least
 * squares, intersect the 4 lines. Returns null when the quad is not confident
 * (sparse ink, non-linear edges, tiny area) so we never warp garbage.
 */
export function detectQuad(gray: Float32Array, w: number, h: number): Quad | null {
  const scale = Math.min(1, 480 / Math.max(w, h));
  const dw = Math.max(2, Math.round(w * scale));
  const dh = Math.max(2, Math.round(h * scale));
  const small = downsampleGray(gray, w, h, dw, dh);
  const th = otsuThreshold(small);

  const left: Pt[] = [], right: Pt[] = [];
  for (let y = 0; y < dh; y++) {
    let l = -1, r = -1;
    const base = y * dw;
    for (let x = 0; x < dw; x++) if (small[base + x] <= th) { l = x; break; }
    for (let x = dw - 1; x >= 0; x--) if (small[base + x] <= th) { r = x; break; }
    if (l >= 0 && r >= 0 && r - l > 2) { left.push({ x: l, y }); right.push({ x: r, y }); }
  }
  const top: Pt[] = [], bot: Pt[] = [];
  for (let x = 0; x < dw; x++) {
    let t = -1, b = -1;
    for (let y = 0; y < dh; y++) if (small[y * dw + x] <= th) { t = y; break; }
    for (let y = dh - 1; y >= 0; y--) if (small[y * dw + x] <= th) { b = y; break; }
    if (t >= 0 && b >= 0 && b - t > 2) { top.push({ x, y: t }); bot.push({ x, y: b }); }
  }
  if (left.length < dh * 0.3 || right.length < dh * 0.3 ||
      top.length < dw * 0.3 || bot.length < dw * 0.3) return null;

  const fitX = (pts: Pt[]): Line | null => fitBoundary(pts, true);
  const fitY = (pts: Pt[]): Line | null => fitBoundary(pts, false);
  const l = fitX(left), r = fitX(right), t = fitY(top), b = fitY(bot);
  if (!l || !r || !t || !b) return null;

  const tl = intersectLines(t, l), tr = intersectLines(t, r);
  const br = intersectLines(b, r), bl = intersectLines(b, l);
  if (!tl || !tr || !br || !bl) return null;

  const area = quadArea(tl, tr, br, bl);
  if (area < 0.3 * dw * dh || !Number.isFinite(area)) return null;

  // Straightness gate: robust median orthogonal residual must stay small.
  const res =
    (residual(left, l) + residual(right, r) +
      residual(top, t) + residual(bot, b)) / 4;
  if (res > 0.18 * Math.max(dw, dh)) return null;

  const s = 1 / scale;
  return {
    tl: { x: tl.x * s, y: tl.y * s },
    tr: { x: tr.x * s, y: tr.y * s },
    br: { x: br.x * s, y: br.y * s },
    bl: { x: bl.x * s, y: bl.y * s },
  };
}

/** Fit a robust line through boundary points via Theil-Sen (median of pairwise slopes). */
function fitBoundary(pts: Pt[], xAsFnOfY: boolean): Line | null {
  if (pts.length < 4) return null;
  const as = pts.map((p) => (xAsFnOfY ? p.y : p.x));
  const bs = pts.map((p) => (xAsFnOfY ? p.x : p.y));
  const n = as.length;

  // Median of all pairwise slopes (O(n²), robust to side-edge outliers on the
  // top/bottom scans of a keystone document).
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = as[j] - as[i];
      if (Math.abs(d) > 1e-9) slopes.push((bs[j] - bs[i]) / d);
    }
  }
  if (slopes.length === 0) return null;
  const m = median(slopes);

  const intercepts: number[] = [];
  for (let i = 0; i < n; i++) intercepts.push(bs[i] - m * as[i]);
  const c = median(intercepts);
  if (!Number.isFinite(m) || !Number.isFinite(c)) return null;

  const am = median(as);
  if (xAsFnOfY) {
    const dir = normalize(m, 1);
    return { pt: { x: m * am + c, y: am }, dir };
  }
  const dir = normalize(1, m);
  return { pt: { x: am, y: m * am + c }, dir };
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function normalize(x: number, y: number): Pt {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function intersectLines(l1: Line, l2: Line): Pt | null {
  const denom = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t =
    ((l2.pt.x - l1.pt.x) * l2.dir.y - (l2.pt.y - l1.pt.y) * l2.dir.x) / denom;
  return { x: l1.pt.x + t * l1.dir.x, y: l1.pt.y + t * l1.dir.y };
}

/** Median orthogonal distance of points from a fitted line (robust to outliers). */
function residual(pts: Pt[], line: Line): number {
  if (pts.length === 0) return 0;
  const cross: number[] = [];
  for (const p of pts) {
    const dx = p.x - line.pt.x, dy = p.y - line.pt.y;
    cross.push(Math.abs(dx * line.dir.y - dy * line.dir.x));
  }
  return median(cross);
}

function quadArea(tl: Pt, tr: Pt, br: Pt, bl: Pt): number {
  const shoelace =
    tl.x * tr.y + tr.x * br.y + br.x * bl.y + bl.x * tl.y -
    (tr.x * tl.y + br.x * tr.y + bl.x * br.y + tl.x * bl.y);
  return Math.abs(shoelace) / 2;
}

/** Mean distance of quad corners from their axis-aligned bounding rect. */
export function quadDeviation(q: Quad): number {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x];
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y];
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const rect = [
    { x: x0, y: y0 }, { x: x1, y: y0 },
    { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  let sum = 0;
  const corners = [q.tl, q.tr, q.br, q.bl];
  for (let i = 0; i < 4; i++) {
    sum += Math.hypot(corners[i].x - rect[i].x, corners[i].y - rect[i].y);
  }
  return sum / 4;
}

/**
 * Warp a quad to an upright rectangle with bilinear sampling (the standard
 * 4-point distortion). Corrects keystone/perspective without an explicit
 * homography solve.
 */
export async function warpQuad(img: RawImage, q: Quad): Promise<RawImage> {
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const ow = Math.max(2, Math.min(4096, Math.round(Math.max(dist(q.tl, q.tr), dist(q.bl, q.br)))));
  const oh = Math.max(2, Math.min(4096, Math.round(Math.max(dist(q.tl, q.bl), dist(q.tr, q.br)))));
  const { data, width: sw, height: sh } = img;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  for (let vy = 0; vy < oh; vy++) {
    const t = oh > 1 ? vy / (oh - 1) : 0;
    const topE = lerp(q.tl, q.tr, t);
    const botE = lerp(q.bl, q.br, t);
    for (let vx = 0; vx < ow; vx++) {
      const s = ow > 1 ? vx / (ow - 1) : 0;
      const p = lerp(topE, botE, s);
      const x = Math.max(0, Math.min(sw - 1, p.x));
      const y = Math.max(0, Math.min(sh - 1, p.y));
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const d = (vy * ow + vx) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
        const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
        out[d + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { data: out, width: ow, height: oh };
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Normalize an image for OCR. Conservative: every transformative stage is
 * skipped when its own quality gate fails, and the whole pipeline degrades to
 * the input when canvas ops are unavailable.
 */
export async function preprocessImage(img: RawImage, preset: OcrPreset): Promise<RawImage> {
  if (!isCanvasAvailable()) return img;

  // Working resolution: cap huge photos, upscale tiny ones (text height).
  let cur = img;
  const maxDim = Math.max(cur.width, cur.height);
  const minDim = Math.min(cur.width, cur.height);
  let scale = 1;
  if (maxDim > MAX_DIM) scale = MAX_DIM / maxDim;
  else if (minDim < MIN_DIM) scale = Math.min(3, MIN_DIM / minDim);
  if (scale !== 1 && scale > 0.05) cur = await scaleImage(cur, scale);

  let gray = toGray(cur);

  // 90°/270° orientation (text lines vertical).
  const qrot = estimateQuarterRotation(gray, cur.width, cur.height);
  if (qrot) { cur = await rotateImage(cur, qrot); gray = toGray(cur); }

  // Perspective correction (photo only, gated on a confident quad).
  if (preset === "photo") {
    const quad = detectQuad(gray, cur.width, cur.height);
    const devThreshold = Math.max(8, 0.02 * Math.min(cur.width, cur.height));
    if (quad && quadDeviation(quad) > devThreshold) {
      try {
        cur = await warpQuad(cur, quad);
        gray = toGray(cur);
      } catch { /* keep the pre-warp image */ }
    }
  }

  // Deskew.
  const angle = estimateSkewAngle(gray, cur.width, cur.height);
  if (Math.abs(angle) >= 0.3) { cur = await rotateImage(cur, angle); gray = toGray(cur); }

  // Crop to content.
  const cropped = autoCrop(cur, gray);
  cur = cropped;
  gray = toGray(cur);

  // Contrast, sharpen, then threshold (or grayscale for scans).
  gray = contrastStretch(gray);
  gray = sharpenGray(gray, cur.width, cur.height);

  if (preset === "photo") {
    const bin = adaptiveThreshold(gray, cur.width, cur.height);
    return binToRgba(cur.width, cur.height, bin);
  }
  // Scans: keep grayscale; binarize only when still low-contrast.
  let variance = 0, mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i];
  mean /= gray.length;
  for (let i = 0; i < gray.length; i++) variance += (gray[i] - mean) * (gray[i] - mean);
  variance /= gray.length;
  if (Math.sqrt(variance) < 30) {
    const bin = adaptiveThreshold(gray, cur.width, cur.height);
    return binToRgba(cur.width, cur.height, bin);
  }
  return rgbaFromGray(cur.width, cur.height, gray);
}

function binToRgba(w: number, h: number, bin: Uint8Array): RawImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = bin[i];
    const j = i * 4;
    data[j] = v; data[j + 1] = v; data[j + 2] = v; data[j + 3] = 255;
  }
  return { data, width: w, height: h };
}

/** Full photo entry point: decode → orient → preprocess → PNG bytes. */
export async function preprocessBuffer(
  buffer: Buffer,
  preset: OcrPreset = "photo"
): Promise<RawImage> {
  const img = await decodeToRgba(buffer);
  const oriented = applyOrientation(img, jpegOrientation(new Uint8Array(buffer)));
  return preprocessImage(oriented, preset);
}
