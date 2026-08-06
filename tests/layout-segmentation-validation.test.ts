/**
 * M3 block validation tests — assignment-once, non-empty blocks, valid boxes,
 * deep-frozen output, full word coverage and deterministic re-runs.
 */
import {
  REGION_TYPE,
  createConfidenceProfile,
  segmentDocument,
  validateBlockAssignments,
  validateBlockBoxes,
  validateFrozenBlocks,
  validateFullWordCoverage,
  validateNoEmptyBlocks,
  validateSegmentationDeterminism,
  validationResult,
} from "@/lib/layout";
import type { LayoutBlock, SegmentationResult } from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { test, ok, equal } from "./harness.ts";

function mkWord(text: string, x: number, y: number): OcrWord {
  return { text, bbox: { x, y, width: 40, height: 10 } };
}

function paragraphDoc(): OcrDocument {
  const line0: OcrLine = {
    text: "aa bb",
    words: [mkWord("aa", 0, 0), mkWord("bb", 50, 0)],
    bbox: { x: 0, y: 0, width: 90, height: 10 },
  };
  const line1: OcrLine = {
    text: "cc dd",
    words: [mkWord("cc", 0, 14), mkWord("dd", 50, 14)],
    bbox: { x: 0, y: 14, width: 90, height: 10 },
  };
  return { text: "aa bb\ncc dd", lines: [line0, line1] };
}

function fakeBlock(overrides: Partial<LayoutBlock> = {}): LayoutBlock {
  return {
    id: "fake",
    page: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    type: REGION_TYPE.UNKNOWN,
    sourceRefs: [],
    ocrLineIndices: [],
    ocrWordKeys: [],
    words: [],
    lines: [],
    densityMetrics: {
      wordCount: 0,
      lineCount: 0,
      charCount: 0,
      area: 100,
      wordDensity: 0,
      lineDensity: 0,
    },
    spacingMetrics: {
      meanHorizontalGap: 0,
      meanVerticalGap: 0,
      horizontalGapVariance: 0,
      maxHorizontalGap: 0,
    },
    confidence: createConfidenceProfile([]),
    geometry: {
      center: { x: 5, y: 5 },
      top: 0,
      left: 0,
      right: 10,
      bottom: 10,
      width: 10,
      height: 10,
      area: 100,
      aspectRatio: 1,
    },
    ...overrides,
  } as LayoutBlock;
}

function refs(entries: Array<[number, number, number]>): Array<{
  pageIndex: number;
  lineIndex: number;
  wordIndex: number;
}> {
  return entries.map(([pageIndex, lineIndex, wordIndex]) => ({
    pageIndex,
    lineIndex,
    wordIndex,
  }));
}

function hasError(errors: readonly string[], fragment: string): boolean {
  return errors.some((e) => e.includes(fragment));
}

// ─── shared factory ──────────────────────────────────────────────────────────

test("validationResult is a frozen shared factory", () => {
  const r = validationResult(["boom"]);
  ok(!r.valid);
  equal(r.errors, ["boom"]);
  ok(Object.isFrozen(r));
  ok(Object.isFrozen(r.errors));
});

// ─── validateBlockAssignments ────────────────────────────────────────────────

test("validateBlockAssignments accepts disjoint blocks", () => {
  const a = fakeBlock({ sourceRefs: refs([[0, 0, 0], [0, 0, 1]]) });
  const b = fakeBlock({ sourceRefs: refs([[0, 1, 0], [0, 1, 1]]) });
  const result = validateBlockAssignments([a, b]);
  ok(result.valid);
  equal(result.errors, []);
});

test("validateBlockAssignments rejects a word in two blocks", () => {
  const a = fakeBlock({ sourceRefs: refs([[0, 1, 2]]) });
  const b = fakeBlock({ sourceRefs: refs([[0, 1, 2]]) });
  const result = validateBlockAssignments([a, b]);
  ok(!result.valid);
  ok(hasError(result.errors, "word 0:1:2 is assigned to multiple blocks"));
});

test("validateBlockAssignments rejects a duplicate within one block", () => {
  const a = fakeBlock({ sourceRefs: refs([[0, 0, 0], [0, 0, 0]]) });
  ok(!validateBlockAssignments([a]).valid);
});

// ─── validateNoEmptyBlocks ───────────────────────────────────────────────────

test("validateNoEmptyBlocks rejects an empty block", () => {
  const result = validateNoEmptyBlocks([fakeBlock()]);
  ok(!result.valid);
  ok(hasError(result.errors, "block fake has no words"));
});

