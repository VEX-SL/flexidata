/**
 * Milestone 4 builder tests — bottom-up construction of the structural
 * hierarchy over OCR + segmented blocks: single block, many blocks/regions,
 * empty documents, multi-page trees, adversarial blocks, deterministic
 * rebuilds, bbox/confidence aggregation and the tree invariants.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  NODE_LEVEL,
  REGION_TYPE,
  buildHierarchy,
  createConfidenceProfile,
  createLayoutBlock,
  segmentDocument,
  unionBoxes,
  validateCompleteOcrCoverage,
  validateDeterministicHierarchy,
  validateFrozenHierarchy,
  validateHierarchyContainment,
  validateNoCycles,
  validateParentChain,
  validateSingleParent,
  validateUniqueOwnership,
} from "@/lib/layout";
import type { LayoutBlock } from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { test, ok, equal } from "./harness.ts";

interface WordSpec {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  c?: number;
}

function mkWord(s: WordSpec): OcrWord {
  return {
    text: s.text,
    ...(s.c !== undefined ? { confidence: s.c } : {}),
    bbox: { x: s.x, y: s.y, width: s.w, height: s.h },
  };
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

function row(y: number, xs: readonly number[], w = 40, h = 10, c?: number): OcrLine {
  return mkLine(
    xs.map((x, i) =>
      mkWord({ text: `w${i}`, x, y, w, h, ...(c !== undefined ? { c } : {}) })
    )
  );
}

function paragraph(startY: number, gapY: number, rows: number, xs: readonly number[]): OcrLine[] {
  const out: OcrLine[] = [];
  for (let r = 0; r < rows; r++) out.push(row(startY + r * gapY, xs));
  return out;
}

const neutral = createConfidenceProfile([]);

/** A minimal block for builder rejection tests (cast — not a real build). */
function fakeBlock(overrides: Partial<LayoutBlock> = {}): LayoutBlock {
  return {
    id: "fake",
    page: 0,
    bbox: { x: 0, y: 0, width: 40, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    type: REGION_TYPE.UNKNOWN,
    sourceRefs: [],
    words: [],
    confidence: neutral,
    ...overrides,
  } as LayoutBlock;
}

function throws(fn: () => unknown, needle?: string): Error {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (err === undefined) {
    throw new Error("expected function to throw");
  }
  const message = (err as Error).message;
  if (needle !== undefined && !message.includes(needle)) {
    throw new Error(
      `expected error containing ${JSON.stringify(needle)}, got ${JSON.stringify(message)}`
    );
  }
  return err as Error;
}

// ─── 1. Single block ─────────────────────────────────────────────────────────

test("single block builds the full chain document→page→region→block→lines→words", () => {
  const doc = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const blocks = segmentDocument(doc).blocks;
  equal(blocks.length, 1);
  const h = buildHierarchy(doc, blocks);
  equal(h.rootId, HIERARCHY_DOCUMENT_ID);
  equal(h.nodeCount, 19);
  equal(h.nodesAtLevel(HIERARCHY_ROOT_LEVEL).length, 1);
  equal(h.nodesAtLevel(NODE_LEVEL.PAGE).length, 1);
  equal(h.nodesAtLevel(NODE_LEVEL.REGION).length, 1);
  equal(h.nodesAtLevel(NODE_LEVEL.BLOCK).length, 1);
  equal(h.nodesAtLevel(NODE_LEVEL.LINE).length, 3);
  equal(h.nodesAtLevel(NODE_LEVEL.WORD).length, 12);
  const region = h.get("region-0-0")!;
  equal(region.level, NODE_LEVEL.REGION);
  equal(region.regionType, REGION_TYPE.UNKNOWN);
  equal(region.children, ["block-0"]);
  equal(h.get("block-0")!.children, [
    "line-block-0-0",
    "line-block-0-1",
    "line-block-0-2",
  ]);
});

// ─── 2. Bbox aggregation ─────────────────────────────────────────────────────

test("parent bboxes are exact unions of their children's boxes", () => {
  const doc = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const h = buildHierarchy(doc, segmentDocument(doc).blocks);
  const expected = { x: 0, y: 0, width: 190, height: 38 };
  equal(h.get("document")!.bbox, expected);
  equal(h.get("page-0")!.bbox, expected);
  equal(h.get("region-0-0")!.bbox, expected);
  equal(h.get("block-0")!.bbox, expected);
  equal(h.get("line-block-0-0")!.bbox, { x: 0, y: 0, width: 190, height: 10 });
  equal(h.get("word-0-0-0")!.bbox, { x: 0, y: 0, width: 40, height: 10 });
  equal(h.get("word-0-0-0")!.normalizedBBox.width, 40 / 190);
  ok(validateHierarchyContainment(h.nodes()).valid);
});

// ─── 3. Parent references ────────────────────────────────────────────────────

test("node ids and parent references follow the build contract", () => {
  const doc = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const blocks = segmentDocument(doc).blocks;
  const h = buildHierarchy(doc, blocks);
  equal(h.parentOf("word-0-2-3")!.id, "line-block-0-2");
  equal(h.parentOf("line-block-0-1")!.id, "block-0");
  equal(h.parentOf("block-0")!.id, "region-0-0");
  equal(h.parentOf("region-0-0")!.id, "page-0");
  equal(h.parentOf("page-0")!.id, "document");
  equal(h.parentOf("document"), null);
  equal(h.get("word-0-1-2")!.sourceRefs, [{ pageIndex: 0, lineIndex: 1, wordIndex: 2 }]);
  equal(h.get("word-0-1-2")!.metadata.index, 2);
  equal(h.get("line-block-0-1")!.sourceRefs, [{ pageIndex: 0, lineIndex: 1 }]);
  equal(h.get("block-0")!.sourceRefs, blocks[0].sourceRefs);
  ok(validateSingleParent(h.nodes()).valid);
  ok(validateUniqueOwnership(h.nodes()).valid);
});

// ─── 4. Many blocks → one region ─────────────────────────────────────────────

test("many blocks in one column merge into a single region", () => {
  const lines: OcrLine[] = [];
  for (const start of [0, 50, 100, 150]) {
    lines.push(...paragraph(start, 14, 2, [0, 50, 100, 150]));
  }
  const doc = mkDoc(lines);
  const blocks = segmentDocument(doc).blocks;
  equal(blocks.length, 4);
  const h = buildHierarchy(doc, blocks);
  equal(h.nodesAtLevel(NODE_LEVEL.BLOCK).length, 4);
  equal(h.nodesAtLevel(NODE_LEVEL.REGION).length, 1);
  const region = h.get("region-0-0")!;
  equal(region.children.length, 4);
  equal(region.bbox, { x: 0, y: 0, width: 190, height: 174 });
});

// ─── 5. Many regions ─────────────────────────────────────────────────────────

test("staggered blocks with no shared extent form separate regions", () => {
  const doc = mkDoc([
    row(0, [0, 50, 100, 150]),
    row(400, [500, 550, 600, 650]),
    row(800, [1000, 1050, 1100, 1150]),
  ]);
  const blocks = segmentDocument(doc).blocks;
  equal(blocks.length, 3);
  const h = buildHierarchy(doc, blocks);
  equal(h.nodesAtLevel(NODE_LEVEL.REGION).length, 3);
  const regions = h.nodesAtLevel(NODE_LEVEL.REGION);
  equal(regions.map((r) => r.children.length), [1, 1, 1]);
  equal(h.get("region-0-0")!.bbox, blocks[0].bbox);
  equal(h.get("region-0-1")!.bbox, blocks[1].bbox);
  equal(h.get("region-0-2")!.bbox, blocks[2].bbox);
});

// ─── 6. Empty documents ──────────────────────────────────────────────────────

test("an empty document yields a document-only tree", () => {
  const doc = mkDoc([]);
  const h = buildHierarchy(doc, []);
  equal(h.nodeCount, 1);
  equal(h.root().id, HIERARCHY_DOCUMENT_ID);
  equal(h.root().bbox, { x: 0, y: 0, width: 0, height: 0 });
  equal(h.root().normalizedBBox, { x: 0, y: 0, width: 0, height: 0 });
  ok(validateCompleteOcrCoverage(doc, h).valid);
});

test("a page with only unpositioned words yields a document-only tree", () => {
  const doc: OcrDocument = {
    text: "no boxes",
    lines: [{ text: "no boxes", words: [{ text: "no" }, { text: "boxes" }] }],
  };
  const blocks = segmentDocument(doc).blocks;
  equal(blocks.length, 0);
  const h = buildHierarchy(doc, blocks);
  equal(h.nodeCount, 1);
  ok(validateCompleteOcrCoverage(doc, h).valid);
});

// ─── 7. Multi-page documents ─────────────────────────────────────────────────

test("blocks on different pages produce ordered page subtrees", () => {
  const doc = mkDoc([
    ...paragraph(0, 14, 2, [0, 50, 100, 150]),
    ...paragraph(40, 14, 2, [0, 50, 100, 150]),
  ]);
  const line = doc.lines[2];
  const page1Block = createLayoutBlock({
    id: "block-9",
    page: 1,
    children: line.words.map((word, wi) => ({ lineIndex: 2, wordIndex: wi, word })),
    lines: [line],
    pageSize: { width: 200, height: 200 },
  });
  const h = buildHierarchy(doc, [...segmentDocument(doc).blocks, page1Block]);
  equal(h.nodesAtLevel(NODE_LEVEL.PAGE).length, 2);
  equal(h.root().children, ["page-0", "page-1"]);
  const p1 = h.get("page-1")!;
  equal(p1.children.length, 1);
  equal(h.get(p1.children[0])!.level, NODE_LEVEL.REGION);
  equal(h.get(p1.children[0])!.children, ["block-9"]);
  ok(h.has("word-1-2-0"));
  equal(h.get("word-1-2-0")!.pageIndex, 1);
});

// ─── 8. Overlapping blocks ───────────────────────────────────────────────────

test("overlapping blocks merge into one region", () => {
  const doc = mkDoc([
    mkLine([
      mkWord({ text: "a", x: 0, y: 0, w: 40, h: 10 }),
      mkWord({ text: "b", x: 40, y: 0, w: 40, h: 10 }),
      mkWord({ text: "c", x: 60, y: 0, w: 40, h: 10 }),
    ]),
  ]);
  const line = doc.lines[0];
  const blockA = createLayoutBlock({
    id: "block-a",
    page: 0,
    children: [
      { lineIndex: 0, wordIndex: 0, word: line.words[0] },
      { lineIndex: 0, wordIndex: 1, word: line.words[1] },
    ],
    lines: [line],
    pageSize: { width: 200, height: 200 },
  });
  const blockB = createLayoutBlock({
    id: "block-b",
    page: 0,
    children: [{ lineIndex: 0, wordIndex: 2, word: line.words[2] }],
    lines: [line],
    pageSize: { width: 200, height: 200 },
  });
  const h = buildHierarchy(doc, [blockA, blockB]);
  equal(h.nodesAtLevel(NODE_LEVEL.REGION).length, 1);
  const region = h.get("region-0-0")!;
  equal(region.children, ["block-a", "block-b"]);
  equal(region.bbox, { x: 0, y: 0, width: 100, height: 10 });
  ok(validateCompleteOcrCoverage(doc, h).valid);
});

// ─── 9. Deterministic rebuild ────────────────────────────────────────────────

test("identical input reproduces identical trees regardless of block order", () => {
  const doc = mkDoc([
    ...paragraph(0, 14, 3, [0, 50, 100, 150]),
    ...paragraph(60, 14, 2, [0, 50, 100, 150]),
  ]);
  const blocks = [...segmentDocument(doc).blocks];
  const first = buildHierarchy(doc, blocks);
  const second = buildHierarchy(doc, [...blocks].reverse());
  ok(validateDeterministicHierarchy(first, second).valid);
  equal(first.nodeCount, second.nodeCount);
});

// ─── 10. Missing/unpositioned words ──────────────────────────────────────────

test("builder rejects blocks with mismatched or unpositioned words", () => {
  const doc = mkDoc([row(0, [0, 50])]);
  const orphan = fakeBlock({ sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 0 }] });
  throws(() => buildHierarchy(doc, [orphan]), "sourceRefs/words mismatch");
  const unpositioned = fakeBlock({
    sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 0 }],
    words: [{ text: "x" }],
  });
  throws(() => buildHierarchy(doc, [unpositioned]), "unpositioned word");
});

