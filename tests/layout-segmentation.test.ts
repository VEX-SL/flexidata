/**
 * Milestone 3 segmentation scenarios over synthetic geometry: single
 * paragraph, multiple paragraphs, two columns, mixed scripts, sparse receipts,
 * dense contracts, empty pages, single words, touching/overlapping boxes,
 * noisy OCR and deterministic repeated runs.
 */
import {
  REGION_TYPE,
  segmentDocument,
  validateFullWordCoverage,
  validateSegmentationDeterminism,
  unionBoxes,
} from "@/lib/layout";
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
  const boxes = words.map((w) => w.bbox!);
  const bbox = unionBoxes(boxes);
  return {
    text: words.map((w) => w.text).join(" "),
    words,
    ...(bbox ? { bbox } : {}),
  };
}

function mkDoc(lines: OcrLine[]): OcrDocument {
  return { text: lines.map((l) => l.text).join("\n"), lines };
}

/** A line of `n` words, each w×h, at the given y, x starting at `start`. */
function row(
  y: number,
  xs: readonly number[],
  w = 40,
  h = 10,
  c?: number
): OcrLine {
  return mkLine(
    xs.map((x, i) =>
      mkWord({ text: `w${i}`, x, y, w, h, ...(c !== undefined ? { c } : {}) })
    )
  );
}

/** A paragraph of `lines` rows spaced `gapY` apart, each row `xs` words wide. */
function paragraph(
  startY: number,
  gapY: number,
  rows: number,
  xs: readonly number[],
  w = 40,
  h = 10
): OcrLine[] {
  const out: OcrLine[] = [];
  for (let r = 0; r < rows; r++) out.push(row(startY + r * gapY, xs, w, h));
  return out;
}

// ─── 1. Single paragraph ─────────────────────────────────────────────────────

test("single paragraph is one block", () => {
  const doc = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const result = segmentDocument(doc);
  equal(result.blocks.length, 1);
  const block = result.blocks[0];
  equal(block.densityMetrics.wordCount, 12);
  equal(block.densityMetrics.lineCount, 3);
  equal(block.ocrLineIndices, [0, 1, 2]);
  equal(block.type, REGION_TYPE.UNKNOWN);
  equal(block.bbox, { x: 0, y: 0, width: 190, height: 38 });
  equal(result.thresholds.horizontal, 10);
  equal(result.thresholds.vertical, 4);
  equal(result.skippedWordCount, 0);
});

// ─── 2. Multiple paragraphs ──────────────────────────────────────────────────

test("two paragraphs separated by a large gap become two blocks", () => {
  const doc = mkDoc([
    ...paragraph(0, 14, 2, [0, 50, 100, 150]),
    ...paragraph(50, 14, 2, [0, 50, 100, 150]),
  ]);
  const result = segmentDocument(doc);
  equal(result.blocks.length, 2);
  const [p1, p2] = result.blocks;
  equal(p1.densityMetrics.wordCount, 8);
  equal(p2.densityMetrics.wordCount, 8);
  equal(p1.ocrLineIndices, [0, 1]);
  equal(p2.ocrLineIndices, [2, 3]);
  ok(p1.bbox.y + p1.bbox.height < p2.bbox.y, "paragraphs are vertically disjoint");
});

// ─── 3. Two-column layout (full-width OCR lines) ─────────────────────────────

test("two-column layout with full-width OCR lines yields two blocks", () => {
  const cols = [0, 50, 100, 300, 350, 400];
  const doc = mkDoc([row(0, cols), row(14, cols)]);
  const result = segmentDocument(doc);
  equal(result.blocks.length, 2, "left and right column stay separate");
  const [left, right] = result.blocks;
  equal(left.densityMetrics.wordCount, 6);
  equal(right.densityMetrics.wordCount, 6);
  ok(left.bbox.x + left.bbox.width <= right.bbox.x, "left is left of right");
});

// ─── 4. Mixed Arabic/English ─────────────────────────────────────────────────

