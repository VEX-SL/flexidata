/**
 * Milestone 6 reading order builder tests — construction mechanics: the
 * deterministic rebuild guarantee, the OCR-ordering metadata as the primary
 * reading signal (with ref-less containers inheriting the minimum subtree
 * reference), page boundaries, the geometry-only fallback, and the optional
 * `SpatialIndex` used to break coincident-box ties.
 */
import {
  NODE_LEVEL,
  HIERARCHY_ROOT_LEVEL,
  HIERARCHY_DOCUMENT_ID,
  REGION_TYPE,
  buildHierarchy,
  buildReadingOrder,
  createConfidenceProfile,
  createHierarchyNode,
  segmentDocument,
  normalizeBox,
  unionBoxes,
  validateReadingOrderDeterminism,
  SpatialIndex,
  LayoutHierarchy,
} from "@/lib/layout";
import type {
  HierarchyNode,
  HierarchySourceRef,
  ReadingOrderGraph,
} from "@/lib/layout";
import type { BBox, OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { test, ok, equal } from "./harness.ts";

const PAGE_WIDTH = 800;
const PAGE_HEIGHT = 600;

function norm(box: BBox): BBox {
  return normalizeBox(box, PAGE_WIDTH, PAGE_HEIGHT);
}

function profile() {
  return createConfidenceProfile([]);
}

// ─── Real-document helpers ───────────────────────────────────────────────────

interface WordSpec {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function mkWord(s: WordSpec): OcrWord {
  return { text: s.text, bbox: { x: s.x, y: s.y, width: s.w, height: s.h } };
}

function mkLine(words: OcrWord[]): OcrLine {
  const bbox = unionBoxes(words.map((w) => w.bbox!));
  return {
    text: words.map((w) => w.text).join(" "),
    words,
    ...(bbox ? { bbox } : {}),
  };
}

function mkDoc(lines: OcrLine[]): OcrDocument {
  return { text: lines.map((l) => l.text).join("\n"), lines };
}

function row(y: number, xs: readonly number[], w = 40, h = 10): OcrLine {
  return mkLine(xs.map((x, i) => mkWord({ text: `w${i}`, x, y, w, h })));
}

function realHierarchy(lines: OcrLine[]): LayoutHierarchy {
  return buildHierarchy(mkDoc(lines), segmentDocument(mkDoc(lines)).blocks);
}

function build(hierarchy: LayoutHierarchy): ReadingOrderGraph {
  return buildReadingOrder(hierarchy);
}

// ─── Hand-built hierarchy helpers ────────────────────────────────────────────

interface WordSpecHand {
  id: string;
  box: BBox;
  ref?: HierarchySourceRef;
}
interface LineSpecHand {
  id: string;
  words: WordSpecHand[];
}
interface BlockSpecHand {
  id: string;
  lines: LineSpecHand[];
  refs?: HierarchySourceRef[];
}
interface RegionSpecHand {
  id: string;
  blocks: BlockSpecHand[];
}
interface PageSpecHand {
  id: string;
  pageIndex: number;
  index?: number;
  regions: RegionSpecHand[];
}
interface DocSpecHand {
  pages: PageSpecHand[];
}

/** A full Document → Page → Region → Block → Line → Word tree, hand-specified. */
function buildHandHierarchy(doc: DocSpecHand): LayoutHierarchy {
  const nodes: HierarchyNode[] = [];
  const add = (n: HierarchyNode): void => {
    nodes.push(n);
  };
  const pageNodes: HierarchyNode[] = [];
  for (const page of doc.pages) {
    const regionNodes: HierarchyNode[] = [];
    for (const region of page.regions) {
      const blockNodes: HierarchyNode[] = [];
      for (const block of region.blocks) {
        const lineNodes: HierarchyNode[] = [];
        for (const line of block.lines) {
          const wordNodes: HierarchyNode[] = line.words.map((w) =>
            createHierarchyNode({
              id: w.id,
              level: NODE_LEVEL.WORD,
              parentId: line.id,
              pageIndex: page.pageIndex,
              bbox: w.box,
              normalizedBBox: norm(w.box),
              confidence: profile(),
              children: [],
              sourceRefs: w.ref ? [w.ref] : [],
            })
          );
          for (const wordNode of wordNodes) add(wordNode);
          const lineBox = unionBoxes(wordNodes.map((n) => n.bbox))!;
          const lineNode = createHierarchyNode({
            id: line.id,
            level: NODE_LEVEL.LINE,
            parentId: block.id,
            pageIndex: page.pageIndex,
            bbox: lineBox,
            normalizedBBox: norm(lineBox),
            confidence: profile(),
            children: wordNodes.map((n) => n.id),
            sourceRefs: [],
          });
          add(lineNode);
          lineNodes.push(lineNode);
        }
        const blockBox = unionBoxes(lineNodes.map((n) => n.bbox))!;
        const blockNode = createHierarchyNode({
          id: block.id,
          level: NODE_LEVEL.BLOCK,
          parentId: region.id,
          pageIndex: page.pageIndex,
          bbox: blockBox,
          normalizedBBox: norm(blockBox),
          confidence: profile(),
          children: lineNodes.map((n) => n.id),
          sourceRefs: block.refs ?? [],
        });
        add(blockNode);
        blockNodes.push(blockNode);
      }
      const regionBox = unionBoxes(blockNodes.map((n) => n.bbox))!;
      const regionNode = createHierarchyNode({
        id: region.id,
        level: NODE_LEVEL.REGION,
        parentId: page.id,
        pageIndex: page.pageIndex,
        bbox: regionBox,
        normalizedBBox: norm(regionBox),
        confidence: profile(),
        children: blockNodes.map((n) => n.id),
        sourceRefs: [],
        regionType: REGION_TYPE.UNKNOWN,
      });
      add(regionNode);
      regionNodes.push(regionNode);
    }
    const pageBox =
      unionBoxes(regionNodes.map((n) => n.bbox)) ?? { x: 0, y: 0, width: 0, height: 0 };
    const pageNode = createHierarchyNode({
      id: page.id,
      level: NODE_LEVEL.PAGE,
      parentId: HIERARCHY_DOCUMENT_ID,
      pageIndex: page.pageIndex,
      bbox: pageBox,
      normalizedBBox: norm(pageBox),
      confidence: profile(),
      children: regionNodes.map((n) => n.id),
      sourceRefs: [],
      metadata: page.index !== undefined ? { index: page.index } : {},
    });
    add(pageNode);
    pageNodes.push(pageNode);
  }
  const docBox =
    unionBoxes(pageNodes.map((n) => n.bbox)) ?? { x: 0, y: 0, width: 0, height: 0 };
  add(
    createHierarchyNode({
      id: HIERARCHY_DOCUMENT_ID,
      level: HIERARCHY_ROOT_LEVEL,
      parentId: null,
      pageIndex: -1,
      bbox: docBox,
      normalizedBBox: norm(docBox),
      confidence: profile(),
      children: pageNodes.map((n) => n.id),
      sourceRefs: [],
      metadata: {},
    })
  );
  return new LayoutHierarchy(nodes);
}

function wordRef(pageIndex: number, lineIndex: number, wordIndex: number): HierarchySourceRef {
  return { pageIndex, lineIndex, wordIndex };
}

/** Build a complete spatial index over every hierarchy node. */
function indexOf(hierarchy: LayoutHierarchy): SpatialIndex<HierarchyNode> {
  return SpatialIndex.build(
    hierarchy.nodes().map((n) => ({ key: n.id, bbox: n.bbox, value: n }))
  );
}

// ─── 1. Empty document ───────────────────────────────────────────────────────

test("empty document builds a single Document node with no edges", () => {
  const hierarchy = realHierarchy([]);
  const graph = build(hierarchy);
  equal(graph.nodeCount, 1);
  equal(graph.readingSequence(), ["document"]);
  equal(graph.edgeCount, 0);
  equal(graph.first(HIERARCHY_ROOT_LEVEL)?.id, "document");
  equal(graph.last(HIERARCHY_ROOT_LEVEL)?.id, "document");
});

// ─── 2. Deterministic rebuilds ───────────────────────────────────────────────

test("rebuilding the same hierarchy reproduces identical graphs", () => {
  const lines: OcrLine[] = [];
  for (let r = 0; r < 4; r++) lines.push(row(r * 14, [0, 50, 100]));
  const hierarchy = realHierarchy(lines);
  const first = build(hierarchy);
  const second = build(hierarchy);
  equal(first.readingSequence(), second.readingSequence());
  equal(first.edges(), second.edges());
  const result = validateReadingOrderDeterminism(first, second);
  ok(result.valid, result.errors.join("; "));
});

// ─── 3. Spatial index handling ───────────────────────────────────────────────

test("a complete spatial index leaves the deterministic order unchanged", () => {
  const lines: OcrLine[] = [];
  for (let r = 0; r < 4; r++) lines.push(row(r * 14, [0, 50, 100]));
  const hierarchy = realHierarchy(lines);
  const withoutIndex = build(hierarchy);
  const withIndex = buildReadingOrder(hierarchy, { spatialIndex: indexOf(hierarchy) });
  equal(withIndex.readingSequence(), withoutIndex.readingSequence());
  const result = validateReadingOrderDeterminism(withoutIndex, withIndex);
  ok(result.valid, result.errors.join("; "));
});

test("a spatial index missing any hierarchy node is rejected", () => {
  const lines: OcrLine[] = [];
  for (let r = 0; r < 2; r++) lines.push(row(r * 14, [0, 50, 100]));
  const hierarchy = realHierarchy(lines);
  const missing = hierarchy.nodes()[0].id;
  const partial = SpatialIndex.build(
    hierarchy
      .nodes()
      .filter((n) => n.id !== missing)
      .map((n) => ({ key: n.id, bbox: n.bbox, value: n }))
  );
  let threw: unknown;
  try {
    buildReadingOrder(hierarchy, { spatialIndex: partial });
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof Error, "expected the incomplete index to be rejected");
  ok(String((threw as Error).message).includes("missing hierarchy node"));
});

test("coincident boxes without metadata are tied by the spatial index", () => {
  const box: BBox = { x: 0, y: 0, width: 10, height: 10 };
  const hierarchy = buildHandHierarchy({
    pages: [
      {
        id: "page-0",
        pageIndex: 0,
        regions: [
          {
            id: "region-0-0",
            blocks: [
              {
                id: "block-0",
                lines: [
                  {
                    id: "line-0",
                    words: [
                      { id: "word-b", box },
                      { id: "word-a", box },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  // No index: geometry is identical, so id order wins.
  equal(build(hierarchy).nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id), [
    "word-a",
    "word-b",
  ]);
  // With an index that inserted word-b first, its overlap rank is earlier.
  const inserted = SpatialIndex.build(
    [
      ...hierarchy
        .nodes()
        .filter((n) => n.level !== NODE_LEVEL.WORD)
        .map((n) => ({ key: n.id, bbox: n.bbox, value: n })),
      { key: "word-b", bbox: box, value: hierarchy.get("word-b")! },
      { key: "word-a", bbox: box, value: hierarchy.get("word-a")! },
    ]
  );
  const graph = buildReadingOrder(hierarchy, { spatialIndex: inserted });
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id), [
    "word-b",
    "word-a",
  ]);
});

// ─── 4. Reading-key inheritance ──────────────────────────────────────────────

test("ref-less blocks inherit the minimum subtree source reference", () => {
  const hierarchy = buildHandHierarchy({
    pages: [
      {
        id: "page-0",
        pageIndex: 0,
        regions: [
          {
            id: "region-0-0",
            blocks: [
              {
                id: "block-a",
                lines: [
                  {
                    id: "line-a",
                    words: [
                      {
                        id: "word-a-0",
                        box: { x: 0, y: 0, width: 40, height: 10 },
                        ref: wordRef(0, 5, 0),
                      },
                    ],
                  },
                ],
              },
              {
                id: "block-b",
                lines: [
                  {
                    id: "line-b",
                    words: [
                      {
                        id: "word-b-0",
                        box: { x: 0, y: 200, width: 40, height: 10 },
                        ref: wordRef(0, 0, 0),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const graph = build(hierarchy);
  // block-a sits above block-b geometrically but its OCR line index is later.
  equal(graph.nodesAtLevel(NODE_LEVEL.BLOCK).map((n) => n.id), [
    "block-b",
    "block-a",
  ]);
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id), [
    "word-b-0",
    "word-a-0",
  ]);
  equal(graph.nodesAtLevel(NODE_LEVEL.REGION).map((n) => n.id), ["region-0-0"]);
});

test("pages order by page index and words never bleed across pages", () => {
  const hierarchy = buildHandHierarchy({
    pages: [
      {
        id: "page-0",
        pageIndex: 0,
        index: 0,
        regions: [
          {
            id: "region-0-0",
            blocks: [
              {
                id: "block-0",
                lines: [
                  {
                    id: "line-0",
                    words: [
                      {
                        id: "word-0",
                        box: { x: 0, y: 0, width: 40, height: 10 },
                        ref: wordRef(0, 2, 0),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "page-1",
        pageIndex: 1,
        index: 1,
        regions: [
          {
            id: "region-1-0",
            blocks: [
              {
                id: "block-1",
                lines: [
                  {
                    id: "line-1",
                    words: [
                      {
                        id: "word-1",
                        box: { x: 0, y: 0, width: 40, height: 10 },
                        ref: wordRef(1, 0, 0),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const graph = build(hierarchy);
  equal(graph.nodesAtLevel(NODE_LEVEL.PAGE).map((n) => n.id), ["page-0", "page-1"]);
  // page-1's word has the earliest OCR line index, yet page order wins.
  equal(graph.nodesAtLevel(NODE_LEVEL.WORD).map((n) => n.id), ["word-0", "word-1"]);
  equal(graph.nodesAtLevel(NODE_LEVEL.LINE).map((n) => n.id), ["line-0", "line-1"]);
});

// ─── 5. Real-document smoke coverage ─────────────────────────────────────────

test("builder output is fully covered by the reading-order graph", () => {
  const lines: OcrLine[] = [];
  for (let r = 0; r < 3; r++) lines.push(row(r * 14, [0, 50, 100, 150]));
  const hierarchy = realHierarchy(lines);
  const graph = build(hierarchy);
  equal(graph.nodeCount, hierarchy.nodeCount);
  for (const node of hierarchy.nodes()) {
    ok(graph.has(node.id), `graph covers hierarchy node ${node.id}`);
    const readingNode = graph.get(node.id)!;
    equal(readingNode.level, node.level);
    equal(readingNode.position, graph.positionOf(node.id));
  }
  ok(graph.positionOf("document") === graph.nodeCount - 1, "document closes the sequence");
});
