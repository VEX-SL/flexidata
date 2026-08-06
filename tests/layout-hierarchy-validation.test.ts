/**
 * Milestone 4 hierarchy validation tests — the nine M4 tree contract checks:
 * single-parent, unique ownership, containment, chain termination, page
 * ownership, acyclicity, deep-frozen output, deterministic rebuilds and
 * complete OCR coverage.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  NODE_LEVEL,
  REGION_TYPE,
  LayoutHierarchy,
  buildHierarchy,
  createConfidenceProfile,
  createHierarchyNode,
  createLayoutBlock,
  segmentDocument,
  unionBoxes,
  validateCompleteOcrCoverage,
  validateDeterministicHierarchy,
  validateFrozenHierarchy,
  validateHierarchyContainment,
  validateNoCycles,
  validatePageOwnership,
  validateParentChain,
  validateSingleParent,
  validateUniqueOwnership,
} from "@/lib/layout";
import type { HierarchyLevel, HierarchyNode } from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { test, ok } from "./harness.ts";

const neutral = createConfidenceProfile([]);

function wordNode(id: string, wi: number, parentId = "line-0"): HierarchyNode {
  return createHierarchyNode({
    id,
    level: NODE_LEVEL.WORD,
    parentId,
    pageIndex: 0,
    bbox: { x: wi * 20, y: 0, width: 20, height: 8 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: [],
    sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: wi }],
    metadata: { index: wi },
  });
}

/** A generic node factory for rejection tests. */
function n(
  id: string,
  level: HierarchyLevel,
  parentId: string | null,
  children: string[] = [],
  pageIndex = 0
): HierarchyNode {
  return createHierarchyNode({
    id,
    level,
    parentId,
    pageIndex,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children,
    sourceRefs: [],
    metadata: level === NODE_LEVEL.PAGE ? { index: pageIndex } : {},
    ...(level === NODE_LEVEL.REGION ? { regionType: REGION_TYPE.UNKNOWN } : {}),
  });
}

