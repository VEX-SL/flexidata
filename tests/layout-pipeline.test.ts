/**
 * Milestone 9 pipeline tests — the end-to-end layout integration: the strict
 * M3→M8 stage order over a real OCR document, the projection mapping (one
 * node per positioned word, one region per source line), unpositioned-word
 * skipping, the repair-report surface, deterministic rebuilds across fresh
 * pipelines, and failure semantics that keep extraction running.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  LAYOUT_EDGE_TYPE,
  LAYOUT_VERSION,
  LayoutProjector,
  buildLayoutPipeline,
  cleanOcr,
  isFiniteBBox,
} from "@/lib/layout";
import type { LayoutDocument, LayoutResult } from "@/lib/layout";
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

function positionedWordCount(doc: OcrDocument): number {
  let count = 0;
  for (const line of doc.lines) {
    for (const word of line.words) {
      if (isFiniteBBox(word.bbox)) count += 1;
    }
  }
  return count;
}

function assertSuccess(result: LayoutResult): LayoutDocument {
  ok(result.failure === undefined, `build failed: ${result.failure?.reason ?? ""}`);
  ok(result.context.layoutDocument !== null, "layout document present");
  return result.context.layoutDocument;
}

test("pipeline builds a complete layout context for a real document", () => {
  const result = buildLayoutPipeline().build(mkDoc());
  const context = result.context;
  ok(result.failure === undefined, "build succeeds");
  ok(context.layoutDocument !== null, "layoutDocument present");
  ok(context.hierarchy !== null, "hierarchy present");
  ok(context.semanticGraph !== null, "semanticGraph present");
  ok(context.readingOrder !== null, "readingOrder present");
  ok(context.propagatedConfidence !== null, "propagatedConfidence present");
  ok(context.validationReport !== null, "validationReport present");
  equal(context.validationReport.valid, true, "the built model validates");
  equal(context.validationReport.errors, [], "no validation errors");
  equal(context.validationReport.repaired, false, "no repair was needed");
});

test("projection maps every positioned word and line into the structural document", () => {
  const doc = mkDoc();
  const projection = assertSuccess(buildLayoutPipeline().build(doc));
  equal(projection.version, LAYOUT_VERSION);
  equal(projection.pages.length, 1, "single-page projection");
  equal(projection.nodes.length, positionedWordCount(doc), "one node per positioned word");
  equal(projection.regions.length, doc.lines.length, "one region per source line");

  const page = projection.pages[0];
  equal(page.nodeIds.length, projection.nodes.length, "page covers every node");
  equal(page.regionIds.length, projection.regions.length, "page covers every region");
  for (const node of projection.nodes) {
    ok(node.source.wordIndex !== undefined, "nodes carry word source refs");
  }
});

test("unpositioned words are skipped in projection but extraction keeps running", () => {
  const doc: OcrDocument = {
    text: "alpha beta\nbare",
    lines: [
      mkLine(0, [mkWord("alpha", 0, 0, 0.9), mkWord("beta", 60, 0, 0.8)]),
      { text: "bare", words: [{ text: "bare", confidence: 0.7 }] },
    ],
  };

  const cleaned = cleanOcr(doc);
  equal(cleaned.skips.skippedWordCount, 1, "the positionless word is skipped");
  equal(cleaned.skips.skippedLineCount, 1, "its line is dropped");
  equal(cleaned.ocr.lines.length, 1);

  const projection = assertSuccess(buildLayoutPipeline().build(doc));
  equal(projection.nodes.length, 2, "only positioned words project");
  equal(projection.regions.length, 1, "only the surviving line projects");
  for (const line of projection.source.lines) {
    for (const word of line.words) {
      ok(isFiniteBBox(word.bbox), "projection source carries only positioned words");
    }
  }
});

test("an all-positionless document still returns a result (extraction never stops)", () => {
  const doc: OcrDocument = {
    text: "???",
    lines: [{ text: "???", words: [{ text: "???", confidence: 0.2 }] }],
  };
  const result = buildLayoutPipeline().build(doc);
  ok(result !== undefined, "the pipeline always returns a result");
  ok(Object.isFrozen(result.context), "the result context is frozen");
  if (result.failure === undefined) {
    equal(result.context.layoutDocument!.nodes.length, 0, "no positioned words project");
    equal(result.context.layoutDocument!.pages.length, 1, "an empty page is still projected");
  } else {
    ok(result.failure.reason.length > 0, "a failure is described");
  }
});

test("semantic graph mirrors the hierarchy", () => {
  const result = buildLayoutPipeline().build(mkDoc());
  const context = result.context;
  const hierarchy = context.hierarchy!;
  const graph = context.semanticGraph!;
  ok(Object.isFrozen(graph), "semantic graph is frozen");

  const nodeIds = new Set(graph.nodes());
  for (const node of hierarchy.nodes()) {
    if (node.id === HIERARCHY_DOCUMENT_ID) continue;
    ok(nodeIds.has(node.id), `semantic graph contains hierarchy node ${node.id}`);
  }

  let expectedChildOf = 0;
  for (const node of hierarchy.nodes()) {
    if (node.id === HIERARCHY_DOCUMENT_ID) continue;
    expectedChildOf += node.children.length;
  }
  const childOf = graph.edges().filter((e) => e.type === LAYOUT_EDGE_TYPE.CHILD_OF);
  const contains = graph.edges().filter((e) => e.type === LAYOUT_EDGE_TYPE.CONTAINS);
  equal(childOf.length, expectedChildOf, "CHILD_OF edges mirror the tree");
  equal(contains.length, expectedChildOf, "CONTAINS edges mirror the tree");
});

test("reading order graph is frozen and covers every hierarchy node", () => {
  const result = buildLayoutPipeline().build(mkDoc());
  const context = result.context;
  const readingOrder = context.readingOrder!;
  const hierarchy = context.hierarchy!;
  ok(Object.isFrozen(readingOrder), "reading order is frozen");
  equal(
    readingOrder.nodes().length,
    hierarchy.nodes().length,
    "reading order covers the hierarchy exactly"
  );
});

test("propagated confidence is finite and bounded for every node", () => {
  const result = buildLayoutPipeline().build(mkDoc());
  const context = result.context;
  const confidence = context.propagatedConfidence!;
  const hierarchy = context.hierarchy!;
  ok(Object.isFrozen(confidence), "confidence is frozen");
  equal(confidence.size, hierarchy.nodes().length, "every hierarchy node has a profile");
  for (const id of confidence.ids()) {
    const profile = confidence.get(id)!;
    for (const component of [
      profile.ocr,
      profile.geometric,
      profile.structural,
      profile.boundary,
      profile.typological,
      profile.order,
    ]) {
      ok(Number.isFinite(component.mean), `mean is finite for ${id}`);
      ok(component.mean >= 0 && component.mean <= 1, `mean within [0,1] for ${id}`);
    }
    ok(Number.isFinite(profile.aggregate.mean), `aggregate is finite for ${id}`);
    ok(profile.aggregate.mean >= 0 && profile.aggregate.mean <= 1, `aggregate within [0,1] for ${id}`);
  }
});

test("a failing projector produces a layout failure instead of a throw", () => {
  class ThrowingProjector extends LayoutProjector {
    project(_ocr: OcrDocument): LayoutDocument {
      void _ocr;
      throw new Error("projector exploded");
    }
  }
  const pipeline = buildLayoutPipeline({ projector: new ThrowingProjector() });
  const result = pipeline.build(mkDoc());
  ok(result.failure !== undefined, "failure is reported");
  equal(result.failure.reason, "layout build failed");
  ok(result.failure.details.length > 0, "failure details describe the cause");
  equal(result.context.layoutDocument, null, "broken context on failure");
  equal(result.context.validationReport, null, "no report on failure");
  ok(Object.isFrozen(result), "the failure result is frozen");
});

test("deterministic rebuilds across fresh pipelines produce identical outputs", () => {
  const r1 = buildLayoutPipeline().build(mkDoc());
  const r2 = buildLayoutPipeline().build(mkDoc());
  ok(r1.failure === undefined && r2.failure === undefined, "both builds succeed");
  equal(
    JSON.stringify(r1.context.layoutDocument),
    JSON.stringify(r2.context.layoutDocument),
    "identical structural documents"
  );
  equal(
    JSON.stringify(r1.context.validationReport),
    JSON.stringify(r2.context.validationReport),
    "identical validation reports"
  );
  equal(
    JSON.stringify(r1.context.readingOrder!.nodes()),
    JSON.stringify(r2.context.readingOrder!.nodes()),
    "identical reading order"
  );
  equal(
    JSON.stringify(r1.context.semanticGraph!.edges()),
    JSON.stringify(r2.context.semanticGraph!.edges()),
    "identical semantic graph edges"
  );
});
