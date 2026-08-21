/**
 * Pure-logic tests for the Document Inspector (BBox overlay geometry,
 * confidence coloring, and bidirectional highlight state). The React shells
 * are exercised via tsc; this file stays JSX-free so the Node strip-types
 * test runner can execute it directly.
 */
import { test, ok, equal } from "../../../../tests/harness";
import {
  normalizedToPercentageBBox,
  pixelBBoxToNormalized,
  unionPixelBoxes,
  matchQuoteWords,
  confidenceColor,
  fieldTone,
  bboxStateClass,
  rowStateClass,
  findBoxAt,
} from "../bbox-utils";

// ─── normalizedToPercentageBBox ───────────────────────────────────────────

test("inspector: normalized [ymin,xmin,ymax,xmax] 0..1000 maps to CSS percentages", () => {
  equal(normalizedToPercentageBBox([200, 100, 600, 400]), {
    left: 10,
    top: 20,
    width: 30,
    height: 40,
  });
});

test("inspector: 0..1 scale auto-detected and mapped identically", () => {
  equal(normalizedToPercentageBBox([0.2, 0.1, 0.6, 0.4]), {
    left: 10,
    top: 20,
    width: 30,
    height: 40,
  });
});

test("inspector: object form {ymin,xmin,ymax,xmax} accepted", () => {
  equal(normalizedToPercentageBBox({ ymin: 250, xmin: 0, ymax: 500, xmax: 1000 }), {
    left: 0,
    top: 25,
    width: 100,
    height: 25,
  });
});

test("inspector: explicit scale override wins over auto-detection", () => {
  equal(normalizedToPercentageBBox([200, 100, 600, 400], 1000), {
    left: 10,
    top: 20,
    width: 30,
    height: 40,
  });
  equal(normalizedToPercentageBBox([200, 100, 600, 400], 2000), {
    left: 5,
    top: 10,
    width: 15,
    height: 20,
  });
});

test("inspector: degenerate box maps to zero size, never negative", () => {
  equal(normalizedToPercentageBBox([500, 500, 100, 100]), {
    left: 50,
    top: 50,
    width: 0,
    height: 0,
  });
});

test("inspector: invalid normalized box throws", () => {
  let threw = false;
  try {
    normalizedToPercentageBBox([NaN, 1, 2, 3]);
  } catch {
    threw = true;
  }
  ok(threw, "NaN box must throw");
});

// ─── pixelBBoxToNormalized ────────────────────────────────────────────────

test("inspector: pixel bbox normalized against image dimensions", () => {
  equal(pixelBBoxToNormalized({ x: 100, y: 50, width: 100, height: 100 }, 1000, 1000), {
    ymin: 50,
    xmin: 100,
    ymax: 150,
    xmax: 200,
  });
});

test("inspector: non-square images scale axes independently", () => {
  equal(pixelBBoxToNormalized({ x: 0, y: 250, width: 250, height: 250 }, 500, 1000), {
    ymin: 250,
    xmin: 0,
    ymax: 500,
    xmax: 500,
  });
});

test("inspector: zero or negative image dimensions throw", () => {
  let threw = false;
  try {
    pixelBBoxToNormalized({ x: 0, y: 0, width: 1, height: 1 }, 0, 100);
  } catch {
    threw = true;
  }
  ok(threw, "non-positive image width must throw");
});

// ─── unionPixelBoxes ──────────────────────────────────────────────────────

test("inspector: union of word boxes is the bounding rectangle", () => {
  equal(
    unionPixelBoxes([
      { x: 10, y: 20, width: 30, height: 40 },
      { x: 60, y: 10, width: 20, height: 90 },
    ]),
    { x: 10, y: 10, width: 70, height: 90 }
  );
});

test("inspector: empty or zero-area boxes yield null", () => {
  ok(unionPixelBoxes([]) === null, "empty list must yield null");
  ok(unionPixelBoxes([{ x: 5, y: 5, width: 0, height: 10 }]) === null, "zero width must yield null");
});

// ─── matchQuoteWords ──────────────────────────────────────────────────────

