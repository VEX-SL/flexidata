/**
 * Layout domain model tests — immutable creation, deep freezing, source
 * linking and the document-level confidence aggregate.
 */
import {
  createConfidenceDistribution,
  createLayoutDocument,
  createLayoutNode,
  createLayoutPage,
  createLayoutRegion,
  LAYOUT_VERSION,
} from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

function approx(actual: number, expected: number, eps = 1e-9): void {
  ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} within ${eps}`
  );
}

// ─── ConfidenceDistribution ────────────────────────────────────────────────

test("empty distribution is a neutral zero summary", () => {
  const d = createConfidenceDistribution([]);
  equal(d.count, 0);
  equal(d.mean, 0);
  equal(d.variance, 0);
  equal(d.min, 0);
  equal(d.max, 0);
  ok(Object.isFrozen(d), "distribution is frozen");
});

test("single-value distribution", () => {
  const d = createConfidenceDistribution([0.8]);
  equal(d.count, 1);
  equal(d.mean, 0.8);
  equal(d.variance, 0);
  equal(d.min, 0.8);
  equal(d.max, 0.8);
});

test("distribution mean/variance/min/max", () => {
  const d = createConfidenceDistribution([0, 2]);
  equal(d.mean, 1);
  equal(d.variance, 1);
  equal(d.min, 0);
  equal(d.max, 2);

  const d2 = createConfidenceDistribution([1, 2, 3, 4]);
  equal(d2.mean, 2.5);
  equal(d2.variance, 1.25);
  equal(d2.min, 1);
  equal(d2.max, 4);
});

test("distribution rejects non-finite values", () => {
  let threw = false;
  try {
    createConfidenceDistribution([0.5, NaN]);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "NaN value throws RangeError");
});

// ─── LayoutNode ────────────────────────────────────────────────────────────

test("createLayoutNode freezes node and box copy", () => {
  const srcBox = { x: 1, y: 2, width: 3, height: 4 };
  const node = createLayoutNode({
    id: "n0",
    page: 0,
    bbox: srcBox,
    confidence: createConfidenceDistribution([0.9, 0.8]),
  });
  equal(node.id, "n0");
  equal(node.page, 0);
  equal(node.bbox, srcBox);
  approx(node.confidence.mean, 0.85);
  ok(Object.isFrozen(node), "node is frozen");
  ok(Object.isFrozen(node.bbox), "node box is frozen");

  srcBox.x = 99;
  equal(node.bbox.x, 1, "mutating the source box does not leak into the node");
});

test("createLayoutNode without confidence yields a neutral distribution", () => {
  const node = createLayoutNode({ id: "n1", page: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } });
  equal(node.confidence.count, 0);
  equal(node.confidence.mean, 0);
});

test("createLayoutNode carries an optional OCR source ref", () => {
  const node = createLayoutNode({
    id: "n2",
    page: 0,
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    source: { lineIndex: 3, wordIndex: 2 },
  });
  equal(node.source, { lineIndex: 3, wordIndex: 2 });
  ok(Object.isFrozen(node.source!), "source ref is frozen");

  const lineOnly = createLayoutNode({
    id: "n3",
    page: 0,
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    source: { lineIndex: 5 },
  });
  equal(lineOnly.source, { lineIndex: 5 });
});

// ─── LayoutRegion / LayoutPage ─────────────────────────────────────────────

test("createLayoutRegion copies and freezes node ids", () => {
  const ids = ["a", "b"];
  const region = createLayoutRegion({
    id: "r0",
    page: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    nodeIds: ids,
  });
  equal(region.id, "r0");
  equal(region.nodeIds, ["a", "b"]);
  ok(Object.isFrozen(region), "region is frozen");
  ok(Object.isFrozen(region.nodeIds), "node ids array is frozen");

  ids.push("c");
  equal(region.nodeIds.length, 2, "mutating the source array does not leak");
});

test("createLayoutPage copies bounds and id arrays", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 200 };
  const page = createLayoutPage({
    index: 0,
    bounds,
    nodeIds: ["a", "b"],
    regionIds: ["r0"],
  });
  equal(page.index, 0);
  equal(page.bounds, bounds);
  equal(page.nodeIds, ["a", "b"]);
  equal(page.regionIds, ["r0"]);
  ok(Object.isFrozen(page), "page is frozen");
  ok(Object.isFrozen(page.bounds), "page bounds are frozen");
});

test("createLayoutPage defaults to empty id arrays", () => {
  const page = createLayoutPage({ index: 0, bounds: { x: 0, y: 0, width: 1, height: 1 } });
  equal(page.nodeIds, []);
  equal(page.regionIds, []);
});

// ─── LayoutDocument ────────────────────────────────────────────────────────

test("createLayoutDocument builds a frozen structural model", () => {
  const n1 = createLayoutNode({
    id: "n1",
    page: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    confidence: createConfidenceDistribution([0.8]),
  });
  const n2 = createLayoutNode({
    id: "n2",
    page: 0,
    bbox: { x: 0, y: 20, width: 10, height: 10 },
    confidence: createConfidenceDistribution([0.4]),
  });
  const region = createLayoutRegion({
    id: "r0",
    page: 0,
    bbox: { x: 0, y: 0, width: 10, height: 30 },
    nodeIds: ["n1", "n2"],
  });
  const page = createLayoutPage({
    index: 0,
    bounds: { x: 0, y: 0, width: 100, height: 200 },
    nodeIds: ["n1", "n2"],
    regionIds: ["r0"],
  });

  const doc = createLayoutDocument({
    pages: [page],
    nodes: [n1, n2],
    regions: [region],
  });

  equal(doc.version, LAYOUT_VERSION);
  equal(doc.pages.length, 1);
  equal(doc.nodes.length, 2);
  equal(doc.regions.length, 1);
  ok(Object.isFrozen(doc), "document is frozen");
  ok(Object.isFrozen(doc.pages), "pages array is frozen");
  ok(Object.isFrozen(doc.nodes), "nodes array is frozen");
  ok(Object.isFrozen(doc.regions), "regions array is frozen");
});

test("document confidence aggregates node means (unweighted)", () => {
  const n1 = createLayoutNode({
    id: "n1",
    page: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    confidence: createConfidenceDistribution([0.8]),
  });
  const n2 = createLayoutNode({
    id: "n2",
    page: 0,
    bbox: { x: 0, y: 20, width: 10, height: 10 },
    confidence: createConfidenceDistribution([0.4]),
  });
  const doc = createLayoutDocument({ pages: [], nodes: [n1, n2], regions: [] });
  equal(doc.confidence.count, 2);
  approx(doc.confidence.mean, 0.6);
  equal(doc.confidence.min, 0.4);
  equal(doc.confidence.max, 0.8);
});

test("document confidence of an empty model is neutral", () => {
  const doc = createLayoutDocument({ pages: [], nodes: [], regions: [] });
  equal(doc.confidence.count, 0);
  equal(doc.confidence.mean, 0);
});

test("createLayoutDocument honors an explicit version", () => {
  const doc = createLayoutDocument({ pages: [], nodes: [], regions: [], version: 7 });
  equal(doc.version, 7);
});

test("createLayoutDocument keeps a source OCR reference", () => {
  const source = { text: "abc", lines: [] };
  const doc = createLayoutDocument({ pages: [], nodes: [], regions: [], source });
  equal(doc.source, source);
});
