import type { BBox, OcrLine } from "./types";

/**
 * Generic box helpers shared by the OCR engine and the evidence layer.
 * Boxes live in the processed-image coordinate space (pixels).
 */

/** Union of boxes → the smallest box enclosing all of them. */
export function unionBoxes(boxes: BBox[]): BBox | undefined {
  if (boxes.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Union box over a contiguous range of a line's words. */
export function spanBox(
  line: OcrLine,
  start: number,
  end: number
): BBox | undefined {
  const boxes: BBox[] = [];
  for (let i = start; i <= end; i++) {
    const b = line.words[i]?.bbox;
    if (b) boxes.push(b);
  }
  return unionBoxes(boxes);
}
