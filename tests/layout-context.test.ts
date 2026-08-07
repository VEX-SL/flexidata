/**
 * Milestone 9 context tests — the immutable `LayoutContext` container: the
 * six-field surface contract, component reuse by reference (no duplication),
 * deep freezing, broken contexts, failure semantics that let extraction
 * continue, and the projection-source accessor.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  LAYOUT_VERSION,
  LayoutProjector,
  brokenLayoutContext,
  buildLayoutPipeline,
  createLayoutContext,
  isLayoutFailure,
  isLayoutSuccess,
  layoutFailure,
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
      mkLine(0, [mkWord("INVOICE", 0, 0, 0.95), mkWord("NO", 90, 0, 0.9), mkWord("1234", 140, 0, 0.85)]),
      mkLine(24, [mkWord("Item", 0, 24, 0.8), mkWord("Total", 90, 24, 0.9)]),
      mkLine(48, [mkWord("Total", 0, 48, 0.75)]),
    ],
  };
}

function builtContext(): LayoutContext {
  const result = buildLayoutPipeline().build(mkDoc());
  if (result.failure !== undefined) {
    throw new Error(`fixture layout failed: ${result.failure.reason}`);
  }
  return result.context;
}

test("context surface exposes all six fields on a successful build", () => {
  const context = builtContext();
  ok(context.layoutDocument !== null, "layoutDocument present");
  ok(context.hierarchy !== null, "hierarchy present");
  ok(context.semanticGraph !== null, "semanticGraph present");
  ok(context.readingOrder !== null, "readingOrder present");
  ok(context.propagatedConfidence !== null, "propagatedConfidence present");
  ok(context.validationReport !== null, "validationReport present");
  equal(context.layoutDocument.version, LAYOUT_VERSION, "structural model carries the layout version");
});

test("createLayoutContext reuses the exact components and freezes", () => {
  const context = builtContext();
  const rebuilt = createLayoutContext({
    layoutDocument: context.layoutDocument!,
    hierarchy: context.hierarchy!,
    semanticGraph: context.semanticGraph!,
    readingOrder: context.readingOrder!,
    propagatedConfidence: context.propagatedConfidence!,
    validationReport: context.validationReport!,
  });
  ok(rebuilt.layoutDocument === context.layoutDocument, "layoutDocument reused by reference");
  ok(rebuilt.hierarchy === context.hierarchy, "hierarchy reused by reference");
  ok(rebuilt.semanticGraph === context.semanticGraph, "semanticGraph reused by reference");
  ok(rebuilt.readingOrder === context.readingOrder, "readingOrder reused by reference");
  ok(rebuilt.propagatedConfidence === context.propagatedConfidence, "confidence reused by reference");
  ok(Object.isFrozen(rebuilt), "the context is frozen");
});

test("brokenLayoutContext nulls everything not provided", () => {
  const broken = brokenLayoutContext();
  equal(broken.layoutDocument, null);
  equal(broken.hierarchy, null);
  equal(broken.semanticGraph, null);
  equal(broken.readingOrder, null);
  equal(broken.propagatedConfidence, null);
  equal(broken.validationReport, null);
  ok(Object.isFrozen(broken), "the broken context is frozen");

  const partial = brokenLayoutContext({
    layoutDocument: new LayoutProjector().project(mkDoc()),
  });
  ok(partial.layoutDocument !== null, "partial keeps the provided component");
  equal(partial.hierarchy, null, "unprovided components stay null");
  equal(partial.validationReport, null, "broken contexts never carry a report");
});

test("layoutFailure freezes reason and snapshots details", () => {
  const details = ["a", "b"];
  const failure = layoutFailure("boom", details);
  equal(failure.reason, "boom");
  equal(failure.details, ["a", "b"]);
  ok(Object.isFrozen(failure), "the failure is frozen");
  ok(Object.isFrozen(failure.details), "details are frozen");
  details.push("c");
  equal(failure.details, ["a", "b"], "details are a snapshot copy");
});

test("layout result predicates distinguish success from failure", () => {
  const success: LayoutResult = { context: builtContext() };
  ok(isLayoutSuccess(success));
  ok(!isLayoutFailure(success));

  const failed: LayoutResult = {
    context: brokenLayoutContext(),
    failure: layoutFailure("no layout", ["reason one"]),
  };
  ok(isLayoutFailure(failed));
  ok(!isLayoutSuccess(failed));
  ok(failed.failure !== undefined && failed.failure.reason === "no layout");
});

test("layoutSourceOcr returns the projection source with only positioned words", () => {
  const context = builtContext();
  const source = layoutSourceOcr(context);
  ok(source !== undefined, "source is available");
  equal(source!.lines.length, 3);
  for (const line of source!.lines) {
    for (const word of line.words) {
      ok(word.bbox !== undefined, "every projected word carries a bbox");
    }
  }
});

test("the built hierarchy carries the document root", () => {
  const context = builtContext();
  ok(context.hierarchy!.has(HIERARCHY_DOCUMENT_ID), "document root exists in the hierarchy");
});
