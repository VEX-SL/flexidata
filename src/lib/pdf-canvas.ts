// Canvas abstraction — tries @napi-rs/canvas (native), falls back to null
// eslint-disable-next-line @typescript-eslint/no-require-imports
let _canvas: any = null;
try {
  _canvas = require("@napi-rs/canvas");
} catch {
  // Native canvas not available (e.g. Vercel Linux). OCR for scanned PDFs will be skipped.
}

export function createCanvas(width: number, height: number) {
  if (!_canvas) throw new Error("Canvas not available — native module @napi-rs/canvas not installed");
  return _canvas.createCanvas(width, height);
}

export function isCanvasAvailable(): boolean {
  return _canvas !== null;
}

/** Decode an encoded image buffer into a canvas Image (no EXIF applied). */
export function loadImage(source: Buffer | Uint8Array | string) {
  if (!_canvas) throw new Error("Canvas not available — native module @napi-rs/canvas not installed");
  return _canvas.loadImage(source);
}