/** A structurally valid chain the structural validators should accept. */
function validNodes(): HierarchyNode[] {
  const doc = createHierarchyNode({
    id: HIERARCHY_DOCUMENT_ID,
    level: HIERARCHY_ROOT_LEVEL,
    parentId: null,
    pageIndex: -1,
    bbox: { x: 0, y: 0, width: 60, height: 40 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["page-0"],
    sourceRefs: [],
    metadata: {},
  });
  const page = createHierarchyNode({
    id: "page-0",
    level: NODE_LEVEL.PAGE,
    parentId: HIERARCHY_DOCUMENT_ID,
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 60, height: 40 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["region-0"],
    sourceRefs: [],
    metadata: { index: 0 },
  });
  const region = createHierarchyNode({
    id: "region-0",
    level: NODE_LEVEL.REGION,
    parentId: "page-0",
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 60, height: 8 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["block-0"],
    sourceRefs: [],
    metadata: {},
    regionType: REGION_TYPE.UNKNOWN,
  });
  const block = createHierarchyNode({
    id: "block-0",
    level: NODE_LEVEL.BLOCK,
    parentId: "region-0",
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 60, height: 8 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["line-0"],
    sourceRefs: [],
    metadata: {},
  });
  const line = createHierarchyNode({
    id: "line-0",
    level: NODE_LEVEL.LINE,
    parentId: "block-0",
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 60, height: 8 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["word-0", "word-1"],
    sourceRefs: [{ pageIndex: 0, lineIndex: 0 }],
    metadata: {},
  });
  return [
    doc,
    page,
    region,
    block,
    line,
    wordNode("word-0", 0),
    wordNode("word-1", 1),
  ];
}

function hasError(errors: readonly string[], fragment: string): boolean {
  return errors.some((e) => e.includes(fragment));
}

// ─── OCR helpers for real builds ─────────────────────────────────────────────

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

// ─── validateSingleParent ────────────────────────────────────────────────────

test("validateSingleParent accepts a well-formed tree", () => {
  ok(validateSingleParent(validNodes()).valid);
});

test("validateSingleParent rejects an unknown parent", () => {
  const nodes = validNodes();
  nodes[6] = { ...nodes[6], parentId: "ghost" };
  const result = validateSingleParent(nodes);
  ok(!result.valid);
  ok(hasError(result.errors, "unknown parent ghost"));
});

test("validateSingleParent rejects a parent that does not list the child", () => {
  const nodes = validNodes();
  const extra = { ...wordNode("word-2", 2), parentId: "line-0" };
  const result = validateSingleParent([...nodes, extra]);
  ok(!result.valid);
  ok(hasError(result.errors, "word-2 is not listed by its parent line-0"));
});

// ─── validateUniqueOwnership ─────────────────────────────────────────────────

test("validateUniqueOwnership accepts disjoint ownership", () => {
  ok(validateUniqueOwnership(validNodes()).valid);
});

test("validateUniqueOwnership rejects a duplicate child within one parent", () => {
  const nodes = validNodes();
  const line = nodes[4];
  nodes[4] = { ...line, children: ["word-0", "word-0"] };
  const result = validateUniqueOwnership(nodes);
  ok(!result.valid);
  ok(hasError(result.errors, "lists child word-0 more than once"));
});

test("validateUniqueOwnership rejects a child owned by two parents", () => {
  const nodes = validNodes();
  const doc = nodes[0];
  nodes[0] = { ...doc, children: ["page-0", "word-0"] };
  const result = validateUniqueOwnership(nodes);
  ok(!result.valid);
  ok(hasError(result.errors, "word-0 is owned by both document and line-0"));
});

// ─── validateHierarchyContainment ────────────────────────────────────────────

test("validateHierarchyContainment accepts contained children", () => {
  ok(validateHierarchyContainment(validNodes()).valid);
});

test("validateHierarchyContainment rejects an escaping child", () => {
  const nodes = validNodes();
  const block = nodes[3];
  nodes[3] = { ...block, bbox: { x: 0, y: 0, width: 30, height: 8 } };
  const result = validateHierarchyContainment(nodes);
  ok(!result.valid);
  ok(hasError(result.errors, "block-0 does not contain child line-0"));
});

// ─── validateParentChain ─────────────────────────────────────────────────────

test("validateParentChain accepts a single rooted chain", () => {
  ok(validateParentChain(validNodes()).valid);
});

test("validateParentChain rejects multiple roots", () => {
  const nodes = validNodes();
  nodes.push({ ...wordNode("word-9", 9), parentId: null });
  const result = validateParentChain(nodes);
  ok(!result.valid);
  ok(hasError(result.errors, "expected exactly one root node, found 2"));
});

test("validateParentChain rejects a chain that never terminates", () => {
  const result = validateParentChain([
    n("a", NODE_LEVEL.WORD, "b"),
    n("b", NODE_LEVEL.WORD, "a"),
  ]);
  ok(!result.valid);
  ok(hasError(result.errors, "does not terminate"));
});

// ─── validatePageOwnership ───────────────────────────────────────────────────

test("validatePageOwnership accepts consistent page assignments", () => {
  ok(validatePageOwnership(validNodes()).valid);
});

test("validatePageOwnership rejects a node whose page mismatches its page ancestor", () => {
  const nodes = validNodes();
  const block = nodes[3];
  nodes[3] = { ...block, pageIndex: 1 };
  const result = validatePageOwnership(nodes);
  ok(!result.valid);
  ok(hasError(result.errors, "block-0 has page 1 but its page ancestor is 0"));
});

test("validatePageOwnership rejects a source ref page mismatch", () => {
  const nodes = validNodes();
  const word = nodes[6];
  nodes[6] = { ...word, sourceRefs: [{ pageIndex: 2, lineIndex: 0, wordIndex: 1 }] };
  const result = validatePageOwnership(nodes);
  ok(!result.valid);
  ok(hasError(result.errors, "does not match its source ref page 2"));
});

test("validatePageOwnership rejects a node with no page ancestor", () => {
  const nodes = validNodes();
  nodes.pop();
  nodes.pop();
  const line = nodes[4];
  nodes[4] = { ...line, parentId: null };
  const result = validatePageOwnership(nodes);
  ok(!result.valid);
  ok(hasError(result.errors, "no page ancestor"));
});

// ─── validateNoCycles ────────────────────────────────────────────────────────

test("validateNoCycles accepts an acyclic tree", () => {
  ok(validateNoCycles(validNodes()).valid);
});

test("validateNoCycles rejects a parent cycle", () => {
  const result = validateNoCycles([
    n("a", NODE_LEVEL.WORD, "b"),
    n("b", NODE_LEVEL.WORD, "a"),
  ]);
  ok(!result.valid);
  ok(hasError(result.errors, "cycle detected through node a"));
});

// ─── validateFrozenHierarchy ─────────────────────────────────────────────────

test("validateFrozenHierarchy accepts a built hierarchy", () => {
  const doc = mkDoc(paragraph(0, 14, 2, [0, 50, 100, 150]));
  const h = buildHierarchy(doc, segmentDocument(doc).blocks);
  ok(validateFrozenHierarchy(h).valid);
});

test("validateFrozenHierarchy rejects unfrozen structures", () => {
  const plain: HierarchyNode = {
    id: HIERARCHY_DOCUMENT_ID,
    level: HIERARCHY_ROOT_LEVEL,
    parentId: null,
    pageIndex: -1,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: [],
    sourceRefs: [],
    metadata: {},
  };
  const hierarchy = new LayoutHierarchy([plain]);
  const result = validateFrozenHierarchy(hierarchy);
  ok(!result.valid);
  ok(hasError(result.errors, "bbox"));
});

// ─── validateDeterministicHierarchy ──────────────────────────────────────────

test("validateDeterministicHierarchy accepts identical builds", () => {
  const doc = mkDoc(paragraph(0, 14, 2, [0, 50, 100, 150]));
  const first = buildHierarchy(doc, segmentDocument(doc).blocks);
  const second = buildHierarchy(doc, segmentDocument(doc).blocks);
  ok(validateDeterministicHierarchy(first, second).valid);
});

test("validateDeterministicHierarchy rejects differing builds", () => {
  const doc = mkDoc(paragraph(0, 14, 2, [0, 50, 100, 150]));
  const first = buildHierarchy(doc, segmentDocument(doc).blocks);
  const second = buildHierarchy(mkDoc([]), []);
  const result = validateDeterministicHierarchy(first, second);
  ok(!result.valid);
  ok(hasError(result.errors, "node count differs"));
});

// ─── validateCompleteOcrCoverage ─────────────────────────────────────────────

test("validateCompleteOcrCoverage accepts a full build", () => {
  const doc = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const h = buildHierarchy(doc, segmentDocument(doc).blocks);
  ok(validateCompleteOcrCoverage(doc, h).valid);
});

test("validateCompleteOcrCoverage ignores unpositioned words", () => {
  const doc: OcrDocument = {
    text: "x",
    lines: [
      {
        text: "x",
        words: [
          { text: "x", bbox: { x: 0, y: 0, width: 10, height: 10 } },
          { text: "no-box" },
        ],
      },
    ],
  };
  const h = buildHierarchy(doc, segmentDocument(doc).blocks);
  ok(validateCompleteOcrCoverage(doc, h).valid);
});

test("validateCompleteOcrCoverage reports uncovered positioned words", () => {
  const doc = mkDoc([row(0, [0, 50]), row(14, [0, 50])]);
  const line = doc.lines[0];
  const partial = createLayoutBlock({
    id: "partial",
    page: 0,
    children: line.words.map((word, wi) => ({ lineIndex: 0, wordIndex: wi, word })),
    lines: [line],
    pageSize: { width: 200, height: 200 },
  });
  const h = buildHierarchy(doc, [partial]);
  const result = validateCompleteOcrCoverage(doc, h);
  ok(!result.valid);
  ok(hasError(result.errors, "0:1:0 is not covered"));
});

test("validateCompleteOcrCoverage rejects phantom source words", () => {
  const doc = mkDoc([row(0, [0, 50])]);
  const phantom = createLayoutBlock({
    id: "phantom",
    page: 0,
    children: [
      { lineIndex: 9, wordIndex: 9, word: { text: "x", bbox: { x: 0, y: 0, width: 40, height: 10 } } },
    ],
    lines: [],
    pageSize: { width: 200, height: 200 },
  });
  const h = buildHierarchy(doc, [phantom]);
  const result = validateCompleteOcrCoverage(doc, h);
  ok(!result.valid);
  ok(hasError(result.errors, "0:9:9"));
});

// ─── Integrated: a real build satisfies every validator ──────────────────────

test("a built hierarchy satisfies every validator", () => {
  const doc = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const blocks = segmentDocument(doc).blocks;
  const h = buildHierarchy(doc, blocks);
  ok(validateSingleParent(h.nodes()).valid);
  ok(validateUniqueOwnership(h.nodes()).valid);
  ok(validateHierarchyContainment(h.nodes()).valid);
  ok(validateParentChain(h.nodes()).valid);
  ok(validatePageOwnership(h.nodes()).valid);
  ok(validateNoCycles(h.nodes()).valid);
  ok(validateFrozenHierarchy(h).valid);
  ok(validateCompleteOcrCoverage(doc, h).valid);
  const second = buildHierarchy(doc, blocks);
  ok(validateDeterministicHierarchy(h, second).valid);
});