test("mixed Arabic (RTL) and English paragraphs split geometrically", () => {
  const arabic = [
    mkLine([
      mkWord({ text: "ar0", x: 150, y: 0, w: 30, h: 10 }),
      mkWord({ text: "ar1", x: 110, y: 0, w: 30, h: 10 }),
      mkWord({ text: "ar2", x: 70, y: 0, w: 30, h: 10 }),
    ]),
    mkLine([
      mkWord({ text: "ar3", x: 150, y: 14, w: 30, h: 10 }),
      mkWord({ text: "ar4", x: 110, y: 14, w: 30, h: 10 }),
      mkWord({ text: "ar5", x: 70, y: 14, w: 30, h: 10 }),
    ]),
  ];
  const english = [
    mkLine([
      mkWord({ text: "en0", x: 0, y: 50, w: 30, h: 10 }),
      mkWord({ text: "en1", x: 40, y: 50, w: 30, h: 10 }),
    ]),
    mkLine([
      mkWord({ text: "en2", x: 0, y: 64, w: 30, h: 10 }),
      mkWord({ text: "en3", x: 40, y: 64, w: 30, h: 10 }),
    ]),
  ];
  const result = segmentDocument(mkDoc([...arabic, ...english]));
  equal(result.blocks.length, 2);
  const [first, second] = result.blocks;
  const texts = (b: (typeof first)[]) =>
    b.map((block) => block.words.map((w) => w.text).sort()).flat().sort();
  const arabicTexts = texts([first]).join(",");
  const englishTexts = texts([second]).join(",");
  ok(arabicTexts.startsWith("ar") && arabicTexts.includes("ar5"), "first block is Arabic");
  ok(englishTexts.startsWith("en") && englishTexts.includes("en3"), "second block is English");
});

// ─── 5. Sparse receipt ───────────────────────────────────────────────────────

test("sparse receipt groups item lines and keeps the total separate", () => {
  const items = [0, 20, 40].map((y) =>
    mkLine([
      mkWord({ text: "item", x: 0, y, w: 80, h: 10 }),
      mkWord({ text: "price", x: 90, y, w: 60, h: 10 }),
    ])
  );
  const total = mkLine([
    mkWord({ text: "TOTAL", x: 0, y: 100, w: 80, h: 10 }),
    mkWord({ text: "amount", x: 90, y: 100, w: 60, h: 10 }),
  ]);
  const result = segmentDocument(mkDoc([...items, total]));
  equal(result.blocks.length, 2, "items block + total block");
  const [itemsBlock, totalBlock] = result.blocks;
  equal(itemsBlock.densityMetrics.wordCount, 6);
  equal(totalBlock.densityMetrics.wordCount, 2);
  equal(
    totalBlock.words.map((w) => w.text).join(" "),
    "TOTAL amount"
  );
  equal(result.thresholds.horizontal, 10);
  equal(result.thresholds.vertical, 10);
});

// ─── 6. Dense contracts ──────────────────────────────────────────────────────

test("dense contract keeps each paragraph separate", () => {
  const paragraphs: OcrLine[] = [];
  for (const start of [0, 44, 88, 132]) {
    paragraphs.push(...paragraph(start, 14, 2, [0, 50, 100, 150]));
  }
  const result = segmentDocument(mkDoc(paragraphs));
  equal(result.blocks.length, 4);
  for (const block of result.blocks) {
    equal(block.densityMetrics.wordCount, 8);
  }
});

// ─── 7. Empty pages ──────────────────────────────────────────────────────────

test("an empty page yields no blocks", () => {
  const result = segmentDocument(mkDoc([]));
  equal(result.blocks.length, 0);
  equal(result.skippedWordCount, 0);
});

test("a page with only unpositioned words yields no blocks and reports skips", () => {
  const line: OcrLine = {
    text: "no boxes here",
    words: [
      { text: "no" },
      { text: "boxes" },
      { text: "here" },
    ],
  };
  const result = segmentDocument(mkDoc([line]));
  equal(result.blocks.length, 0);
  equal(result.skippedWordCount, 3);
});

// ─── 8. Single-word page ─────────────────────────────────────────────────────

test("a single word is its own block", () => {
  const result = segmentDocument(mkDoc([row(0, [0], 40, 10)]));
  equal(result.blocks.length, 1);
  equal(result.blocks[0].densityMetrics.wordCount, 1);
  equal(result.blocks[0].normalizedBBox, { x: 0, y: 0, width: 1, height: 1 });
});

// ─── 9. Touching boxes ───────────────────────────────────────────────────────

test("touching word boxes group into one block", () => {
  const doc = mkDoc([row(0, [0, 40, 80])]);
  const result = segmentDocument(doc);
  equal(result.blocks.length, 1);
  equal(result.blocks[0].densityMetrics.wordCount, 3);
});

