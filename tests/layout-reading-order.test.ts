/**
 * Milestone 6 reading order tests — reading-sequence correctness on real
 * documents: OCR reading order is preserved verbatim (Arabic included), every
 * hierarchy level forms one linear chain, multi-column layouts follow the OCR
 * metadata rather than geometric columns, and the produced graph passes every
 * Milestone 6 validator.
 */
import {
  NODE_LEVEL,
  HIERARCHY_ROOT_LEVEL,
  buildHierarchy,
  buildReadingOrder,
  segmentDocument,
  unionBoxes,
  validateReadingOrderAcyclic,
  validateReadingOrderBidirectional,
  validateReadingOrderConnectivity,
  validateReadingOrderCoverage,
  validateReadingOrderDeterminism,
  validateReadingOrderFrozen,
  validateReadingOrderNoDuplicateEdges,
  validateReadingOrderSinglePredecessor,
  validateReadingOrderSingleSuccessor,
  validateReadingOrderTopology,
} from "@/lib/layout";
import type { LayoutHierarchy, ReadingOrderGraph } from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { test, ok, equal } from "./harness.ts";

const ALL_VALIDATORS = [
  validateReadingOrderConnectivity,
  validateReadingOrderCoverage,
  validateReadingOrderDeterminism,
  validateReadingOrderFrozen,
  validateReadingOrderAcyclic,
  validateReadingOrderBidirectional,
  validateReadingOrderSingleSuccessor,
  validateReadingOrderSinglePredecessor,
  validateReadingOrderNoDuplicateEdges,
  validateReadingOrderTopology,
] as const;

interface WordSpec {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function mkWord(s: WordSpec): OcrWord {
  return { text: s.text, bbox: { x: s.x, y: s.y, width: s.w, height: s.h } };
}

function mkLine(words: OcrWord[]): OcrLine {
  const bbox = unionBoxes(words.map((w) => w.bbox!));
  return {
    text: words.map((w) => w.text).join(" "),
    words,
    ...(bbox ? { bbox } : {}),
  };
}

function mkDoc(lines: OcrLine[]): OcrDocument {
  return { text: lines.map((l) => l.text).join("\n"), lines };
}

function row(y: number, xs: readonly number[], w = 40, h = 10): OcrLine {
  return mkLine(xs.map((x, i) => mkWord({ text: `w${i}`, x, y, w, h })));
}

function paragraph(
  startY: number,
  gapY: number,
  rows: number,
  xs: readonly number[]
): OcrLine[] {
  const out: OcrLine[] = [];
  for (let r = 0; r < rows; r++) out.push(row(startY + r * gapY, xs));
  return out;
}

function build(hierarchy: ReturnType<typeof buildHierarchy>): ReadingOrderGraph {
  return buildReadingOrder(hierarchy);
}

function assertAllValidatorsPass(
  graph: ReadingOrderGraph,
  hierarchy: LayoutHierarchy
): void {
  for (const validate of ALL_VALIDATORS) {
    const result =
      validate === validateReadingOrderDeterminism
        ? validate(graph, graph)
        : validate === validateReadingOrderCoverage
          ? validate(hierarchy, graph)
          : validate(graph);
    ok(result.valid, `${validate.name}: ${result.errors.join("; ")}`);
  }
}

/** The produced word chain never regresses the OCR (line, word) order. */
function assertWordOrderPreservesOcr(graph: ReadingOrderGraph): void {
  const words = graph.nodesAtLevel(NODE_LEVEL.WORD);
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1].sourceRefs[0];
    const cur = words[i].sourceRefs[0];
    ok(prev !== undefined && cur !== undefined, "positioned words carry source refs");
    const prevKey = prev!.lineIndex * 1_000_000 + (prev!.wordIndex ?? -1);
    const curKey = cur!.lineIndex * 1_000_000 + (cur!.wordIndex ?? -1);
    ok(
      prevKey <= curKey,
      `word chain regresses OCR order at ${words[i - 1].id} -> ${words[i].id}`
    );
  }
}

/** Consecutive level chains must never regress their source line order. */
function assertLevelChainsFollowSource(graph: ReadingOrderGraph): void {
  for (const level of [NODE_LEVEL.LINE, NODE_LEVEL.BLOCK, NODE_LEVEL.REGION]) {
    const nodes = graph.nodesAtLevel(level);
    for (let i = 1; i < nodes.length; i++) {
      const prevRef = nodes[i - 1].sourceRefs[0];
      const curRef = nodes[i].sourceRefs[0];
      if (prevRef === undefined || curRef === undefined) continue;
      ok(
        prevRef.lineIndex <= curRef.lineIndex,
        `${level} chain regresses source order at ${nodes[i - 1].id} -> ${nodes[i].id}`
      );
    }
  }
}

