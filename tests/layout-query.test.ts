/**
 * Milestone 10 layout-query tests — deterministic navigation queries over the
 * reader: region/block/line/word membership, reading-order word iteration and
 * geometry queries (nearest / containing / contained). Queries never inspect
 * text and always return frozen, deterministic results.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  LayoutQuery,
  LayoutReader,
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

function makeQuery(): { reader: LayoutReader; query: LayoutQuery } {
  const result = buildLayoutPipeline().build(mkDoc());
  ok(result.failure === undefined, "build succeeds");
  const reader = new LayoutReader(result.context);
  return { reader, query: new LayoutQuery(reader) };
}

test("findRegions filters by region type only", () => {
  const { reader, query } = makeQuery();
  const all = query.findRegions();
  equal(all.length, reader.regions().length, "no filter returns every region");
  ok(all.length >= 1, "the document has regions");
  for (const region of all) {
    equal(region.level, NODE_LEVEL.REGION, "results are regions");
    ok(region.regionType !== undefined, "regions carry a type");
  }
  equal(
    query.findRegions(REGION_TYPE.UNKNOWN).length,
    all.length,
    "the structural regions are UNKNOWN in this milestone"
  );
  equal(query.findRegions(REGION_TYPE.HEADER).length, 0, "no header regions");
  ok(Object.isFrozen(query.findRegions()), "region view is frozen");
});

test("findBlocks/findLines/findWords resolve membership", () => {
  const { reader, query } = makeQuery();
  const regions = query.findRegions();
  const blocks = query.findBlocks(regions[0].id);
  ok(blocks.length >= 1, "region contains blocks");
  for (const block of blocks) {
    equal(block.level, NODE_LEVEL.BLOCK, "results are blocks");
    const lines = query.findLines(block.id);
    ok(lines.length >= 1, "block contains lines");
    for (const line of lines) {
      equal(line.level, NODE_LEVEL.LINE, "results are lines");
      const words = query.findWords(line.id);
      ok(words.length >= 1, "line contains words");
      for (const word of words) {
        equal(word.level, NODE_LEVEL.WORD, "results are words");
      }
    }
  }

  let counted = 0;
  for (const region of regions) {
    for (const block of query.findBlocks(region.id)) {
      for (const line of query.findLines(block.id)) {
        counted += query.findWords(line.id).length;
      }
    }
  }
  equal(counted, reader.words().length, "membership covers every word exactly once");
});

test("findWordsInRegion and findWordsInBlock cover words by structure", () => {
  const { reader, query } = makeQuery();
  equal(query.findWordsInRegion().length, reader.words().length, "all words");
  equal(
    query.findWordsInRegion(REGION_TYPE.UNKNOWN).length,
    reader.words().length,
    "all words live in UNKNOWN regions"
  );
  equal(query.findWordsInRegion(REGION_TYPE.HEADER).length, 0, "no words in headers");

  const block = reader.blocks()[0];
  const blockWords = query.findWordsInBlock(block.id);
  ok(blockWords.length >= 1, "block has words");
  for (const word of blockWords) {
    equal(word.level, NODE_LEVEL.WORD, "block results are words");
  }
  equal(query.findWordsInBlock("missing").length, 0, "unknown block yields nothing");
});

test("findWordsInReadingOrder returns words in reading order", () => {
  const { reader, query } = makeQuery();
  const words = query.findWordsInReadingOrder();
  equal(words.length, reader.words().length, "every word appears");
  equal(words[0].id, "word-0-0-0", "the first word leads");
  const positions = words.map((w) => reader.readingPosition(w.id)!);
  for (let i = 1; i < positions.length; i++) {
    ok(positions[i] > positions[i - 1], "reading positions strictly increase");
  }
});

test("findNearest returns the nearest node deterministically", () => {
  const { reader, query } = makeQuery();
  const target = reader.get("word-0-0-1")!;
  const nearest = query.findNearest(target.id);
  ok(nearest !== undefined, "a nearest node exists");
  ok(nearest.node.id !== target.id, "never the node itself");
  const again = query.findNearest(target.id);
  equal(again!.node.id, nearest.node.id, "nearest is deterministic");
  ok(Number.isFinite(nearest.distance), "distance is finite");
  equal(query.findNearest("missing"), undefined, "unknown target");
});

test("findContaining and findContained answer geometry-only", () => {
  const { reader, query } = makeQuery();
  const word = reader.get("word-0-0-0")!;
  const containing = query.findContaining(word.id);
  ok(containing.length >= 4, "line, block, region, page, document contain the word");

  const line = reader.parent(word.id)!;
  const block = reader.parent(line.id)!;
  ok(containing.some((n) => n.id === line.id), "line contains its word");
  ok(containing.some((n) => n.id === block.id), "block contains its word");
  ok(
    containing.some((n) => n.id === HIERARCHY_DOCUMENT_ID),
    "document contains its word"
  );
  for (const node of containing) {
    ok(node.id !== word.id, "self is excluded");
  }

  const containedByDocument = query.findContained(HIERARCHY_DOCUMENT_ID);
  equal(
    containedByDocument.length,
    reader.nodes().length - 1,
    "the document contains every other node"
  );
  ok(Object.isFrozen(query.findContaining(word.id)), "containment view is frozen");
  equal(query.findContaining("missing").length, 0, "unknown target");
});
