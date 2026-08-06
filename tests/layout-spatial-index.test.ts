/**
 * Spatial index tests — grid correctness, determinism, query semantics
 * (overlap / containment / point / radius / nearest), builders over layout
 * and OCR primitives, and input validation.
 */
import {
  buildLineIndex,
  buildNodeIndex,
  buildRegionIndex,
  buildWordIndex,
  createConfidenceDistribution,
  createLayoutNode,
  createLayoutRegion,
  SpatialIndex,
} from "@/lib/layout";
import type { SpatialEntry } from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

function node(id: string, x: number, y: number, w = 10, h = 10) {
  return createLayoutNode({
    id,
    page: 0,
    bbox: { x, y, width: w, height: h },
    confidence: createConfidenceDistribution([0.9]),
  });
}

/** Keys of a query result, comma-joined, in result order. */
const keys = (r: readonly SpatialEntry<unknown>[]): string =>
  r.map((e) => e.key).join(",");

// A: (0,0,10,10)  B: (20,0,10,10)  C: (0,20,10,10)  D: (50,50,20,20)
function fixture(): SpatialIndex<ReturnType<typeof node>> {
  return buildNodeIndex([node("A", 0, 0), node("B", 20, 0), node("C", 0, 20), node("D", 50, 50, 20, 20)]);
}

// ─── Build / basic access ──────────────────────────────────────────────────

test("build sizes and keys", () => {
  const idx = fixture();
  equal(idx.size, 4);
  ok(idx.has("A"), "has known key");
  ok(!idx.has("Z"), "missing key");
  equal(idx.get("B")?.value.id, "B");
  equal(idx.get("Z"), undefined);
  equal(keys(idx.entries()), "A,B,C,D", "entries preserve insertion order");
});

test("empty index answers every query with an empty result", () => {
  const idx = SpatialIndex.build<number>([]);
  equal(idx.size, 0);
  equal(idx.searchOverlap({ x: 0, y: 0, width: 10, height: 10 }), []);
  equal(idx.searchContained({ x: 0, y: 0, width: 100, height: 100 }), []);
  equal(idx.searchContaining({ x: 0, y: 0, width: 1, height: 1 }), []);
  equal(idx.searchNearby({ x: 0, y: 0, width: 10, height: 10 }, 100), []);
  equal(idx.nearest({ x: 0, y: 0, width: 10, height: 10 }, 3), []);
  equal(idx.lookupPoint({ x: 0, y: 0 }), []);
});

test("duplicate keys are rejected", () => {
  let threw = false;
  try {
    SpatialIndex.build([
      { key: "a", bbox: { x: 0, y: 0, width: 1, height: 1 }, value: 1 },
      { key: "a", bbox: { x: 5, y: 5, width: 1, height: 1 }, value: 2 },
    ]);
  } catch (e) {
    threw = e instanceof Error && /duplicate/.test(e.message);
  }
  ok(threw, "duplicate key throws");
});

test("non-finite boxes are rejected", () => {
  let threw = false;
  try {
    SpatialIndex.build([{ key: "a", bbox: { x: NaN, y: 0, width: 1, height: 1 }, value: 1 }]);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "NaN coordinate throws RangeError");
});

test("invalid cell sizes are rejected", () => {
  let threw = false;
  try {
    SpatialIndex.build<number>([], { cellSize: 0 });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "zero cell size throws RangeError");
});

// ─── Overlap / containment ─────────────────────────────────────────────────

test("searchOverlap finds intersecting entries", () => {
  const idx = fixture();
  equal(keys(idx.searchOverlap({ x: 15, y: 0, width: 10, height: 10 })), "B");
  equal(keys(idx.searchOverlap({ x: 0, y: 0, width: 10, height: 10 })), "A");
  equal(keys(idx.searchOverlap({ x: 0, y: 0, width: 30, height: 30 })), "A,B,C");
  equal(keys(idx.searchOverlap({ x: 5, y: 5, width: 50, height: 50 })), "A,B,C,D");
});

test("searchOverlap excludes touching edges", () => {
  const idx = fixture();
  equal(keys(idx.searchOverlap({ x: 10, y: 0, width: 5, height: 5 })), "");
});

test("searchContained returns entries fully inside the query", () => {
  const idx = fixture();
  equal(keys(idx.searchContained({ x: 0, y: 0, width: 30, height: 30 })), "A,B,C");
  equal(keys(idx.searchContained({ x: 0, y: 0, width: 10, height: 10 })), "A");
  equal(keys(idx.searchContained({ x: 50, y: 50, width: 20, height: 20 })), "D");
});

test("searchContaining returns entries that contain the query", () => {
  const idx = fixture();
  equal(keys(idx.searchContaining({ x: 55, y: 55, width: 2, height: 2 })), "D");
  equal(keys(idx.searchContaining({ x: 50, y: 50, width: 20, height: 20 })), "D");
  equal(keys(idx.searchContaining({ x: 0, y: 0, width: 1, height: 1 })), "A");
});

test("lookupPoint finds containers of a point (edges inclusive)", () => {
  const idx = fixture();
  equal(keys(idx.lookupPoint({ x: 55, y: 55 })), "D");
  equal(keys(idx.lookupPoint({ x: 50, y: 50 })), "D", "point on min edge");
  equal(keys(idx.lookupPoint({ x: 70, y: 70 })), "D", "point on max edge");
  equal(keys(idx.lookupPoint({ x: 70.1, y: 70 })), "", "outside the box");
});