test("inspector: quote matched onto contiguous word span", () => {
  const words = [
    { text: "فاتورة", bbox: { x: 0, y: 0, width: 50, height: 20 } },
    { text: "رقم", bbox: { x: 60, y: 0, width: 40, height: 20 } },
    { text: "12345", bbox: { x: 110, y: 0, width: 60, height: 20 } },
    { text: "تاريخ", bbox: { x: 180, y: 0, width: 50, height: 20 } },
  ];
  const span = matchQuoteWords(words, "رقم 12345");
  equal(span.map((w) => w.text), ["رقم", "12345"]);
});

test("inspector: whitespace-tolerant matching", () => {
  const words = [
    { text: "Total", bbox: { x: 0, y: 0, width: 40, height: 20 } },
    { text: "due:", bbox: { x: 45, y: 0, width: 35, height: 20 } },
    { text: "150.00", bbox: { x: 85, y: 0, width: 60, height: 20 } },
  ];
  const span = matchQuoteWords(words, "  Total   due: 150.00 ");
  equal(span.map((w) => w.text), ["Total", "due:", "150.00"]);
});

test("inspector: unrelated quote falls back to empty (no false span)", () => {
  const words = [
    { text: "Invoice", bbox: { x: 0, y: 0, width: 50, height: 20 } },
    { text: "Number", bbox: { x: 60, y: 0, width: 50, height: 20 } },
  ];
  equal(matchQuoteWords(words, "zzz none of this appears"), []);
  equal(matchQuoteWords([], "anything"), []);
  equal(matchQuoteWords(words, ""), []);
});

// ─── confidenceColor ──────────────────────────────────────────────────────

test("inspector: confidence color thresholds (>=.85 green, >=.5 amber, else red)", () => {
  equal(confidenceColor(0.95), "#22C55E");
  equal(confidenceColor(0.85), "#22C55E");
  equal(confidenceColor(0.84), "#F59E0B");
  equal(confidenceColor(0.5), "#F59E0B");
  equal(confidenceColor(0.49), "#EF4444");
  equal(confidenceColor(0.1), "#EF4444");
});

// ─── fieldTone ────────────────────────────────────────────────────────────

test("inspector: field tone groups verified / uncertain / missing", () => {
  equal(fieldTone(0.9, true), "verified");
  equal(fieldTone(0.6, true), "uncertain");
  equal(fieldTone(0.95, false), "missing");
});

// ─── bboxStateClass / rowStateClass ───────────────────────────────────────

test("inspector: box state class carries active/hovered flags", () => {
  equal(bboxStateClass(false, false), "fd-inspector-box");
  equal(bboxStateClass(false, true), "fd-inspector-box fd-inspector-box--hovered");
  equal(bboxStateClass(true, false), "fd-inspector-box fd-inspector-box--active");
  equal(bboxStateClass(true, true), "fd-inspector-box fd-inspector-box--active");
});

test("inspector: row state class mirrors the overlay highlight", () => {
  equal(rowStateClass(false, false), "fd-inspector-row");
  equal(rowStateClass(false, true), "fd-inspector-row fd-inspector-row--hovered");
  equal(rowStateClass(true, false), "fd-inspector-row fd-inspector-row--active");
});

// ─── findBoxAt ────────────────────────────────────────────────────────────

test("inspector: hit-test finds the top-most box under the point", () => {
  const boxes = [
    { id: "a", box: { ymin: 0, xmin: 0, ymax: 500, xmax: 500 } },
    { id: "b", box: { ymin: 250, xmin: 250, ymax: 750, xmax: 750 } },
  ];
  equal(findBoxAt(boxes, 100, 100), "a");
  equal(findBoxAt(boxes, 600, 600), "b");
  equal(findBoxAt(boxes, 900, 900), null);
});

test("inspector: hit-test is inclusive of box edges", () => {
  const boxes = [{ id: "edge", box: { ymin: 100, xmin: 100, ymax: 200, xmax: 200 } }];
  equal(findBoxAt(boxes, 100, 100), "edge");
  equal(findBoxAt(boxes, 200, 200), "edge");
});
