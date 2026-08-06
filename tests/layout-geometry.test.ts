/**
 * Geometry primitive tests — pure box/point operations, coordinate
 * normalization and distance helpers. Edge cases: touching boxes, zero-area
 * boxes, boundaries, degenerate page dimensions.
 */
import {
  boxCenter,
  boxContains,
  boxesDistance,
  boxesIntersect,
  boxIntersection,
  boxArea,
  centerDistance,
  denormalizeBox,
  horizontalGap,
  horizontalOverlap,
  horizontalOverlapRatio,
  intersectionArea,
  iou,
  makePoint,
  normalizeBox,
  pointDistance,
  pointEquals,
  pointInBox,
  unionBoxes,
  verticalGap,
  verticalOverlap,
  verticalOverlapRatio,
} from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

// ─── Point primitives ─────────────────────────────────────────────────────

test("makePoint creates an immutable point", () => {
  const p = makePoint(1, 2);
  ok(Object.isFrozen(p), "point is frozen");
  equal(p.x, 1);
  equal(p.y, 2);
});

test("pointEquals distinguishes points", () => {
  ok(pointEquals(makePoint(0, 0), makePoint(0, 0)), "equal points");
  ok(!pointEquals(makePoint(0, 0), makePoint(1, 0)), "different x");
  ok(!pointEquals(makePoint(0, 0), makePoint(0, 1)), "different y");
});

test("pointDistance is Euclidean", () => {
  equal(pointDistance(makePoint(0, 0), makePoint(3, 4)), 5);
  equal(pointDistance(makePoint(1, 1), makePoint(1, 1)), 0);
});

// ─── Box basics ────────────────────────────────────────────────────────────

test("boxCenter returns the geometric center", () => {
  const c = boxCenter({ x: 10, y: 20, width: 4, height: 6 });
  equal(c.x, 12);
  equal(c.y, 23);
});

test("boxCenter of a zero-size box is its corner", () => {
  const c = boxCenter({ x: 5, y: 5, width: 0, height: 0 });
  equal(c.x, 5);
  equal(c.y, 5);
});

test("pointInBox includes all edges", () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  ok(pointInBox(makePoint(0, 0), box), "min corner inclusive");
  ok(pointInBox(makePoint(10, 10), box), "max corner inclusive");
  ok(pointInBox(makePoint(5, 5), box), "interior");
  ok(!pointInBox(makePoint(-1, 5), box), "left of box");
  ok(!pointInBox(makePoint(11, 5), box), "right of box");
  ok(!pointInBox(makePoint(5, -1), box), "above box");
  ok(!pointInBox(makePoint(5, 11), box), "below box");
});

test("pointInBox with zero-size box", () => {
  const box = { x: 5, y: 5, width: 0, height: 0 };
  ok(pointInBox(makePoint(5, 5), box), "exact corner of zero-size box");
  ok(!pointInBox(makePoint(5.1, 5), box), "outside zero-size box");
});

// ─── Intersection / containment ────────────────────────────────────────────

test("boxesIntersect is strict on touching edges", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 10, y: 0, width: 10, height: 10 };
  ok(!boxesIntersect(a, b), "touching edges are not an intersection");
  const c = { x: 9.5, y: 0, width: 10, height: 10 };
  ok(boxesIntersect(a, c), "small overlap counts");
});

test("boxesIntersect with containment and zero-area boxes", () => {
  const outer = { x: 0, y: 0, width: 20, height: 20 };
  const inner = { x: 5, y: 5, width: 5, height: 5 };
  ok(boxesIntersect(outer, inner), "contained box intersects");
  ok(boxesIntersect(inner, outer), "intersection is symmetric");
  ok(!boxesIntersect(inner, { x: 50, y: 50, width: 5, height: 5 }), "disjoint");
});

test("boxIntersection returns the shared box", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 5, y: 5, width: 10, height: 10 };
  const i = boxIntersection(a, b);
  equal(i, { x: 5, y: 5, width: 5, height: 5 });
  ok(Object.isFrozen(i!), "intersection box is frozen");
});

test("boxIntersection is null when touching or disjoint", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  equal(boxIntersection(a, { x: 10, y: 0, width: 10, height: 10 }), null);
  equal(boxIntersection(a, { x: 50, y: 50, width: 1, height: 1 }), null);
});