// ─── Radius / nearest ──────────────────────────────────────────────────────

test("searchNearby honors the box-to-box radius", () => {
  const idx = fixture();
  equal(keys(idx.searchNearby({ x: 0, y: 0, width: 10, height: 10 }, 15)), "A,B,C");
  equal(keys(idx.searchNearby({ x: 0, y: 0, width: 10, height: 10 }, 5)), "A");
  equal(keys(idx.searchNearby({ x: 0, y: 0, width: 10, height: 10 }, 0)), "A");
});

test("searchNearby rejects a negative radius", () => {
  let threw = false;
  try {
    fixture().searchNearby({ x: 0, y: 0, width: 1, height: 1 }, -1);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "negative radius throws RangeError");
});

test("nearest returns k by center distance", () => {
  const idx = fixture();
  equal(keys(idx.nearest({ x: 0, y: 0, width: 10, height: 10 }, 2)), "A,B");
  equal(keys(idx.nearest({ x: 0, y: 0, width: 10, height: 10 }, 3)), "A,B,C");
  equal(keys(idx.nearest({ x: 0, y: 0, width: 10, height: 10 }, 10)), "A,B,C,D", "k larger than size returns all");
  equal(keys(idx.nearest({ x: 55, y: 55, width: 2, height: 2 }, 1)), "D");
});

test("nearest ties break by insertion order", () => {
  const idx = buildNodeIndex([
    node("A", 0, 0),
    node("E", 30, 0),
    node("F", 0, 30),
  ]);
  // E and F are equidistant from A's center; insertion order decides.
  equal(keys(idx.nearest({ x: 0, y: 0, width: 10, height: 10 }, 3)), "A,E,F");
});

test("nearest with k <= 0 returns empty", () => {
  equal(keys(fixture().nearest({ x: 0, y: 0, width: 10, height: 10 }, 0)), "");
});

// ─── Determinism ───────────────────────────────────────────────────────────

test("queries are deterministic across identical builds", () => {
  const a = fixture();
  const b = fixture();
  equal(
    JSON.stringify(a.searchOverlap({ x: 5, y: 5, width: 50, height: 50 })),
    JSON.stringify(b.searchOverlap({ x: 5, y: 5, width: 50, height: 50 }))
  );
  equal(
    JSON.stringify(a.nearest({ x: 5, y: 5, width: 50, height: 50 }, 3)),
    JSON.stringify(b.nearest({ x: 5, y: 5, width: 50, height: 50 }, 3))
  );
});

test("membership queries return insertion order, not spatial order", () => {
  const idx = buildNodeIndex([
    node("right", 500, 0),
    node("left", 0, 0),
    node("middle", 100, 0),
  ]);
  equal(
    keys(idx.searchOverlap({ x: 0, y: 0, width: 600, height: 50 })),
    "right,left,middle"
  );
});

// ─── Builders over layout + OCR primitives ─────────────────────────────────

test("buildRegionIndex indexes regions by id", () => {
  const region = createLayoutRegion({
    id: "r0",
    page: 0,
    bbox: { x: 0, y: 0, width: 100, height: 100 },
  });
  const idx = buildRegionIndex([region]);
  equal(keys(idx.lookupPoint({ x: 10, y: 10 })), "r0");
  equal(keys(idx.lookupPoint({ x: 200, y: 10 })), "");
});

test("buildLineIndex indexes lines by index with bbox", () => {
  const idx = buildLineIndex([
    {
      text: "first",
      words: [{ text: "first" }],
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    },
    {
      text: "second",
      words: [{ text: "second" }],
      bbox: { x: 20, y: 0, width: 10, height: 10 },
    },
  ]);
  equal(idx.size, 2);
  equal(keys(idx.searchOverlap({ x: 5, y: 0, width: 5, height: 5 })), "0");
  equal(idx.get("0")?.value.index, 0);
  equal(idx.get("1")?.value.line.text, "second");
});

test("buildLineIndex indexes box-less lines with a zero box at the origin", () => {
  const idx = buildLineIndex([
    { text: "no geometry", words: [{ text: "no" }] },
  ]);
  equal(idx.size, 1);
  equal(keys(idx.searchContained({ x: 0, y: 0, width: 10, height: 10 })), "0");
  equal(keys(idx.lookupPoint({ x: 5, y: 5 })), "");
});

test("buildWordIndex indexes only words that carry a box", () => {
  const idx = buildWordIndex([
    {
      text: "l0",
      words: [
        { text: "w0", bbox: { x: 0, y: 0, width: 5, height: 5 } },
        { text: "w1", bbox: { x: 10, y: 0, width: 5, height: 5 } },
        { text: "w2" },
      ],
    },
    {
      text: "l1",
      words: [{ text: "w3", bbox: { x: 0, y: 10, width: 5, height: 5 } }],
    },
  ]);
  equal(idx.size, 3, "box-less word is skipped");
  equal(idx.get("0:0")?.value.wordIndex, 0);
  equal(idx.get("0:1")?.value.lineIndex, 0);
  equal(idx.get("0:2"), undefined, "box-less word has no key");
  equal(keys(idx.searchOverlap({ x: 0, y: 10, width: 5, height: 5 })), "1:0");
});
