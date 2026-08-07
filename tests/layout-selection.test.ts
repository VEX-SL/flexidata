/**
 * Milestone 10 layout-selection tests — deterministic candidate selection
 * filtered only by region type, hierarchy level, reading order, confidence,
 * containment and geometry. Identical criteria yield identical frozen results.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  LayoutReader,
  LayoutSelection,
  NODE_LEVEL,
  REGION_TYPE,
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

function makeSelection(): { reader: LayoutReader; selection: LayoutSelection } {
  const result = buildLayoutPipeline().build(mkDoc());
  ok(result.failure === undefined, "build succeeds");
  const reader = new LayoutReader(result.context);
  return { reader, selection: new LayoutSelection(reader) };
}

test("default selection returns all words in reading order", () => {
  const { reader, selection } = makeSelection();
  const result = selection.select({});
  equal(result.count, reader.words().length, "every word is a candidate");
  equal(result.nodeIds.length, result.count, "ids match the count");
  equal(result.nodeIds[0], "word-0-0-0", "reading order leads");
  const positions = result.nodeIds.map((id) => reader.readingPosition(id)!);
  for (let i = 1; i < positions.length; i++) {
    ok(positions[i] > positions[i - 1], "reading positions strictly increase");
  }
  ok(Object.isFrozen(result), "the result is frozen");
  ok(Object.isFrozen(result.nodeIds), "the id list is frozen");
});

test("selection filters by level and orders by pre-order", () => {
  const { reader, selection } = makeSelection();
  const lines = selection.select({ level: NODE_LEVEL.LINE });
  equal(lines.count, reader.lines().length, "all lines");
  for (const id of lines.nodeIds) {
    equal(reader.get(id)!.level, NODE_LEVEL.LINE, "candidates are lines");
  }

  const words = selection.select({ order: "pre" });
  equal(words.nodeIds.length, reader.words().length, "pre-order covers all words");
  equal(
    JSON.stringify(words.nodeIds),
    JSON.stringify(reader.words().map((w) => w.id)),
    "pre-order matches the reader's deterministic order"
  );
});

test("selection filters by region type without inspecting text", () => {
  const { reader, selection } = makeSelection();
  const unknown = selection.select({
    level: NODE_LEVEL.WORD,
    regionType: REGION_TYPE.UNKNOWN,
  });
  equal(unknown.count, reader.words().length, "all words live in UNKNOWN regions");

  const header = selection.select({
    level: NODE_LEVEL.WORD,
    regionType: REGION_TYPE.HEADER,
  });
  equal(header.count, 0, "no words live in header regions");
});

test("selection filters by confidence bounds", () => {
  const { reader, selection } = makeSelection();
  const means = reader.words().map((w) => w.confidence.aggregate.mean);
  const maxMean = Math.max(...means);

  const atMax = selection.select({ minConfidence: maxMean });
  ok(atMax.count >= 1, "the top-confidence words survive");
  for (const id of atMax.nodeIds) {
    ok(reader.get(id)!.confidence.aggregate.mean >= maxMean, "mean bound holds");
  }

  equal(
    selection.select({ minConfidence: maxMean + 0.01 }).count,
    0,
    "no candidate above the maximum"
  );
  equal(selection.select({ maxConfidence: 0 }).count, 0, "no zero-confidence word");
});

test("selection filters by containment and geometry", () => {
  const { reader, selection } = makeSelection();
  const document = reader.get(HIERARCHY_DOCUMENT_ID)!;
  const inDocument = selection.select({
    level: NODE_LEVEL.WORD,
    containedIn: document.id,
  });
  equal(inDocument.count, reader.words().length, "the document contains every word");

  const firstRegion = reader.regions()[0];
  const inRegion = selection.select({
    level: NODE_LEVEL.WORD,
    containedIn: firstRegion.id,
  });
  ok(inRegion.count >= 1, "the region contains its words");
  ok(inRegion.count <= reader.words().length, "never more than all words");

  const word = reader.get("word-0-0-0")!;
  const exactly = selection.select({ level: NODE_LEVEL.WORD, containing: word.bbox });
  equal(exactly.count, 1, "only the word's own box contains it");
  equal(exactly.nodeIds[0], word.id, "the selected word is the target");

  equal(
    selection.select({ level: NODE_LEVEL.WORD, containedIn: "missing" }).count,
    0,
    "unknown containment target selects nothing"
  );
});

test("selection is deterministic across repeated calls", () => {
  const { selection } = makeSelection();
  const a = selection.select({ level: NODE_LEVEL.LINE, order: "reading" });
  const b = selection.select({ level: NODE_LEVEL.LINE, order: "reading" });
  equal(JSON.stringify(a), JSON.stringify(b), "identical results");

  const nodes = selection.selectNodes({});
  ok(Object.isFrozen(nodes), "node list is frozen");
  equal(nodes.length, selection.select({}).count, "nodes and ids agree");
});
