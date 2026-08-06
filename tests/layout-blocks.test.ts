/**
 * LayoutBlock model tests — immutable construction, deep freezing, metrics,
 * confidence profile and geometry summary.
 */
import {
  REGION_TYPE,
  computeBlockGeometry,
  computeBlockSpacingMetrics,
  buildBlockConfidence,
  createLayoutBlock,
} from "@/lib/layout";
import type { BlockChild } from "@/lib/layout";
import type { OcrLine, OcrWord } from "@/lib/pipeline/types";
import { test, ok, equal } from "./harness.ts";

function approx(actual: number, expected: number, eps = 1e-9): void {
  ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} within ${eps}`
  );
}

function word(
  text: string,
  x: number,
  y: number,
  confidence?: number
): OcrWord {
  return {
    text,
    ...(confidence !== undefined ? { confidence } : {}),
    bbox: { x, y, width: 40, height: 10 },
  };
}

/** A 2-line paragraph: line0 = aa/bb, line1 = cc/dd. */
function twoLineParagraph(): {
  children: BlockChild[];
  lines: OcrLine[];
} {
  const w00 = word("aa", 0, 0, 0.9);
  const w01 = word("bb", 50, 0, 0.7);
  const w10 = word("cc", 0, 14);
  const w11 = word("dd", 50, 14, 0.8);
  const line0: OcrLine = {
    text: "aa bb",
    confidence: 0.8,
    words: [w00, w01],
    bbox: { x: 0, y: 0, width: 90, height: 10 },
  };
  const line1: OcrLine = {
    text: "cc dd",
    words: [w10, w11],
    bbox: { x: 0, y: 14, width: 90, height: 10 },
  };
  return {
    children: [
      { lineIndex: 0, wordIndex: 0, word: w00 },
      { lineIndex: 0, wordIndex: 1, word: w01 },
      { lineIndex: 1, wordIndex: 0, word: w10 },
      { lineIndex: 1, wordIndex: 1, word: w11 },
    ],
    lines: [line0, line1],
  };
}

// ─── Construction ────────────────────────────────────────────────────────────

test("createLayoutBlock builds a typed UNKNOWN block", () => {
  const { children, lines } = twoLineParagraph();
  const block = createLayoutBlock({
    id: "block-0",
    page: 0,
    children,
    lines,
    pageSize: { width: 180, height: 48 },
  });
  equal(block.id, "block-0");
  equal(block.page, 0);
  equal(block.type, REGION_TYPE.UNKNOWN);
  equal(block.sourceRefs.length, 4);
  equal(block.ocrLineIndices, [0, 1]);
  equal(block.ocrWordKeys, ["0:0", "0:1", "1:0", "1:1"]);
  equal(block.words.length, 4);
  equal(block.lines.length, 2);
});

test("createLayoutBlock computes the union and normalized bbox", () => {
  const { children, lines } = twoLineParagraph();
  const block = createLayoutBlock({
    id: "b",
    page: 0,
    children,
    lines,
    pageSize: { width: 180, height: 48 },
  });
  equal(block.bbox, { x: 0, y: 0, width: 90, height: 24 });
  equal(block.normalizedBBox, { x: 0, y: 0, width: 0.5, height: 0.5 });
});

test("createLayoutBlock sorts children deterministically", () => {
  const { children, lines } = twoLineParagraph();
  const shuffled = [children[2], children[0], children[3], children[1]];
  const a = createLayoutBlock({
    id: "b",
    page: 0,
    children,
    lines,
    pageSize: { width: 180, height: 48 },
  });
  const b = createLayoutBlock({
    id: "b",
    page: 0,
    children: shuffled,
    lines,
    pageSize: { width: 180, height: 48 },
  });
  equal(a.ocrWordKeys, b.ocrWordKeys);
  equal(a.sourceRefs, b.sourceRefs);
});

test("createLayoutBlock rejects an empty child list", () => {
  let threw = false;
  try {
    createLayoutBlock({
      id: "b",
      page: 0,
      children: [],
      lines: [],
      pageSize: { width: 100, height: 100 },
    });
  } catch (e) {
    threw = e instanceof Error;
  }
  ok(threw, "empty children throws");
});

test("createLayoutBlock rejects children without a bbox", () => {
  const { lines } = twoLineParagraph();
  const noBox: OcrWord = { text: "zz" };
  let threw = false;
  try {
    createLayoutBlock({
      id: "b",
      page: 0,
      children: [{ lineIndex: 0, wordIndex: 0, word: noBox }],
      lines,
      pageSize: { width: 100, height: 100 },
    });
  } catch (e) {
    threw = e instanceof Error;
  }
  ok(threw, "child without bbox throws");
});

// ─── Immutability ────────────────────────────────────────────────────────────

test("createLayoutBlock deep-freezes every owned value", () => {
  const { children, lines } = twoLineParagraph();
  const block = createLayoutBlock({
    id: "b",
    page: 0,
    children,
    lines,
    pageSize: { width: 180, height: 48 },
  });
  ok(Object.isFrozen(block), "block is frozen");
  ok(Object.isFrozen(block.bbox), "bbox is frozen");
  ok(Object.isFrozen(block.normalizedBBox), "normalized bbox is frozen");
  ok(Object.isFrozen(block.sourceRefs), "source refs array is frozen");
  ok(Object.isFrozen(block.sourceRefs[0]), "source ref is frozen");
  ok(Object.isFrozen(block.ocrLineIndices), "line indices are frozen");
  ok(Object.isFrozen(block.ocrWordKeys), "word keys are frozen");
  ok(Object.isFrozen(block.words), "words array is frozen");
  ok(Object.isFrozen(block.words[0]), "child word copy is frozen");
  ok(Object.isFrozen(block.words[0].bbox!), "child word box copy is frozen");
  ok(Object.isFrozen(block.lines), "lines array is frozen");
  ok(Object.isFrozen(block.lines[0]), "child line copy is frozen");
  ok(Object.isFrozen(block.densityMetrics), "density metrics are frozen");
  ok(Object.isFrozen(block.spacingMetrics), "spacing metrics are frozen");
  ok(Object.isFrozen(block.confidence), "confidence profile is frozen");
  ok(Object.isFrozen(block.geometry), "geometry is frozen");
  ok(Object.isFrozen(block.geometry.center), "geometry center is frozen");
});

test("mutating the source OCR words does not leak into the block", () => {
  const { children, lines } = twoLineParagraph();
  const block = createLayoutBlock({
    id: "b",
    page: 0,
    children,
    lines,
    pageSize: { width: 180, height: 48 },
  });
  (children[0].word as OcrWord).bbox = { x: 999, y: 999, width: 1, height: 1 };
  (children[0].word as OcrWord).text = "MUTATED";
  equal(block.words[0].bbox, { x: 0, y: 0, width: 40, height: 10 });
  equal(block.words[0].text, "aa");
});

// ─── Density metrics ─────────────────────────────────────────────────────────

test("computeBlockDensityMetrics", () => {
  const { children, lines } = twoLineParagraph();
  const block = createLayoutBlock({
    id: "b",
    page: 0,
    children,
    lines,
    pageSize: { width: 180, height: 48 },
  });
  const d = block.densityMetrics;
  equal(d.wordCount, 4);
  equal(d.lineCount, 2);
  equal(d.charCount, 8);
  equal(d.area, 90 * 24);
  approx(d.wordDensity, 4 / (90 * 24));
  approx(d.lineDensity, 2 / (90 * 24));
});

// ─── Spacing metrics ─────────────────────────────────────────────────────────

test("computeBlockSpacingMetrics over a 2x2 grid", () => {
  const { children } = twoLineParagraph();
  const s = computeBlockSpacingMetrics(children);
  equal(s.meanHorizontalGap, 10);
  equal(s.meanVerticalGap, 4);
  equal(s.horizontalGapVariance, 0);
  equal(s.maxHorizontalGap, 10);
});

test("computeBlockSpacingMetrics is neutral for a single word", () => {
  const w = word("solo", 0, 0, 0.9);
  const s = computeBlockSpacingMetrics([
    { lineIndex: 0, wordIndex: 0, word: w },
  ]);
  equal(s.meanHorizontalGap, 0);
  equal(s.meanVerticalGap, 0);
  equal(s.horizontalGapVariance, 0);
  equal(s.maxHorizontalGap, 0);
});

test("computeBlockSpacingMetrics captures gap variance", () => {
  const a = word("a", 0, 0);
  const b = word("b", 50, 0);
  const c = word("c", 130, 0);
  const s = computeBlockSpacingMetrics([
    { lineIndex: 0, wordIndex: 0, word: a },
    { lineIndex: 0, wordIndex: 1, word: b },
    { lineIndex: 0, wordIndex: 2, word: c },
  ]);
  // gaps 10 and 40 → mean 25, population variance 225.
  equal(s.meanHorizontalGap, 25);
  equal(s.horizontalGapVariance, 225);
  equal(s.maxHorizontalGap, 40);
});

// ─── Geometry ────────────────────────────────────────────────────────────────

test("computeBlockGeometry", () => {
  const g = computeBlockGeometry({ x: 0, y: 0, width: 90, height: 24 });
  equal(g.center, { x: 45, y: 12 });
  equal(g.top, 0);
  equal(g.left, 0);
  equal(g.right, 90);
  equal(g.bottom, 24);
  equal(g.width, 90);
  equal(g.height, 24);
  equal(g.area, 2160);
  approx(g.aspectRatio, 90 / 24);
});

test("computeBlockGeometry handles degenerate boxes", () => {
  equal(computeBlockGeometry({ x: 0, y: 0, width: 0, height: 10 }).aspectRatio, 0);
  equal(computeBlockGeometry({ x: 0, y: 0, width: 10, height: 0 }).aspectRatio, 0);
});

// ─── Confidence ──────────────────────────────────────────────────────────────

test("buildBlockConfidence maps OCR confidence into the ocr component", () => {
  const { children } = twoLineParagraph();
  const profile = buildBlockConfidence(children.map((c) => c.word));
  equal(profile.ocr.count, 4);
  approx(profile.ocr.mean, 0.6);
  equal(profile.ocr.min, 0);
  equal(profile.ocr.max, 0.9);
  equal(profile.geometric.count, 4, "other components are neutral zeros");
  approx(profile.geometric.mean, 0);
});

test("buildBlockConfidence honors an injected composite policy", () => {
  const { children } = twoLineParagraph();
  const profile = buildBlockConfidence(
    children.map((c) => c.word),
    () => 1
  );
  approx(profile.aggregate.mean, 1);
});

test("block confidence is the profile over the child words", () => {
  const { children, lines } = twoLineParagraph();
  const block = createLayoutBlock({
    id: "b",
    page: 0,
    children,
    lines,
    pageSize: { width: 180, height: 48 },
  });
  approx(block.confidence.ocr.mean, 0.6);
  equal(block.confidence.ocr.count, 4);
});
