/**
 * Image dimensions from raw bytes — dependency-free PNG / JPEG / GIF / WebP /
 * BMP header parsing. Used to convert a Vision model's normalized line
 * bounding boxes (0..1000 image space) into the pixel-space BBox the pipeline
 * inspector consumes. Returns null for unsupported or truncated headers so
 * callers keep a graceful no-geometry fallback.
 */

export interface ImageDimensions {
  w: number;
  h: number;
}

/** Decode image dimensions from a raw image buffer, or null when unknown. */
export function imageDimensionsFromBuffer(buf: Uint8Array): ImageDimensions | null {
  try {
    return (
      tryPng(buf) ??
      tryJpeg(buf) ??
      tryGif(buf) ??
      tryWebp(buf) ??
      tryBmp(buf) ??
      null
    );
  } catch {
    return null;
  }
}

function tryPng(buf: Uint8Array): ImageDimensions | null {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return null;
  if (buf.length < 24) return null;
  // IHDR: width (BE) at 16, height (BE) at 20.
  const w = buf[16] * 0x1000000 + buf[17] * 0x10000 + buf[18] * 0x100 + buf[19];
  const h = buf[20] * 0x1000000 + buf[21] * 0x10000 + buf[22] * 0x100 + buf[23];
  return w > 0 && h > 0 ? { w, h } : null;
}

function tryJpeg(buf: Uint8Array): ImageDimensions | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  let guard = 0;
  while (i + 9 < buf.length && guard++ < 64) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    // Advance past any run of fill bytes (0xFF).
    while (buf[i] === 0xff) i++;
    const marker = buf[i++];
    if (marker === 0xd8 || marker === 0x01) continue;
    const len = (buf[i] << 8) | buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // SOFn: precision(1) at i+2, height(2) at i+3, width(2) at i+5.
      const h = (buf[i + 3] << 8) | buf[i + 4];
      const w = (buf[i + 5] << 8) | buf[i + 6];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += Math.max(2, len); // len includes its own 2 bytes
  }
  return null;
}

function tryGif(buf: Uint8Array): ImageDimensions | null {
  const header = String.fromCharCode(buf[0], buf[1], buf[2]) === "GIF";
  if (!header) return null;
  if (buf.length < 10) return null;
  const w = buf[6] | (buf[7] << 8);
  const h = buf[8] | (buf[9] << 8);
  return w > 0 && h > 0 ? { w, h } : null;
}

function tryWebp(buf: Uint8Array): ImageDimensions | null {
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "RIFF") return null;
  if (String.fromCharCode(buf[8], buf[9], buf[10], buf[11]) !== "WEBP") return null;
  // Chunk header: tag(4) + size(4) after the RIFF/WEBP prefix (12 bytes).
  const tag = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
  // Chunk payload begins at 20.
  if (tag === "VP8X") {
    const w = readUInt24LE(buf, 24) + 1;
    const h = readUInt24LE(buf, 27) + 1;
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (tag === "VP8L") {
    // Signature byte at 20, then 4 bytes of packed 14-bit dimensions.
    if (buf[20] !== 0x2f) return null;
    const v = readUInt32LE(buf, 21);
    const w = (v & 0x3fff) + 1;
    const h = ((v >> 14) & 0x3fff) + 1;
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (tag === "VP8 ") {
    // VP8 frame tag (3 bytes) then 2-byte width/height (LE).
    const w = buf[23] | (buf[24] << 8);
    const h = buf[25] | (buf[26] << 8);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  return null;
}

function tryBmp(buf: Uint8Array): ImageDimensions | null {
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return null; // "BM"
  if (buf.length < 26) return null;
  let w = readInt32LE(buf, 18);
  let h = readInt32LE(buf, 22);
  if (w < 0) w = -w;
  if (h < 0) h = -h;
  return w > 0 && h > 0 ? { w, h } : null;
}

function readUInt24LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
}

function readUInt32LE(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function readInt32LE(buf: Uint8Array, off: number): number {
  const v = readUInt32LE(buf, off);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}