test("boxArea and intersectionArea", () => {
  equal(boxArea({ x: 0, y: 0, width: 3, height: 4 }), 12);
  equal(boxArea({ x: 0, y: 0, width: 0, height: 4 }), 0);
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 5, y: 0, width: 10, height: 10 };
  equal(intersectionArea(a, b), 50);
  equal(intersectionArea(a, { x: 50, y: 50, width: 1, height: 1 }), 0);
});

test("iou", () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  equal(iou(box, box), 1, "identical boxes");
  equal(iou(box, { x: 50, y: 50, width: 10, height: 10 }), 0, "disjoint");
  equal(iou(box, { x: 10, y: 0, width: 10, height: 10 }), 0, "touching");
  // Half-overlap: intersection 50, union 150.
  equal(iou(box, { x: 5, y: 0, width: 10, height: 10 }), 50 / 150);
  // Zero-area boxes never divide by zero.
  equal(iou({ x: 0, y: 0, width: 0, height: 0 }, box), 0);
});

test("boxContains (edges inclusive)", () => {
  const outer = { x: 0, y: 0, width: 20, height: 20 };
  equal(boxContains(outer, { x: 0, y: 0, width: 20, height: 20 }), true, "equal");
  equal(boxContains(outer, { x: 5, y: 5, width: 5, height: 5 }), true, "inside");
  equal(boxContains(outer, { x: 5, y: 5, width: 15, height: 15 }), true, "edge-aligned");
  equal(boxContains(outer, { x: -1, y: 0, width: 10, height: 10 }), false, "outside");
  equal(boxContains(outer, { x: 0, y: 0, width: 30, height: 30 }), false, "too big");
});

test("boxContains with zero-size inner", () => {
  const outer = { x: 0, y: 0, width: 10, height: 10 };
  equal(boxContains(outer, { x: 10, y: 10, width: 0, height: 0 }), true);
  equal(boxContains(outer, { x: 10.1, y: 10, width: 0, height: 0 }), false);
});

// ─── Axis overlap ──────────────────────────────────────────────────────────

test("horizontalOverlap", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  equal(horizontalOverlap(a, { x: 5, y: 0, width: 10, height: 10 }), 5);
  equal(horizontalOverlap(a, { x: 0, y: 0, width: 20, height: 10 }), 10);
  equal(horizontalOverlap(a, { x: 20, y: 0, width: 10, height: 10 }), 0);
});

test("verticalOverlap", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  equal(verticalOverlap(a, { x: 0, y: 5, width: 10, height: 10 }), 5);
  equal(verticalOverlap(a, { x: 0, y: 20, width: 10, height: 10 }), 0);
});

test("horizontalOverlapRatio is relative to the smaller width", () => {
  const a = { x: 0, y: 0, width: 100, height: 10 };
  equal(horizontalOverlapRatio(a, { x: 50, y: 0, width: 50, height: 10 }), 1);
  equal(
    horizontalOverlapRatio(a, { x: 50, y: 0, width: 100, height: 10 }),
    0.5
  );
  equal(horizontalOverlapRatio(a, { x: 200, y: 0, width: 50, height: 10 }), 0);
});

test("verticalOverlapRatio is relative to the smaller height", () => {
  const a = { x: 0, y: 0, width: 10, height: 100 };
  equal(verticalOverlapRatio(a, { x: 0, y: 50, width: 10, height: 50 }), 1);
  equal(
    verticalOverlapRatio(a, { x: 0, y: 50, width: 10, height: 100 }),
    0.5
  );
});

test("overlap ratios handle zero-size boxes deterministically", () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  equal(horizontalOverlapRatio(a, { x: 5, y: 0, width: 0, height: 100 }), 1);
  equal(horizontalOverlapRatio(a, { x: 500, y: 0, width: 0, height: 100 }), 0);
  equal(verticalOverlapRatio(a, { x: 0, y: 50, width: 10, height: 0 }), 1);
  equal(verticalOverlapRatio(a, { x: 0, y: 500, width: 10, height: 0 }), 0);
  equal(
    horizontalOverlapRatio({ x: 5, y: 0, width: 0, height: 1 }, { x: 5, y: 0, width: 0, height: 1 }),
    1,
    "coincident zero-width boxes fully overlap"
  );
  equal(
    horizontalOverlapRatio({ x: 5, y: 0, width: 0, height: 1 }, { x: 7, y: 0, width: 0, height: 1 }),
    0,
    "separate zero-width boxes do not overlap"
  );
});

// ─── Distance helpers ──────────────────────────────────────────────────────