test("validateNoEmptyBlocks accepts non-empty blocks", () => {
  const block = fakeBlock({ sourceRefs: refs([[0, 0, 0]]) });
  ok(validateNoEmptyBlocks([block]).valid);
});

// ─── validateBlockBoxes ──────────────────────────────────────────────────────

test("validateBlockBoxes accepts valid boxes", () => {
  const block = fakeBlock({
    sourceRefs: refs([[0, 0, 0]]),
    bbox: { x: 0, y: 0, width: 40, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
  });
  ok(validateBlockBoxes([block]).valid);
});

test("validateBlockBoxes rejects zero-area boxes", () => {
  const block = fakeBlock({
    bbox: { x: 0, y: 0, width: 0, height: 10 },
  });
  const result = validateBlockBoxes([block]);
  ok(!result.valid);
  ok(hasError(result.errors, "block fake has an invalid bbox"));
});

test("validateBlockBoxes rejects non-finite normalized boxes", () => {
  const block = fakeBlock({
    normalizedBBox: { x: 0, y: 0, width: NaN, height: 1 },
  });
  const result = validateBlockBoxes([block]);
  ok(!result.valid);
  ok(hasError(result.errors, "block fake has an invalid normalized bbox"));
});

// ─── validateFrozenBlocks ────────────────────────────────────────────────────

test("validateFrozenBlocks accepts segmentation output", () => {
  const result = segmentDocument(paragraphDoc());
  ok(validateFrozenBlocks(result.blocks).valid);
});

test("validateFrozenBlocks rejects unfrozen structures", () => {
  const result = validateFrozenBlocks([fakeBlock()]);
  ok(!result.valid);
  ok(hasError(result.errors, "block fake is not deep-frozen at bbox"));
});

// ─── validateFullWordCoverage ────────────────────────────────────────────────

test("validateFullWordCoverage accepts a full segmentation", () => {
  const doc = paragraphDoc();
  const result = segmentDocument(doc);
  ok(validateFullWordCoverage(doc, result.blocks).valid);
});

test("validateFullWordCoverage reports unassigned positioned words", () => {
  const doc = paragraphDoc();
  const partial = fakeBlock({
    id: "only-first",
    sourceRefs: refs([[0, 0, 0]]),
  });
  const result = validateFullWordCoverage(doc, [partial]);
  ok(!result.valid);
  ok(hasError(result.errors, "word 0:1 is not assigned to any block"));
});

test("validateFullWordCoverage reports phantom references", () => {
  const doc = paragraphDoc();
  const phantom = fakeBlock({ sourceRefs: refs([[0, 9, 9]]) });
  const result = validateFullWordCoverage(doc, [phantom]);
  ok(!result.valid);
  ok(hasError(result.errors, "block references unknown word 9:9"));
});

test("validateFullWordCoverage ignores unpositioned words", () => {
  const line: OcrLine = {
    text: "x",
    words: [
      mkWord("x", 0, 0),
      { text: "no-box" },
    ],
  };
  const doc: OcrDocument = { text: "x", lines: [line] };
  const result = segmentDocument(doc);
  equal(result.skippedWordCount, 1);
  ok(validateFullWordCoverage(doc, result.blocks).valid);
});

// ─── validateSegmentationDeterminism ─────────────────────────────────────────

test("validateSegmentationDeterminism accepts identical runs", () => {
  const doc = paragraphDoc();
  const first = segmentDocument(doc);
  const second = segmentDocument(doc);
  ok(validateSegmentationDeterminism(first, second).valid);
});

test("validateSegmentationDeterminism rejects differing thresholds", () => {
  const doc = paragraphDoc();
  const first = segmentDocument(doc);
  const second: SegmentationResult = {
    ...first,
    thresholds: { horizontal: 1, vertical: 1 },
  };
  const result = validateSegmentationDeterminism(first, second);
  ok(!result.valid);
  ok(hasError(result.errors, "adaptive thresholds differ"));
});

test("validateSegmentationDeterminism rejects differing block counts", () => {
  const doc = paragraphDoc();
  const first = segmentDocument(doc);
  const second: SegmentationResult = {
    ...first,
    blocks: first.blocks.slice(0, 0),
  };
  const result = validateSegmentationDeterminism(first, second);
  ok(!result.valid);
  ok(hasError(result.errors, "block count differs"));
});
