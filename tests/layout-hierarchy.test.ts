/**
 * Milestone 4 hierarchy model tests: the immutable node factory, the sibling
 * comparator, the `LayoutHierarchy` container queries, constructor rejection
 * of structurally invalid trees, and deep immutability.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_LEVELS,
  HIERARCHY_ROOT_LEVEL,
  NODE_LEVEL,
  REGION_TYPE,
  LayoutHierarchy,
  compareHierarchyNodes,
  createConfidenceProfile,
  createHierarchyNode,
  isHierarchyLevel,
} from "@/lib/layout";
import type { HierarchyLevel, HierarchyNode } from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

const neutral = createConfidenceProfile([]);

function wordNode(
  id: string,
  wi: number,
  x: number,
  parentId = "line-0",
  li = 0
): HierarchyNode {
  return createHierarchyNode({
    id,
    level: NODE_LEVEL.WORD,
    parentId,
    pageIndex: 0,
    bbox: { x, y: 0, width: 20, height: 8 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: [],
    sourceRefs: [{ pageIndex: 0, lineIndex: li, wordIndex: wi }],
    metadata: { index: wi },
  });
}

/** A minimal level-valid chain: document → page → region → block → line → words. */
function chainNodes(): HierarchyNode[] {
  const line = createHierarchyNode({
    id: "line-0",
    level: NODE_LEVEL.LINE,
    parentId: "block-0",
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 60, height: 8 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["word-2", "word-0", "word-1"],
    sourceRefs: [{ pageIndex: 0, lineIndex: 0 }],
    metadata: {},
  });
  const block = createHierarchyNode({
    id: "block-0",
    level: NODE_LEVEL.BLOCK,
    parentId: "region-0",
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 60, height: 8 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["line-0"],
    sourceRefs: [],
    metadata: {},
  });
  const region = createHierarchyNode({
    id: "region-0",
    level: NODE_LEVEL.REGION,
    parentId: "page-0",
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 60, height: 8 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["block-0"],
    sourceRefs: [],
    metadata: {},
    regionType: REGION_TYPE.UNKNOWN,
  });
  const page = createHierarchyNode({
    id: "page-0",
    level: NODE_LEVEL.PAGE,
    parentId: HIERARCHY_DOCUMENT_ID,
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 60, height: 40 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["region-0"],
    sourceRefs: [],
    metadata: { index: 0 },
  });
  const doc = createHierarchyNode({
    id: HIERARCHY_DOCUMENT_ID,
    level: HIERARCHY_ROOT_LEVEL,
    parentId: null,
    pageIndex: -1,
    bbox: { x: 0, y: 0, width: 60, height: 40 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: ["page-0"],
    sourceRefs: [],
    metadata: {},
  });
  return [
    doc,
    page,
    region,
    block,
    line,
    wordNode("word-0", 0, 0),
    wordNode("word-1", 1, 20),
    wordNode("word-2", 2, 40),
  ];
}

/** A generic node factory for rejection tests. */
function n(
  id: string,
  level: HierarchyLevel,
  parentId: string | null = HIERARCHY_DOCUMENT_ID,
  children: string[] = [],
  pageIndex = 0
): HierarchyNode {
  return createHierarchyNode({
    id,
    level,
    parentId,
    pageIndex,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children,
    sourceRefs: [],
    metadata: level === NODE_LEVEL.PAGE ? { index: pageIndex } : {},
    ...(level === NODE_LEVEL.REGION ? { regionType: REGION_TYPE.UNKNOWN } : {}),
  });
}

function throws(fn: () => unknown, needle?: string): Error {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (err === undefined) {
    throw new Error("expected function to throw");
  }
  const message = (err as Error).message;
  if (needle !== undefined && !message.includes(needle)) {
    throw new Error(
      `expected error containing ${JSON.stringify(needle)}, got ${JSON.stringify(message)}`
    );
  }
  return err as Error;
}

// ─── Level vocabulary ────────────────────────────────────────────────────────

test("hierarchy levels reuse the node vocabulary with a Document root", () => {
  equal(HIERARCHY_LEVELS, [
    "Document",
    "Page",
    "Region",
    "Block",
    "Line",
    "Word",
  ]);
  ok(isHierarchyLevel("Document"));
  ok(isHierarchyLevel(NODE_LEVEL.WORD));
  ok(!isHierarchyLevel("Unknown"));
});

// ─── Factory ─────────────────────────────────────────────────────────────────

test("createHierarchyNode deep-freezes the node and every owned structure", () => {
  const node = wordNode("w", 1, 10);
  ok(Object.isFrozen(node));
  ok(Object.isFrozen(node.bbox));
  ok(Object.isFrozen(node.normalizedBBox));
  ok(Object.isFrozen(node.children));
  ok(Object.isFrozen(node.sourceRefs));
  ok(Object.isFrozen(node.sourceRefs[0]));
  ok(Object.isFrozen(node.metadata));
});

test("createHierarchyNode rejects invalid inputs", () => {
  throws(
    () =>
      createHierarchyNode({
        id: "",
        level: NODE_LEVEL.WORD,
        parentId: null,
        pageIndex: 0,
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
        confidence: neutral,
      }),
    "must not be empty"
  );
  throws(
    () =>
      createHierarchyNode({
        id: "x",
        level: "Unknown" as HierarchyLevel,
        parentId: null,
        pageIndex: 0,
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
        confidence: neutral,
      }),
    "unknown hierarchy level"
  );
  throws(
    () =>
      createHierarchyNode({
        id: "x",
        level: NODE_LEVEL.WORD,
        parentId: null,
        pageIndex: 0,
        bbox: { x: 0, y: 0, width: Number.NaN, height: 1 },
        normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
        confidence: neutral,
      }),
    "non-finite bbox"
  );
  throws(
    () =>
      createHierarchyNode({
        id: "x",
        level: NODE_LEVEL.WORD,
        parentId: null,
        pageIndex: 0,
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
        confidence: neutral,
        regionType: REGION_TYPE.UNKNOWN,
      }),
    "only applies to REGION nodes"
  );
});

// ─── Comparator ──────────────────────────────────────────────────────────────

test("comparator orders words by reading order (page, line, word)", () => {
  const a = wordNode("a", 2, 100);
  const b = wordNode("b", 1, 50);
  const c = wordNode("c", 0, 0, "line-1", 1);
  ok(compareHierarchyNodes(a, b) > 0, "later word index sorts after");
  ok(compareHierarchyNodes(b, a) < 0);
  ok(compareHierarchyNodes(b, c) < 0, "earlier line sorts before");
  ok(compareHierarchyNodes(c, b) > 0, "later line sorts after");
});

test("comparator falls back to stable geometric order and id", () => {
  const r1 = n("r1", NODE_LEVEL.REGION, "page-0", [], 0);
  const r2 = n("r2", NODE_LEVEL.REGION, "page-0", [], 0);
  ok(compareHierarchyNodes(r1, r2) < 0, "identical geometry ties by id");
  ok(compareHierarchyNodes(r2, r1) > 0);
  const top = createHierarchyNode({
    id: "top",
    level: NODE_LEVEL.REGION,
    parentId: "page-0",
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: [],
    sourceRefs: [],
    metadata: {},
    regionType: REGION_TYPE.UNKNOWN,
  });
  const low = createHierarchyNode({
    id: "low",
    level: NODE_LEVEL.REGION,
    parentId: "page-0",
    pageIndex: 0,
    bbox: { x: 0, y: 50, width: 10, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: neutral,
    children: [],
    sourceRefs: [],
    metadata: {},
    regionType: REGION_TYPE.UNKNOWN,
  });
  ok(compareHierarchyNodes(top, low) < 0, "higher node sorts before");
  ok(compareHierarchyNodes(low, top) > 0, "lower node sorts after");
});

test("comparator orders pages by page index", () => {
  const p0 = n("page-0", NODE_LEVEL.PAGE, null, [], 0);
  const p1 = n("page-1", NODE_LEVEL.PAGE, null, [], 1);
  ok(compareHierarchyNodes(p0, p1) < 0);
});

// ─── Container queries ───────────────────────────────────────────────────────

test("LayoutHierarchy answers structural queries", () => {
  const hierarchy = new LayoutHierarchy(chainNodes());
  equal(hierarchy.rootId, "document");
  equal(hierarchy.root().id, "document");
  equal(hierarchy.nodeCount, 8);
  ok(hierarchy.has("block-0"));
  equal(hierarchy.get("ghost"), undefined);
  equal(
    hierarchy.nodesAtLevel(NODE_LEVEL.WORD).map((node) => node.id),
    ["word-0", "word-1", "word-2"]
  );
  equal(
    hierarchy.descendantsOf("document").length,
    7
  );
  equal(
    hierarchy.ancestorsOf("word-1").map((node) => node.id),
    ["document", "page-0", "region-0", "block-0", "line-0"]
  );
  equal(hierarchy.parentOf("word-1")!.id, "line-0");
  equal(hierarchy.parentOf("document"), null);
  equal(hierarchy.siblingsOf("word-1").map((node) => node.id), [
    "word-0",
    "word-2",
  ]);
  equal(hierarchy.depthOf("word-1"), 5);
  equal(hierarchy.depthOf("ghost"), -1);
});

test("LayoutHierarchy normalizes sibling order deterministically", () => {
  const hierarchy = new LayoutHierarchy(chainNodes());
  equal(
    hierarchy.childrenOf("line-0").map((node) => node.id),
    ["word-0", "word-1", "word-2"],
    "out-of-order input children are re-sorted by reading order"
  );
});

test("LayoutHierarchy query views are frozen", () => {
  const hierarchy = new LayoutHierarchy(chainNodes());
  ok(Object.isFrozen(hierarchy));
  ok(Object.isFrozen(hierarchy.nodes()));
  ok(Object.isFrozen(hierarchy.childrenOf("document")));
});

// ─── Constructor rejection ───────────────────────────────────────────────────

test("constructor rejects duplicate ids", () => {
  const nodes = chainNodes();
  const dup = wordNode("word-0", 9, 9);
  throws(() => new LayoutHierarchy([...nodes, dup]), "duplicate hierarchy node id");
});

test("constructor rejects missing or multiple roots", () => {
  const nodes = chainNodes();
  throws(
    () => new LayoutHierarchy(nodes.slice(1)),
    "no root node"
  );
  throws(
    () => new LayoutHierarchy([...nodes, n("page-1", NODE_LEVEL.PAGE, null, [], 1)]),
    "exactly one root"
  );
});

test("constructor rejects a root that is not a Document node", () => {
  throws(
    () => new LayoutHierarchy([n("only", NODE_LEVEL.PAGE, null, [])]),
    "must be a Document node"
  );
});

test("constructor rejects orphan and unknown references", () => {
  throws(
    () =>
      new LayoutHierarchy([
        n(HIERARCHY_DOCUMENT_ID, HIERARCHY_ROOT_LEVEL, null, []),
        n("page-0", NODE_LEVEL.PAGE, HIERARCHY_DOCUMENT_ID, []),
      ]),
    "not claimed by its parent"
  );
  throws(
    () =>
      new LayoutHierarchy([
        n(HIERARCHY_DOCUMENT_ID, HIERARCHY_ROOT_LEVEL, null, ["ghost"]),
      ]),
    "unknown child"
  );
});

test("constructor rejects duplicated ownership and mismatched parents", () => {
  throws(
    () =>
      new LayoutHierarchy([
        n(HIERARCHY_DOCUMENT_ID, HIERARCHY_ROOT_LEVEL, null, ["page-0"]),
        n("page-0", NODE_LEVEL.PAGE, HIERARCHY_DOCUMENT_ID, ["region-0"]),
        n("page-1", NODE_LEVEL.PAGE, HIERARCHY_DOCUMENT_ID, ["region-0"]),
        n("region-0", NODE_LEVEL.REGION, "page-0", []),
      ]),
    "claimed by both page-0 and page-1"
  );
  throws(
    () =>
      new LayoutHierarchy([
        n(HIERARCHY_DOCUMENT_ID, HIERARCHY_ROOT_LEVEL, null, ["page-0"]),
        n("page-0", NODE_LEVEL.PAGE, "ghost", []),
      ]),
    "declares parent ghost"
  );
});

test("constructor rejects invalid level adjacency", () => {
  throws(
    () =>
      new LayoutHierarchy([
        n(HIERARCHY_DOCUMENT_ID, HIERARCHY_ROOT_LEVEL, null, ["region-0"]),
        n("region-0", NODE_LEVEL.REGION, HIERARCHY_DOCUMENT_ID, []),
      ]),
    "invalid under"
  );
});

test("constructor rejects parent cycles", () => {
  // A level-valid parent cycle is structurally impossible (levels strictly
  // descend along each parent edge), so the cycle is rejected through the
  // level-adjacency check. The cycle validator covers the general case.
  throws(
    () =>
      new LayoutHierarchy([
        n(HIERARCHY_DOCUMENT_ID, HIERARCHY_ROOT_LEVEL, null, ["x"]),
        n("x", NODE_LEVEL.PAGE, HIERARCHY_DOCUMENT_ID, ["y"]),
        n("y", NODE_LEVEL.REGION, "x", ["x"]),
      ]),
    "invalid under"
  );
});

// ─── Deep immutability ───────────────────────────────────────────────────────

test("LayoutHierarchy instances and nodes are immutable", () => {
  const hierarchy = new LayoutHierarchy(chainNodes());
  ok(Object.isFrozen(hierarchy));
  for (const node of hierarchy.nodes()) {
    ok(Object.isFrozen(node), `node ${node.id} is frozen`);
    ok(Object.isFrozen(node.children), `node ${node.id} children are frozen`);
  }
});