// ─── 10. Overlapping OCR boxes ───────────────────────────────────────────────

test("overlapping OCR boxes group deterministically", () => {
  const doc = mkDoc([
    mkLine([
      mkWord({ text: "a", x: 0, y: 0, w: 50, h: 10 }),
      mkWord({ text: "b", x: 40, y: 0, w: 50, h: 10 }),
      mkWord({ text: "c", x: 80, y: 0, w: 50, h: 10 }),
    ]),
  ]);
  const result = segmentDocument(doc);
  equal(result.blocks.length, 1);
  equal(result.blocks[0].densityMetrics.wordCount, 3);
});

// ─── 11. Noisy OCR ───────────────────────────────────────────────────────────

test("noisy OCR splits into two stable clusters", () => {
  const doc = mkDoc([
    mkLine([
      mkWord({ text: "n0", x: 0, y: 0, w: 40, h: 10, c: 0.81 }),
      mkWord({ text: "n1", x: 50, y: 0, w: 35, h: 9, c: 0.55 }),
      mkWord({ text: "n2", x: 95, y: 0, w: 45, h: 11, c: 0.97 }),
      mkWord({ text: "n3", x: 145, y: 0, w: 38, h: 10, c: 0.62 }),
    ]),
    mkLine([
      mkWord({ text: "n4", x: 2, y: 14, w: 40, h: 10, c: 0.73 }),
      mkWord({ text: "n5", x: 52, y: 14, w: 35, h: 10, c: 0.88 }),
    ]),
    mkLine([
      mkWord({ text: "n6", x: 0, y: 600, w: 40, h: 10, c: 0.9 }),
      mkWord({ text: "n7", x: 50, y: 600, w: 35, h: 10, c: 0.9 }),
    ]),
  ]);
  const first = segmentDocument(doc);
  equal(first.blocks.length, 2);
  equal(first.blocks[0].densityMetrics.wordCount, 6);
  equal(first.blocks[1].densityMetrics.wordCount, 2);
  ok(validateFullWordCoverage(doc, first.blocks).valid, "every positioned word assigned");

  const second = segmentDocument(doc);
  ok(
    validateSegmentationDeterminism(first, second).valid,
    "noisy input is deterministic"
  );
});

// ─── 12. Deterministic repeated runs ─────────────────────────────────────────

test("identical input reproduces identical blocks", () => {
  const doc = mkDoc([
    ...paragraph(0, 14, 3, [0, 50, 100, 150]),
    ...paragraph(50, 14, 2, [0, 50, 100, 150]),
  ]);
  const first = segmentDocument(doc);
  const second = segmentDocument(doc);
  ok(validateSegmentationDeterminism(first, second).valid);
  equal(first.blocks, second.blocks);
});

// ─── Extra: adaptivity ───────────────────────────────────────────────────────

test("the thresholds are adaptive, not fixed pixel values", () => {
  const small = mkDoc(paragraph(0, 14, 3, [0, 50, 100, 150]));
  const scaled = mkDoc(
    paragraph(0, 35, 3, [0, 125, 250, 375], 100, 25)
  );
  const a = segmentDocument(small);
  const b = segmentDocument(scaled);
  ok(a.thresholds.horizontal < b.thresholds.horizontal, "larger document has larger threshold");
  equal(a.blocks.length, b.blocks.length);
  equal(a.blocks[0].densityMetrics.wordCount, b.blocks[0].densityMetrics.wordCount);
  equal(a.blocks[0].normalizedBBox, b.blocks[0].normalizedBBox);
});

test("an explicit pageSize drives the normalized bboxes", () => {
  const doc = mkDoc(paragraph(0, 14, 2, [0, 50, 100, 150]));
  const result = segmentDocument(doc, { pageSize: { width: 1000, height: 1000 } });
  const block = result.blocks[0];
  equal(block.normalizedBBox, { x: 0, y: 0, width: 0.19, height: 0.024 });
});

test("a custom confidence policy drives block aggregates", () => {
  const doc = mkDoc([row(0, [0, 50], 40, 10, 0.9), row(14, [0, 50], 40, 10, 0.7)]);
  const result = segmentDocument(doc, { confidencePolicy: () => 0.42 });
  equal(result.blocks.length, 1);
  const aggregate = result.blocks[0].confidence.aggregate;
  equal(aggregate.count, 4);
  equal(aggregate.mean, 0.42);
});
