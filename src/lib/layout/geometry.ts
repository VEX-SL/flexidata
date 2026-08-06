/**
 * Layout geometry primitives and operations.
 *
 * The layout layer's coordinate model reuses the pipeline's `BBox`
 * (x/y/width/height, coordinate-space agnostic) instead of introducing a
 * parallel box type. `unionBoxes` is reused from the pipeline geometry module
 * — nothing here duplicates it.
 *
 * Determinism contract: every function is a pure function of its inputs;
 * float edge cases (touching boxes, zero-area boxes) have fixed semantics
 * defined below.
 */
import type { BBox } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";

/** A point in page coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Create an immutable point. */
export function makePoint(x: number, y: number): Point {
  return Object.freeze({ x, y });
}

export function pointEquals(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Euclidean distance between two points. */
export function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Center point of a box. */
export function boxCenter(box: BBox): Point {
  return makePoint(box.x + box.width / 2, box.y + box.height / 2);
}

/** Euclidean distance between two box centers. */
export function centerDistance(a: BBox, b: BBox): number {
  return pointDistance(boxCenter(a), boxCenter(b));
}

/**
 * Minimum Euclidean distance between two axis-aligned boxes (0 when they
 * overlap or touch). For a point query pass a zero-size box.
 */
export function boxesDistance(a: BBox, b: BBox): number {
  return Math.hypot(horizontalGap(a, b), verticalGap(a, b));
}

/** True when the point lies inside the box (edges inclusive). */
export function pointInBox(p: Point, box: BBox): boolean {
  return (
    p.x >= box.x &&
    p.x <= box.x + box.width &&
    p.y >= box.y &&
    p.y <= box.y + box.height
  );
}

/** True when the two boxes share area (touching edges do not count). */
export function boxesIntersect(a: BBox, b: BBox): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** True when `outer` fully contains `inner` (edges inclusive). */
export function boxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

/** Intersection box of two boxes, or null when they do not overlap. */
export function boxIntersection(a: BBox, b: BBox): BBox | null {
  if (!boxesIntersect(a, b)) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return Object.freeze({ x, y, width: x2 - x, height: y2 - y });
}

export function boxArea(box: BBox): number {
  return box.width * box.height;
}

/** Area of the intersection of two boxes (0 when they do not overlap). */
export function intersectionArea(a: BBox, b: BBox): number {
  const inter = boxIntersection(a, b);
  return inter ? boxArea(inter) : 0;
}

/** Intersection over union; 0 when the boxes do not overlap. */
export function iou(a: BBox, b: BBox): number {
  const inter = intersectionArea(a, b);
  if (inter <= 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  if (union <= 0) return 0;
  return inter / union;
}

/** Shared x-extent length (0 when the boxes are horizontally apart). */
export function horizontalOverlap(a: BBox, b: BBox): number {
  return Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
}

/** Shared y-extent length (0 when the boxes are vertically apart). */
export function verticalOverlap(a: BBox, b: BBox): number {
  return Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  );
}

/**
 * Horizontal edge-to-edge gap between two boxes: the x-distance separating
 * their x-extents (0 when they touch or overlap horizontally).
 */
export function horizontalGap(a: BBox, b: BBox): number {
  return Math.max(
    0,
    Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)
  );
}

/**
 * Vertical edge-to-edge gap between two boxes: the y-distance separating
 * their y-extents (0 when they touch or overlap vertically).
 */
export function verticalGap(a: BBox, b: BBox): number {
  return Math.max(
    0,
    Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height)
  );
}

/**
 * Horizontal overlap relative to the smaller width: 1 when one box fully
 * spans the other's x-extent, 0 when they are horizontally apart. A zero-width
 * box counts as fully overlapped when its x-coordinate lies inside the other
 * box's x-range (point-in-range semantics for degenerate boxes).
 */
export function horizontalOverlapRatio(a: BBox, b: BBox): number {
  return axisOverlapRatio(a.x, a.width, b.x, b.width);
}

/**
 * Vertical overlap relative to the smaller height: 1 when one box fully
 * spans the other's y-extent, 0 when they are vertically apart. A zero-height
 * box counts as fully overlapped when its y-coordinate lies inside the other
 * box's y-range (point-in-range semantics for degenerate boxes).
 */
export function verticalOverlapRatio(a: BBox, b: BBox): number {
  return axisOverlapRatio(a.y, a.height, b.y, b.height);
}

function axisOverlapRatio(
  a: number,
  aw: number,
  b: number,
  bw: number
): number {
  const denom = Math.min(aw, bw);
  if (denom <= 0) {
    if (aw === 0 && bw === 0) return a === b ? 1 : 0;
    const point = aw === 0 ? a : b;
    const lo = aw === 0 ? b : a;
    const hi = lo + (aw === 0 ? bw : aw);
    return point >= lo && point <= hi ? 1 : 0;
  }
  return clamp(
    Math.max(0, Math.min(a + aw, b + bw) - Math.max(a, b)) / denom
  );
}

/**
 * Scale a box so the page (pageWidth x pageHeight) maps onto the unit
 * square. Output coordinates are in [0, 1] for any box inside the page.
 */
export function normalizeBox(
  box: BBox,
  pageWidth: number,
  pageHeight: number
): BBox {
  assertPageDimensions(pageWidth, pageHeight);
  return Object.freeze({
    x: box.x / pageWidth,
    y: box.y / pageHeight,
    width: box.width / pageWidth,
    height: box.height / pageHeight,
  });
}

/** Inverse of normalizeBox. */
export function denormalizeBox(
  box: BBox,
  pageWidth: number,
  pageHeight: number
): BBox {
  assertPageDimensions(pageWidth, pageHeight);
  return Object.freeze({
    x: box.x * pageWidth,
    y: box.y * pageHeight,
    width: box.width * pageWidth,
    height: box.height * pageHeight,
  });
}

function assertPageDimensions(pageWidth: number, pageHeight: number): void {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) {
    throw new RangeError("pageWidth must be a positive finite number");
  }
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
    throw new RangeError("pageHeight must be a positive finite number");
  }
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export { unionBoxes };