test("boxesDistance", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  equal(boxesDistance(a, { x: 5, y: 0, width: 10, height: 10 }), 0, "overlapping");
  equal(boxesDistance(a, { x: 10, y: 0, width: 10, height: 10 }), 0, "touching");
  equal(boxesDistance(a, { x: 15, y: 0, width: 10, height: 10 }), 5, "horizontal gap");
  equal(boxesDistance(a, { x: 15, y: 15, width: 10, height: 10 }), Math.hypot(5, 5), "diagonal gap");
});

test("centerDistance", () => {
  equal(centerDistance({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }), 10);
});

// ─── Axis edge-to-edge gaps ──────────────────────────────────────────────────

test("horizontalGap is the edge-to-edge x-distance", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  equal(horizontalGap(a, { x: 15, y: 0, width: 10, height: 10 }), 5, "separated");
  equal(horizontalGap(a, { x: 10, y: 0, width: 10, height: 10 }), 0, "touching");
  equal(horizontalGap(a, { x: 5, y: 0, width: 10, height: 10 }), 0, "overlapping");
  equal(horizontalGap(a, a), 0, "identical");
});

test("verticalGap is the edge-to-edge y-distance", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  equal(verticalGap(a, { x: 0, y: 15, width: 10, height: 10 }), 5, "separated");
  equal(verticalGap(a, { x: 0, y: 10, width: 10, height: 10 }), 0, "touching");
  equal(verticalGap(a, { x: 0, y: 5, width: 10, height: 10 }), 0, "overlapping");
  equal(verticalGap(a, a), 0, "identical");
});

test("gaps are symmetric and axis-independent of the other axis", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 25, y: 100, width: 10, height: 10 };
  equal(horizontalGap(a, b), horizontalGap(b, a), "horizontal symmetric");
  equal(horizontalGap(a, b), 15, "y offset does not affect the x gap");
  const c = { x: 100, y: 30, width: 10, height: 10 };
  const d = { x: 100, y: 50, width: 10, height: 10 };
  equal(verticalGap(c, d), 10, "x offset does not affect the y gap");
});

test("boxesDistance combines the axis gaps", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 15, y: 15, width: 10, height: 10 };
  equal(boxesDistance(a, b), Math.hypot(horizontalGap(a, b), verticalGap(a, b)));
});

// ─── Coordinate normalization ──────────────────────────────────────────────

test("normalizeBox maps page onto the unit square", () => {
  const n = normalizeBox(
    { x: 100, y: 250, width: 200, height: 100 },
    1000,
    500
  );
  equal(n, { x: 0.1, y: 0.5, width: 0.2, height: 0.2 });
});

test("denormalizeBox inverts normalizeBox", () => {
  const pageW = 1240;
  const pageH = 1754;
  const box = { x: 30, y: 700, width: 240, height: 90 };
  const round = (b: { x: number; y: number; width: number; height: number }) => ({
    x: Math.round(b.x * 1e9) / 1e9,
    y: Math.round(b.y * 1e9) / 1e9,
    width: Math.round(b.width * 1e9) / 1e9,
    height: Math.round(b.height * 1e9) / 1e9,
  });
  const roundtrip = round(denormalizeBox(normalizeBox(box, pageW, pageH), pageW, pageH));
  equal(roundtrip, box);
});

test("normalizeBox rejects degenerate page dimensions", () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  let threw = false;
  try {
    normalizeBox(box, 0, 100);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "zero page width throws RangeError");

  threw = false;
  try {
    normalizeBox(box, 100, -5);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "negative page height throws RangeError");

  threw = false;
  try {
    normalizeBox(box, NaN, 100);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "NaN page width throws RangeError");
});

test("denormalizeBox rejects degenerate page dimensions", () => {
  let threw = false;
  try {
    denormalizeBox({ x: 0, y: 0, width: 1, height: 1 }, 100, 0);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "zero page height throws RangeError");
});

// ─── Reused pipeline union utility ─────────────────────────────────────────

test("unionBoxes is reused from the pipeline (no duplicate utility)", () => {
  equal(unionBoxes([]), undefined, "empty input");
  equal(unionBoxes([{ x: 0, y: 0, width: 10, height: 10 }]), { x: 0, y: 0, width: 10, height: 10 });
  equal(
    unionBoxes([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    ]),
    { x: 0, y: 0, width: 15, height: 15 }
  );
  equal(
    unionBoxes([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 2, y: 2, width: 4, height: 4 },
    ]),
    { x: 0, y: 0, width: 10, height: 10 },
    "contained box does not expand the union"
  );
});