test("a block referencing an unknown source word is reported by coverage", () => {
  const doc = mkDoc([row(0, [0, 50])]);
  const phantom = fakeBlock({
    sourceRefs: [{ pageIndex: 0, lineIndex: 9, wordIndex: 9 }],
    words: [{ text: "ghost", bbox: { x: 0, y: 0, width: 40, height: 10 } }],
  });
  const h = buildHierarchy(doc, [phantom]);
  const result = validateCompleteOcrCoverage(doc, h);
  ok(!result.valid);
  ok(
    result.errors.some((e) => e.includes("0:9:9")),
    "phantom word is flagged"
  );
});

// ─── 11. Orphan/duplicate rejection ──────────────────────────────────────────

test("a word assigned to two blocks is rejected", () => {
  const doc = mkDoc([row(0, [0, 50])]);
  const word = { text: "a", bbox: { x: 0, y: 0, width: 40, height: 10 } };
  const a = fakeBlock({
    sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 0 }],
    words: [word],
  });
  const b = fakeBlock({
    id: "fake-b",
    sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 0 }],
    words: [word],
  });
  throws(() => buildHierarchy(doc, [a, b]), "assigned to multiple blocks");
});

test("duplicate block ids are rejected", () => {
  const doc = mkDoc([row(0, [0, 50])]);
  const a = fakeBlock({
    sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 0 }],
    words: [{ text: "a", bbox: { x: 0, y: 0, width: 40, height: 10 } }],
  });
  const b = fakeBlock({
    sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 1 }],
    words: [{ text: "b", bbox: { x: 50, y: 0, width: 40, height: 10 } }],
  });
  throws(() => buildHierarchy(doc, [a, b]), "duplicate hierarchy node id");
});