// ─── 1. Single paragraph ─────────────────────────────────────────────────────

test("single paragraph: word/line chains follow OCR reading order", () => {
  const doc = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(
    graph.readingSequence().slice(0, 12),
    [
      "word-0-0-0", "word-0-0-1", "word-0-0-2", "word-0-0-3",
      "word-0-1-0", "word-0-1-1", "word-0-1-2", "word-0-1-3",
      "word-0-2-0", "word-0-2-1", "word-0-2-2", "word-0-2-3",
    ]
  );
  equal(graph.nodesAtLevel(NODE_LEVEL.LINE).map((n) => n.id), [
    "line-block-0-0",
    "line-block-0-1",
    "line-block-0-2",
  ]);
  equal(graph.nodesAtLevel(NODE_LEVEL.BLOCK).map((n) => n.id), ["block-0"]);
  equal(graph.nodesAtLevel(NODE_LEVEL.REGION).map((n) => n.id), ["region-0-0"]);
  equal(graph.nodesAtLevel(NODE_LEVEL.PAGE).map((n) => n.id), ["page-0"]);
  equal(graph.nodesAtLevel(HIERARCHY_ROOT_LEVEL).map((n) => n.id), ["document"]);
  equal(graph.nodeCount, hierarchy.nodeCount);
  equal(graph.readingSequence().length, 19);
  equal(graph.positionOf("document"), 18);
  assertAllValidatorsPass(graph, hierarchy);
});

// ─── 2. Multiple paragraphs ──────────────────────────────────────────────────

test("multiple paragraphs chain in OCR order and form one region", () => {
  const lines: OcrLine[] = [];
  for (const start of [0, 50, 100]) {
    lines.push(...paragraph(start, 14, 2, [0, 50, 100, 150]));
  }
  const doc = mkDoc(lines);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  ok(graph.nodesAtLevel(NODE_LEVEL.BLOCK).length >= 3, "has separate blocks");
  assertWordOrderPreservesOcr(graph);
  assertLevelChainsFollowSource(graph);
  assertAllValidatorsPass(graph, hierarchy);
});

// ─── 3. Two-column / three-column ────────────────────────────────────────────

function columnDoc(columns: readonly readonly number[][]): OcrDocument {
  const lines: OcrLine[] = [];
  for (let r = 0; r < 3; r++) {
    for (const col of columns) lines.push(row(r * 14, col));
  }
  return mkDoc(lines);
}

test("two-column layout follows OCR metadata, not geometric columns", () => {
  const doc = columnDoc([
    [0, 50, 100, 150],
    [600, 650, 700, 750],
  ]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.BLOCK).length, 2);
  equal(graph.nodesAtLevel(NODE_LEVEL.BLOCK).map((n) => n.id), ["block-0", "block-1"]);
  equal(graph.nodesAtLevel(NODE_LEVEL.REGION).map((n) => n.id), [
    "region-0-0",
    "region-0-1",
  ]);
  // The word chain is exactly the OCR source order (interleaved columns).
  equal(
    graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id),
    [
      "word-0-0-0", "word-0-0-1", "word-0-0-2", "word-0-0-3",
      "word-0-1-0", "word-0-1-1", "word-0-1-2", "word-0-1-3",
      "word-0-2-0", "word-0-2-1", "word-0-2-2", "word-0-2-3",
      "word-0-3-0", "word-0-3-1", "word-0-3-2", "word-0-3-3",
      "word-0-4-0", "word-0-4-1", "word-0-4-2", "word-0-4-3",
      "word-0-5-0", "word-0-5-1", "word-0-5-2", "word-0-5-3",
    ]
  );
  assertAllValidatorsPass(graph, hierarchy);
});

test("three-column layout chains every column once in source order", () => {
  const doc = columnDoc([
    [0, 50, 100, 150],
    [600, 650, 700, 750],
    [1200, 1250, 1300, 1350],
  ]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.BLOCK).length, 3);
  equal(graph.nodesAtLevel(NODE_LEVEL.BLOCK).map((n) => n.id), [
    "block-0",
    "block-1",
    "block-2",
  ]);
  equal(graph.nodesAtLevel(NODE_LEVEL.REGION).length, 3);
  assertWordOrderPreservesOcr(graph);
  assertAllValidatorsPass(graph, hierarchy);
});

