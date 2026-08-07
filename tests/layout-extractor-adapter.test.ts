/**
 * Milestone 10 layout-extractor-adapter tests — the gradual-migration seam:
 * the adapter exposes the immutable M9 context through the interface existing
 * extractors expect (the `OcrDocument`), plus the reader/query/evidence/
 * selection layers and the repair-report surface, without duplicating the OCR
 * or changing any extraction behavior.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  LayoutExtractorAdapter,
  buildLayoutPipeline,
  createLayoutExtractorAdapter,
  layoutSourceOcr,
} from "@/lib/layout";
import type { LayoutContext, LayoutResult } from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import { equal, ok, test } from "./harness.ts";

function mkWord(text: string, x: number, y: number, c = 0.9): OcrWord {
  return { text, confidence: c, bbox: { x, y, width: 30, height: 12 } };
}

function mkLine(y: number, words: readonly OcrWord[]): OcrLine {
  const bbox = unionBoxes(words.map((w) => w.bbox!))!;
  return { text: words.map((w) => w.text).join(" "), words: [...words], bbox };
}

function mkDoc(): OcrDocument {
  return {
    text: "INVOICE NO 1234\nItem Total\nTotal",
    lines: [
      mkLine(0, [
        mkWord("INVOICE", 0, 0, 0.95),
        mkWord("NO", 90, 0, 0.9),
        mkWord("1234", 140, 0, 0.85),
      ]),
      mkLine(24, [mkWord("Item", 0, 24, 0.8), mkWord("Total", 90, 24, 0.9)]),
      mkLine(48, [mkWord("Total", 0, 48, 0.75)]),
    ],
  };
}

function buildContext(): LayoutContext {
  const result: LayoutResult = buildLayoutPipeline().build(mkDoc());
  ok(result.failure === undefined, "build succeeds");
  return result.context;
}

test("adapter exposes the context and the four navigation layers", () => {
  const context = buildContext();
  const adapter = new LayoutExtractorAdapter(context);
  ok(adapter.context === context, "context is shared, not copied");
  ok(adapter.reader !== undefined, "reader exposed");
  ok(adapter.query !== undefined, "query exposed");
  ok(adapter.evidence !== undefined, "evidence exposed");
  ok(adapter.selection !== undefined, "selection exposed");
  ok(adapter.layoutDocument === context.layoutDocument, "layout document shared");
  ok(adapter.validationReport === context.validationReport, "repair report shared");
  ok(Object.isFrozen(adapter), "the adapter itself is frozen");
});

test("adapter exposes the exact source OCR object when supplied", () => {
  const context = buildContext();
  const doc = mkDoc();
  const adapter = new LayoutExtractorAdapter(context, doc);
  ok(adapter.ocr === doc, "the OCR object is shared verbatim");
  equal(adapter.ocr!.lines.length, doc.lines.length, "full OCR is readable");
  equal(adapter.ocr!.lines[0].words[0].text, "INVOICE", "words readable");
});

test("adapter falls back to the context's source OCR", () => {
  const context = buildContext();
  const adapter = new LayoutExtractorAdapter(context);
  equal(adapter.ocr, layoutSourceOcr(context), "defaults to the context source");
  equal(adapter.ocr, context.layoutDocument!.source, "identical object");
});

test("navigation layers work through the adapter", () => {
  const context = buildContext();
  const adapter = new LayoutExtractorAdapter(context);
  const words = adapter.reader.words();
  ok(words.length >= 1, "reader works");
  equal(adapter.query.findWordsInReadingOrder().length, words.length, "query works");
  equal(adapter.evidence.for("word-0-0-0")!.text, "INVOICE", "evidence works");
  equal(adapter.selection.select({}).count, words.length, "selection works");
  ok(adapter.reader.has(HIERARCHY_DOCUMENT_ID), "document root reachable");
});

test("factory builds a working adapter", () => {
  const context = buildContext();
  const adapter = createLayoutExtractorAdapter(context, mkDoc());
  ok(adapter instanceof LayoutExtractorAdapter, "factory returns an adapter");
  ok(adapter.selection.select({}).count >= 1, "factory adapter is functional");
  ok(Object.isFrozen(adapter.selection.select({})), "factory results stay frozen");
});
