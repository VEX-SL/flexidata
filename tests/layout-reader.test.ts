/**
 * Milestone 10 layout-reader tests — immutable navigation over a complete M9
 * context: level iteration, id/source-ref lookup, structural navigation and
 * reading-order navigation. Unknown and broken lookups degrade to safe frozen
 * views, and the reader never duplicates the frozen hierarchy nodes.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  LayoutReader,
  NODE_LEVEL,
  brokenLayoutContext,
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

function reader(): LayoutReader {
  const result = buildLayoutPipeline().build(mkDoc());
  ok(result.failure === undefined, "build succeeds");
  return new LayoutReader(result.context);
}

test("reader iterates levels deterministically and covers the hierarchy", () => {
  const r = reader();
  const words = r.words();
  const lines = r.lines();
  const blocks = r.blocks();
  const regions = r.regions();
  const pages = r.atLevel(NODE_LEVEL.PAGE);

  equal(words.length, 6, "every positioned word has a node");
  equal(lines.length, 3, "one line node per source line");
  ok(blocks.length >= 1, "at least one block");
  ok(regions.length >= 1, "at least one region");
  equal(pages.length, 1, "single page");

  const total =
    words.length + lines.length + blocks.length + regions.length + pages.length + 1;
  equal(r.nodes().length, total, "levels partition the node set");
  equal(r.nodes().length, r.context.hierarchy!.nodeCount, "nodes match the hierarchy");

  ok(Object.isFrozen(r.nodes()), "node view is frozen");
  ok(r.isAvailable, "reader is available over a complete context");
});

test("reader looks up nodes and navigates the tree", () => {
  const r = reader();
  const word = r.get("word-0-0-0");
  ok(word !== undefined, "word node resolves by id");
  equal(word!.level, NODE_LEVEL.WORD, "resolved node is a word");

  const line = r.parent(word!.id);
  ok(line !== null, "word has a parent");
  equal(line!.level, NODE_LEVEL.LINE, "parent is a line");

  const ancestors = r.ancestors(word!.id);
  equal(ancestors[0].id, HIERARCHY_DOCUMENT_ID, "coarsest ancestor is the document");
  equal(ancestors[ancestors.length - 1].id, line!.id, "finest ancestor is the parent line");
  equal(ancestors.length, 5, "document/page/region/block/line");

  const children = r.children(line!.id);
  ok(children.some((c) => c.id === word!.id), "line contains the word");

  const descendants = r.descendants(HIERARCHY_DOCUMENT_ID);
  equal(descendants.length, r.nodes().length - 1, "descendants exclude the root");

  ok(r.has("word-0-2-0"), "deep node id resolves");
  equal(r.depthOf(HIERARCHY_DOCUMENT_ID), 0, "root depth is 0");
  equal(r.depthOf("word-0-0-0"), 5, "word depth is 5");
  ok(r.siblings("word-0-0-1").length >= 1, "words on a line are siblings");
});

test("reader resolves source references exactly", () => {
  const r = reader();
  const word = r.nodeBySourceRef({ pageIndex: 0, lineIndex: 0, wordIndex: 1 });
  ok(word !== undefined, "word ref resolves");
  equal(word!.id, "word-0-0-1", "exact word node");
  equal(word!.level, NODE_LEVEL.WORD, "finest owner of a word ref");

  const line = r.nodeBySourceRef({ pageIndex: 0, lineIndex: 2 });
  ok(line !== undefined, "line ref resolves");
  equal(line!.level, NODE_LEVEL.LINE, "line ref resolves to the line node");

  const matches = r.nodesBySourceRef({ pageIndex: 0, lineIndex: 0, wordIndex: 0 });
  ok(matches.length >= 1, "at least the word node matches");
  ok(matches.some((n) => n.id === "word-0-0-0"), "word node is among the matches");

  equal(
    r.nodeBySourceRef({ pageIndex: 0, lineIndex: 99 }),
    undefined,
    "unknown line ref"
  );
  equal(
    r.nodeBySourceRef({ pageIndex: 5, lineIndex: 0, wordIndex: 0 }),
    undefined,
    "unknown page ref"
  );
});

test("reader navigates reading order deterministically", () => {
  const r = reader();
  equal(r.readingPosition("word-0-0-0"), 0, "first word opens the reading sequence");
  equal(r.readingPosition("word-0-0-1"), 1, "words follow in source order");
  equal(r.readingPosition("word-0-2-0"), 5, "last word closes the word chain");

  equal(r.readingNext("word-0-0-0")!.id, "word-0-0-1", "next word");
  equal(r.readingPrevious("word-0-0-0"), undefined, "no previous before the first word");

  equal(r.readingNext("word-0-2-0"), undefined, "the word chain ends at its last word");

  const chain = r.readingNodes();
  equal(chain[0].id, "word-0-0-0", "reading sequence starts at the first word");
  equal(chain[0].level, NODE_LEVEL.WORD, "the sequence opens with the word chain");
  equal(chain[6].level, NODE_LEVEL.LINE, "the line chain follows the word chain");
  for (let i = 1; i < chain.length; i++) {
    ok(chain[i].position > chain[i - 1].position, "positions strictly increase");
  }
});

test("unknown and broken lookups are safe and frozen", () => {
  const r = reader();
  equal(r.get("missing"), undefined, "unknown id");
  equal(r.has("missing"), false, "unknown id not present");
  equal(r.parent("missing"), null, "unknown parent");
  equal(r.children("missing").length, 0, "unknown children");
  equal(r.descendants("missing").length, 0, "unknown descendants");
  equal(r.depthOf("missing"), -1, "unknown depth");
  equal(r.readingPosition("missing"), undefined, "unknown position");
  ok(Object.isFrozen(r.children("missing")), "empty view is frozen");

  const broken = new LayoutReader(brokenLayoutContext());
  equal(broken.isAvailable, false, "broken context is not navigable");
  equal(broken.nodes().length, 0, "broken context yields no nodes");
  equal(broken.words().length, 0, "broken context yields no words");
  equal(broken.get("word-0-0-0"), undefined, "broken context has no nodes");
  equal(broken.readingNodes().length, 0, "broken context has no reading order");
  ok(Object.isFrozen(broken.nodes()), "broken views are frozen");
});

test("reader never duplicates the frozen hierarchy nodes", () => {
  const r = reader();
  const hierarchy = r.context.hierarchy!;
  ok(r.get("word-0-0-0") === hierarchy.get("word-0-0-0"), "get returns the shared node");
  equal(r.words()[0].id, "word-0-0-0", "level view starts at the first pre-order word");
  ok(r.words()[0] === hierarchy.get("word-0-0-0"), "level views return shared nodes");
  ok(Object.isFrozen(r.get("word-0-0-0")!), "shared nodes stay frozen");
  ok(Object.isFrozen(r), "reader itself is frozen");
});
