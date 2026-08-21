import type { BBox } from "@/lib/pipeline/types";

/**
 * Normalized bounding box in the standard `[ymin, xmin, ymax, xmax]` layout,
 * scaled to 0..1000 (or 0..1). This is the coordinate space the BBox overlay
 * consumes; every concrete source (OCR word boxes, evidence spans) is mapped
 * into it before reaching the UI.
 */
export interface NormalizedBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

/** CSS-percentage box, used to position overlay elements over the image. */
export interface PercentageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type NormalizedBoxInput = NormalizedBox | [number, number, number, number];

/**
 * Convert a normalized box ([ymin, xmin, ymax, xmax], scale 0..1000 or 0..1)
 * into a CSS-percentage box ({left, top, width, height}, each 0..100).
 * Scale is auto-detected: values ≤ 1 are treated as 0..1, larger as 0..1000.
 */
export function normalizedToPercentageBBox(
  box: NormalizedBoxInput,
  scale?: number
): PercentageBox {
  const a = Array.isArray(box) ? box : [box.ymin, box.xmin, box.ymax, box.xmax];
  const [ymin, xmin, ymax, xmax] = a.map(Number);
  if (![ymin, xmin, ymax, xmax].every((n) => Number.isFinite(n))) {
    throw new TypeError("normalized bbox must contain four finite numbers");
  }
  const s =
    scale ?? (Math.max(ymin, xmin, ymax, xmax) <= 1 ? 1 : 1000);
  if (s <= 0 || !Number.isFinite(s)) {
    throw new RangeError(`invalid bbox scale: ${s}`);
  }
  const n = (v: number) => (v / s) * 100;
  const left = n(xmin);
  const top = n(ymin);
  const width = Math.max(0, n(xmax) - left);
  const height = Math.max(0, n(ymax) - top);
  return { left, top, width, height };
}

/** Convert a pixel-space box into the normalized 0..1000 space. */
export function pixelBBoxToNormalized(
  box: BBox,
  imgWidth: number,
  imgHeight: number
): NormalizedBox {
  if (
    !Number.isFinite(imgWidth) ||
    !Number.isFinite(imgHeight) ||
    imgWidth <= 0 ||
    imgHeight <= 0
  ) {
    throw new RangeError("image dimensions must be positive finite numbers");
  }
  return {
    ymin: (box.y / imgHeight) * 1000,
    xmin: (box.x / imgWidth) * 1000,
    ymax: ((box.y + box.height) / imgHeight) * 1000,
    xmax: ((box.x + box.width) / imgWidth) * 1000,
  };
}

/** Union of zero or more pixel-space boxes; null when empty. */
export function unionPixelBoxes(boxes: BBox[]): BBox | null {
  if (boxes.length === 0) return null;
  let x = Infinity;
  let y = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    if (b.width <= 0 || b.height <= 0) continue;
    x = Math.min(x, b.x);
    y = Math.min(y, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * Greedy tolerant word-span matcher: find the contiguous word range whose
 * concatenated text covers `quote` (whitespace-insensitive). Used to lift a
 * field's evidence quote onto the exact OCR word boxes. Returns [] when no
 * span reaches a credible coverage share.
 */
export function matchQuoteWords(
  words: Array<{ text: string; bbox?: BBox }>,
  quote: string
): Array<{ text: string; bbox?: BBox }> {
  const target = quote.replace(/\s+/g, " ").trim();
  if (!target) return [];
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const texts = words.map((w) => norm(w.text));

  let best: Array<{ text: string; bbox?: BBox }> = [];
  let bestCover = 0;
  for (let start = 0; start < words.length; start++) {
    let acc = "";
    const picked: Array<{ text: string; bbox?: BBox }> = [];
    for (let i = start; i < words.length; i++) {
      const piece = texts[i];
      if (!piece) break;
      const joined = (acc ? acc + " " : "") + piece;
      if (!target.startsWith(norm(joined))) {
        if (acc && target.startsWith(piece) && acc.length > target.length) break;
        if (!target.startsWith(norm(joined))) continue;
      }
      acc = joined;
      picked.push(words[i]);
      if (norm(acc).length >= target.length) break;
    }
    if (!acc) continue;
    const cover = Math.min(1, norm(acc).length / Math.max(1, target.length));
    if (cover > bestCover) {
      bestCover = cover;
      best = picked;
    }
    if (cover >= 1) break;
  }
  return bestCover >= 0.6 ? best : [];
}

/** Confidence color coding: ≥0.85 green, 0.50–0.84 amber, <0.50 red. */
export function confidenceColor(confidence: number): string {
  if (!Number.isFinite(confidence)) return "#EF4444";
  if (confidence >= 0.85) return "#22C55E";
  if (confidence >= 0.5) return "#F59E0B";
  return "#EF4444";
}

/** Tone used to group fields in the sidebar. */
export type FieldTone = "verified" | "uncertain" | "missing";

export function fieldTone(
  confidence: number,
  hasValue: boolean
): FieldTone {
  if (!hasValue) return "missing";
  return confidence >= 0.85 ? "verified" : "uncertain";
}

/** State class for an overlay box / sidebar row (bidirectional highlight). */
export function bboxStateClass(active: boolean, hovered: boolean): string {
  if (active) return "fd-inspector-box fd-inspector-box--active";
  if (hovered) return "fd-inspector-box fd-inspector-box--hovered";
  return "fd-inspector-box";
}

/** State class for a sidebar row (mirror of the overlay highlight). */
export function rowStateClass(active: boolean, hovered: boolean): string {
  if (active) return "fd-inspector-row fd-inspector-row--active";
  if (hovered) return "fd-inspector-row fd-inspector-row--hovered";
  return "fd-inspector-row";
}

/**
 * Hit-test: first normalized box (overlay order) containing the point.
 * Both the point and the boxes live in the 0..1000 normalized space.
 */
export function findBoxAt(
  boxes: Array<{ id: string; box: NormalizedBox }>,
  x: number,
  y: number
): string | null {
  for (const b of boxes) {
    const box = b.box;
    if (x >= box.xmin && x <= box.xmax && y >= box.ymin && y <= box.ymax) {
      return b.id;
    }
  }
  return null;
}
