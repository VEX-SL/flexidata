/**
 * Milestone 10 layout-evidence tests — immutable evidence records for
 * extracted nodes: OCR text resolved strictly through source refs, source refs,
 * bbox, region, confidence and reading position. Pure reads: no inference, no
 * cleaning, no duplicated OCR objects.
 */
import {
  LayoutEvidence,
  LayoutReader,
  NODE_LEVEL,
  buildLayoutPipeline,
} from "@/lib/layout";
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

function makeEvidence(): { reader: LayoutReader; evidence: LayoutEvidence } {
  const result = buildLayoutPipeline().build(mkDoc());
  ok(result.failure === undefined, "build succeeds");
  const reader = new LayoutReader(result.context);
  return { reader, evidence: new LayoutEvidence(reader) };
}

test("word evidence resolves OCR text, refs, bbox, region and position", () => {
  const { reader, evidence } = makeEvidence();
  const node = reader.get("word-0-0-1")!;
  const entry = evidence.for(node.id)!;
  ok(entry !== undefined, "evidence resolves");
  equal(entry.nodeId, node.id, "node id matches");
  equal(entry.level, NODE_LEVEL.WORD, "level matches");
  equal(entry.text, "NO", "OCR text of the word");
  equal(entry.sourceRefs.length, 1, "one source ref");
  equal(entry.sourceRefs[0].lineIndex, 0, "line ref");
  equal(entry.sourceRefs[0].wordIndex, 1, "word ref");
  equal(entry.readingPosition, 1, "reading position");
  ok(entry.region !== null, "region present");
  const region = reader.ancestors(node.id).find((n) => n.level === NODE_LEVEL.REGION);
  equal(entry.region!.id, region!.id, "region is the owner region");
  equal(entry.region!.regionType, "Unknown", "region type surfaces");
});

test("line evidence uses the source line text verbatim", () => {
  const { reader, evidence } = makeEvidence();
  const line = reader.parent("word-0-0-0")!;
  const entry = evidence.for(line.id)!;
  equal(entry.level, NODE_LEVEL.LINE, "level matches");
  equal(entry.text, "INVOICE NO 1234", "source line text");
  equal(entry.sourceRefs.length, 1, "one source ref");
  ok(entry.sourceRefs[0].wordIndex === undefined, "line refs carry no word index");
});

test("composite evidence joins word texts in reading order", () => {
  const { reader, evidence } = makeEvidence();
  const documentEntry = evidence.for("document")!;
  equal(documentEntry.level, "Document", "document is a composite node");
  equal(documentEntry.text, "INVOICE NO 1234 Item Total Total", "reading-ordered join");

  const block = reader.blocks()[0];
  const blockEntry = evidence.for(block.id)!;
  const wordTexts = reader
    .descendants(block.id)
    .filter((n) => n.level === NODE_LEVEL.WORD)
    .map((w) => evidence.for(w.id)!.text);
  equal(blockEntry.text, wordTexts.join(" "), "block text is its words' join");
});

test("confidence is shared, geometry is copied, nothing is duplicated", () => {
  const { reader, evidence } = makeEvidence();
  const node = reader.get("word-0-0-0")!;
  const entry = evidence.for(node.id)!;
  equal(entry.confidence, node.confidence.aggregate, "aggregate distribution is shared");
  equal(entry.confidenceProfile, node.confidence, "profile is shared, never copied");
  ok(entry.bbox !== node.bbox, "bbox is a fresh frozen copy");
  ok(entry.sourceRefs !== node.sourceRefs, "source refs are a fresh frozen copy");
  ok(Object.isFrozen(entry), "the evidence entry is frozen");
  ok(Object.isFrozen(entry.bbox), "the bbox copy is frozen");
  ok(Object.isFrozen(entry.sourceRefs), "the ref copy is frozen");
  ok(Object.isFrozen(entry.confidenceProfile), "the profile stays frozen");
});

test("forMany preserves order and skips unknown ids", () => {
  const { evidence } = makeEvidence();
  const entries = evidence.forMany(["word-0-0-0", "missing", "word-0-2-0"]);
  equal(entries.length, 2, "unknown id skipped");
  equal(entries[0].nodeId, "word-0-0-0", "input order kept");
  equal(entries[1].nodeId, "word-0-2-0", "input order kept");
  ok(Object.isFrozen(entries), "the entry list is frozen");
  equal(evidence.for("missing"), undefined, "unknown id yields undefined");
});