// ─── 4. Arabic / English / mixed ─────────────────────────────────────────────

test("Arabic line keeps the OCR word order (no RTL-specific rules)", () => {
  // An Arabic OCR line emits words in reading order; the boxes run right to
  // left (decreasing x). The builder must preserve the metadata order and must
  // NOT re-sort by x.
  const doc = mkDoc([
    mkLine([
      mkWord({ text: "w0", x: 300, y: 0, w: 40, h: 10 }),
      mkWord({ text: "w1", x: 200, y: 0, w: 40, h: 10 }),
      mkWord({ text: "w2", x: 100, y: 0, w: 40, h: 10 }),
    ]),
  ]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(
    graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id),
    ["word-0-0-0", "word-0-0-1", "word-0-0-2"]
  );
  assertAllValidatorsPass(graph, hierarchy);
});

test("English, Arabic and mixed-script lines preserve OCR order", () => {
  const doc = mkDoc([
    mkLine([
      mkWord({ text: "a", x: 0, y: 0, w: 40, h: 10 }),
      mkWord({ text: "b", x: 50, y: 0, w: 40, h: 10 }),
    ]),
    mkLine([
      mkWord({ text: "c", x: 300, y: 14, w: 40, h: 10 }),
      mkWord({ text: "d", x: 200, y: 14, w: 40, h: 10 }),
    ]),
    mkLine([
      mkWord({ text: "e", x: 0, y: 28, w: 40, h: 10 }),
      mkWord({ text: "f", x: 260, y: 28, w: 40, h: 10 }),
    ]),
  ]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(
    graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id),
    [
      "word-0-0-0", "word-0-0-1",
      "word-0-1-0", "word-0-1-1",
      "word-0-2-0", "word-0-2-1",
    ]
  );
  assertAllValidatorsPass(graph, hierarchy);
});

// ─── 5. Document-type scenarios ──────────────────────────────────────────────

test("receipt-like narrow document chains in OCR order", () => {
  const lines: OcrLine[] = [];
  for (let r = 0; r < 12; r++) lines.push(row(r * 16, [0, 50, 100]));
  const doc = mkDoc(lines);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).length, 36);
  assertWordOrderPreservesOcr(graph);
  assertLevelChainsFollowSource(graph);
  assertAllValidatorsPass(graph, hierarchy);
});

test("invoice-like header/table/footer document chains in OCR order", () => {
  const lines: OcrLine[] = [
    row(0, [0, 50, 100, 150, 200, 250, 300]),
    row(14, [0, 50, 100, 150, 200, 250, 300]),
    ...paragraph(40, 14, 4, [0, 50, 100, 150]),
    row(140, [0, 50, 100, 150, 200, 250, 300]),
  ];
  const doc = mkDoc(lines);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  ok(graph.nodesAtLevel(NODE_LEVEL.BLOCK).length >= 3, "has multiple blocks");
  assertWordOrderPreservesOcr(graph);
  assertLevelChainsFollowSource(graph);
  assertAllValidatorsPass(graph, hierarchy);
});

test("contract-like long paragraphs chain in OCR order", () => {
  const lines: OcrLine[] = [];
  for (let p = 0; p < 6; p++) {
    lines.push(...paragraph(p * 120, 16, 6, [0, 50, 100, 150, 200, 250]));
  }
  const doc = mkDoc(lines);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).length, 216);
  assertWordOrderPreservesOcr(graph);
  assertLevelChainsFollowSource(graph);
  assertAllValidatorsPass(graph, hierarchy);
});

test("magazine-like multi-column document chains in OCR order", () => {
  const doc = columnDoc([
    [0, 50, 100, 150],
    [600, 650, 700, 750],
  ]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  ok(graph.nodesAtLevel(NODE_LEVEL.REGION).length === 2, "two magazine columns");
  assertWordOrderPreservesOcr(graph);
  assertAllValidatorsPass(graph, hierarchy);
});

// ─── 6. Dense / sparse / touching / overlapping / missing bbox ───────────────

test("dense OCR preserves the full reading order", () => {
  const lines: OcrLine[] = [];
  for (let r = 0; r < 30; r++) {
    lines.push(row(r * 2, [0, 6, 12, 18, 24, 30, 36], 5, 2));
  }
  const doc = mkDoc(lines);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).length, 210);
  assertWordOrderPreservesOcr(graph);
  assertAllValidatorsPass(graph, hierarchy);
});