// ─── 12. Confidence aggregation ──────────────────────────────────────────────

test("confidence aggregates bottom-up with the injectable policy", () => {
  const doc = mkDoc([row(0, [0, 50], 40, 10, 0.9), row(14, [0, 50], 40, 10, 0.7)]);
  const h = buildHierarchy(doc, segmentDocument(doc).blocks, {
    confidencePolicy: () => 0.42,
  });
  equal(h.get("word-0-0-0")!.confidence.aggregate.mean, 0.42);
  equal(h.get("line-block-0-0")!.confidence.aggregate.count, 2);
  equal(h.get("line-block-0-0")!.confidence.aggregate.mean, 0.42);
  equal(h.get("block-0")!.confidence.aggregate.count, 2);
  equal(h.get("block-0")!.confidence.aggregate.mean, 0.42);
  equal(h.get("region-0-0")!.confidence.aggregate.count, 1);
  equal(h.get("page-0")!.confidence.aggregate.count, 1);
  equal(h.get("document")!.confidence.aggregate.count, 1);
});

// ─── 13. Tree invariants ─────────────────────────────────────────────────────

test("builder output is acyclic and every chain terminates at the root", () => {
  const doc = mkDoc([
    ...paragraph(0, 14, 2, [0, 50, 100, 150]),
    ...paragraph(60, 14, 2, [0, 50, 100, 150]),
  ]);
  const h = buildHierarchy(doc, segmentDocument(doc).blocks);
  ok(validateParentChain(h.nodes()).valid);
  ok(validateNoCycles(h.nodes()).valid);
});

// ─── 14. Deep immutability ───────────────────────────────────────────────────

test("builder output is deep-frozen", () => {
  const doc = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const h = buildHierarchy(doc, segmentDocument(doc).blocks);
  ok(validateFrozenHierarchy(h).valid);
  for (const node of h.nodes()) {
    ok(Object.isFrozen(node.children), `node ${node.id} children are frozen`);
    ok(Object.isFrozen(node.bbox), `node ${node.id} bbox is frozen`);
  }
});

// ─── 15. Page size option ────────────────────────────────────────────────────

test("an explicit pageSize drives the normalized bboxes", () => {
  const doc = mkDoc(paragraph(0, 14, 2, [0, 50, 100, 150]));
  const h = buildHierarchy(doc, segmentDocument(doc).blocks, {
    pageSize: { width: 1000, height: 1000 },
  });
  equal(h.get("block-0")!.normalizedBBox, { x: 0, y: 0, width: 0.19, height: 0.024 });
});