test("sparse OCR preserves the full reading order", () => {
  const lines: OcrLine[] = [];
  for (let r = 0; r < 8; r++) {
    lines.push(row(r * 400, [0, 500, 1000, 1500], 100, 30));
  }
  const doc = mkDoc(lines);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).length, 32);
  assertWordOrderPreservesOcr(graph);
  assertLevelChainsFollowSource(graph);
  assertAllValidatorsPass(graph, hierarchy);
});

test("touching boxes chain in source order", () => {
  const doc = mkDoc([
    mkLine([
      mkWord({ text: "a", x: 0, y: 0, w: 10, h: 10 }),
      mkWord({ text: "b", x: 10, y: 0, w: 10, h: 10 }),
      mkWord({ text: "c", x: 20, y: 0, w: 10, h: 10 }),
    ]),
  ]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(
    graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id),
    ["word-0-0-0", "word-0-0-1", "word-0-0-2"]
  );
  assertAllValidatorsPass(graph, hierarchy);
});

test("overlapping boxes chain in source order (metadata wins over geometry)", () => {
  const doc = mkDoc([
    mkLine([
      mkWord({ text: "a", x: 0, y: 0, w: 20, h: 10 }),
      mkWord({ text: "b", x: 5, y: 0, w: 20, h: 10 }),
      mkWord({ text: "c", x: 10, y: 0, w: 20, h: 10 }),
    ]),
  ]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(
    graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id),
    ["word-0-0-0", "word-0-0-1", "word-0-0-2"]
  );
  assertAllValidatorsPass(graph, hierarchy);
});

test("missing-bbox words are out of scope; the rest chain in source order", () => {
  const doc: OcrDocument = {
    text: "a b c",
    lines: [
      {
        text: "a b c",
        words: [
          { text: "a", bbox: { x: 0, y: 0, width: 10, height: 10 } },
          { text: "b" },
          { text: "c", bbox: { x: 20, y: 0, width: 10, height: 10 } },
        ],
      },
      {
        text: "d e",
        words: [
          { text: "d", bbox: { x: 0, y: 20, width: 10, height: 10 } },
          { text: "e", bbox: { x: 20, y: 20, width: 10, height: 10 } },
        ],
      },
    ],
  };
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(
    graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id),
    ["word-0-0-0", "word-0-0-2", "word-0-1-0", "word-0-1-1"]
  );
  ok(!graph.has("word-0-0-1"), "unpositioned word is not in the graph");
  assertAllValidatorsPass(graph, hierarchy);
});

// ─── 7. Single word / single line ────────────────────────────────────────────

test("single word builds a one-node chain with no edges", () => {
  const doc = mkDoc([row(0, [0])]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id), ["word-0-0-0"]);
  equal(graph.next("word-0-0-0"), undefined);
  equal(graph.prev("word-0-0-0"), undefined);
  equal(graph.edgeCount, 0);
  assertAllValidatorsPass(graph, hierarchy);
});

test("single line builds a one-line chain", () => {
  const doc = mkDoc([row(0, [0, 50, 100])]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.LINE).map((n) => n.id), ["line-block-0-0"]);
  assertAllValidatorsPass(graph, hierarchy);
});

// ─── 8. Large document / thousands of words ──────────────────────────────────

test("thousands of words build a complete deterministic chain", () => {
  const rows = 250;
  const perRow = 12;
  const xs: number[] = [];
  for (let i = 0; i < perRow; i++) xs.push(i * 12);
  const lines: OcrLine[] = [];
  for (let r = 0; r < rows; r++) lines.push(row(r * 14, xs, 10, 8));
  const doc = mkDoc(lines);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).length, rows * perRow);
  const wordCount = graph.nodesAtLevel(NODE_LEVEL.WORD).length;
  const lineCount = graph.nodesAtLevel(NODE_LEVEL.LINE).length;
  equal(
    graph.edgeCount,
    2 * (wordCount - 1) + 2 * (lineCount - 1),
    "word and line chains generate exactly the NEXT/PREVIOUS edge pairs"
  );
  assertWordOrderPreservesOcr(graph);
  assertAllValidatorsPass(graph, hierarchy);
});
