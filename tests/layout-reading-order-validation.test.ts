/**
 * Milestone 6 reading order validation tests — every contract validator accepts
 * real builder output and rejects a hand-crafted graph that violates its
 * specific rule.
 */
import {
  NODE_LEVEL,
  HIERARCHY_ROOT_LEVEL,
  HIERARCHY_DOCUMENT_ID,
  buildHierarchy,
  buildReadingOrder,
  createReadingOrderNode,
  segmentDocument,
  unionBoxes,
  validateReadingOrderAcyclic,
  validateReadingOrderBidirectional,
  validateReadingOrderConnectivity,
  validateReadingOrderCoverage,
  validateReadingOrderDeterminism,
  validateReadingOrderFrozen,
  validateReadingOrderNoDuplicateEdges,
  validateReadingOrderSinglePredecessor,
  validateReadingOrderSingleSuccessor,
  validateReadingOrderTopology,
  READING_NEXT,
  READING_PREVIOUS,
  ReadingOrderGraph,
} from "@/lib/layout";
import type {
  HierarchyLevel,
  LayoutHierarchy,
  ReadingOrderEdge,
  ReadingOrderEdgeType,
  ReadingOrderNode,
} from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { test, ok } from "./harness.ts";

// ─── Real-document helpers ───────────────────────────────────────────────────

function mkWord(text: string, x: number, y: number): OcrWord {
  return { text, bbox: { x, y, width: 10, height: 10 } };
}

function mkLine(words: OcrWord[]): OcrLine {
  const bbox = unionBoxes(words.map((w) => w.bbox!));
  return { text: words.map((w) => w.text).join(" "), words, ...(bbox ? { bbox } : {}) };
}

function mkDoc(lines: OcrLine[]): OcrDocument {
  return { text: lines.map((l) => l.text).join("\n"), lines };
}

function realGraph(): { hierarchy: LayoutHierarchy; graph: ReadingOrderGraph } {
  const doc = mkDoc([
    mkLine([mkWord("a", 0, 0), mkWord("b", 50, 0), mkWord("c", 100, 0)]),
    mkLine([mkWord("d", 0, 20), mkWord("e", 50, 20)]),
  ]);
  const hierarchy = buildHierarchy(doc, segmentDocument(doc).blocks);
  return { hierarchy, graph: buildReadingOrder(hierarchy) };
}

// ─── Hand-graph helpers ──────────────────────────────────────────────────────

function node(id: string, level: HierarchyLevel, position: number): ReadingOrderNode {
  return createReadingOrderNode({
    id,
    level,
    pageIndex: level === HIERARCHY_ROOT_LEVEL ? -1 : 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    normalizedBBox: { x: 0, y: 0, width: 1 / 80, height: 1 / 60 },
    position,
  });
}

function edge(type: ReadingOrderEdgeType, from: string, to: string): ReadingOrderEdge {
  return { type, from, to };
}

const document = (position: number): ReadingOrderNode =>
  node(HIERARCHY_DOCUMENT_ID, HIERARCHY_ROOT_LEVEL, position);

function wordGraph(edges: readonly ReadingOrderEdge[]): ReadingOrderGraph {
  const words = [
    node("word-a", NODE_LEVEL.WORD, 0),
    node("word-b", NODE_LEVEL.WORD, 1),
    node("word-c", NODE_LEVEL.WORD, 2),
  ];
  return new ReadingOrderGraph([...words, document(3)], [...edges]);
}

function next(from: string, to: string): ReadingOrderEdge {
  return edge(READING_NEXT, from, to);
}

function prev(from: string, to: string): ReadingOrderEdge {
  return edge(READING_PREVIOUS, from, to);
}

// ─── 1. Every validator accepts real builder output ──────────────────────────

test("every validator accepts a real built graph", () => {
  const { hierarchy, graph } = realGraph();
  ok(validateReadingOrderConnectivity(graph).valid);
  ok(validateReadingOrderCoverage(hierarchy, graph).valid);
  ok(validateReadingOrderDeterminism(graph, graph).valid);
  ok(validateReadingOrderFrozen(graph).valid);
  ok(validateReadingOrderAcyclic(graph).valid);
  ok(validateReadingOrderBidirectional(graph).valid);
  ok(validateReadingOrderSingleSuccessor(graph).valid);
  ok(validateReadingOrderSinglePredecessor(graph).valid);
  ok(validateReadingOrderNoDuplicateEdges(graph).valid);
  ok(validateReadingOrderTopology(graph).valid);
});

// ─── 2. Connectivity ─────────────────────────────────────────────────────────

test("connectivity rejects disconnected word chains", () => {
  // word-c has no incoming READING_PREVIOUS and no outgoing READING_NEXT, so
  // the WORD level has three firsts, two lasts and an unreachable node.
  const graph = wordGraph([next("word-a", "word-b"), prev("word-b", "word-a")]);
  const result = validateReadingOrderConnectivity(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("first")));
  ok(result.errors.some((e) => e.includes("last")));
  ok(result.errors.some((e) => e.includes("unreachable")));
});

// ─── 3. Coverage ─────────────────────────────────────────────────────────────

test("coverage rejects graphs that miss or invent hierarchy nodes", () => {
  const { hierarchy, graph } = realGraph();
  const removed = graph.nodesAtLevel(NODE_LEVEL.WORD)[0];
  const missing = new ReadingOrderGraph(
    graph.nodes().filter((n) => n.id !== removed.id),
    graph.edges().filter((e) => e.from !== removed.id && e.to !== removed.id)
  );
  const missingResult = validateReadingOrderCoverage(hierarchy, missing);
  ok(!missingResult.valid);
  ok(missingResult.errors.some((e) => e.includes("does not cover")));

  const extra = new ReadingOrderGraph(
    [...graph.nodes(), node("ghost", NODE_LEVEL.WORD, graph.nodeCount)],
    graph.edges()
  );
  const extraResult = validateReadingOrderCoverage(hierarchy, extra);
  ok(!extraResult.valid);
  ok(extraResult.errors.some((e) => e.includes("unknown hierarchy node")));
});

test("coverage rejects level mismatches against the hierarchy", () => {
  const { hierarchy, graph } = realGraph();
  const firstWord = graph.nodesAtLevel(NODE_LEVEL.WORD)[0];
  const relabeled = new ReadingOrderGraph(
    graph.nodes().map((n) =>
      n.id === firstWord.id ? { ...n, level: NODE_LEVEL.BLOCK } : n
    ),
    graph.edges()
  );
  const result = validateReadingOrderCoverage(hierarchy, relabeled);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("level")));
});

// ─── 4. Determinism ──────────────────────────────────────────────────────────

test("determinism rejects a graph rebuilt with reordered edges", () => {
  const { graph } = realGraph();
  const reordered = new ReadingOrderGraph(
    [...graph.nodes()],
    [...graph.edges()].reverse()
  );
  const result = validateReadingOrderDeterminism(graph, reordered);
  ok(!result.valid);
});

// ─── 5. Frozen ───────────────────────────────────────────────────────────────

test("frozen rejects an instance that was never deep-frozen", () => {
  const { graph } = realGraph();
  const unfrozen = Object.create(ReadingOrderGraph.prototype);
  Object.defineProperty(unfrozen, "nodeOrder", {
    value: [...graph.nodes()],
    enumerable: true,
  });
  Object.defineProperty(unfrozen, "edgeOrder", {
    value: [...graph.edges()],
    enumerable: true,
  });
  const result = validateReadingOrderFrozen(unfrozen as ReadingOrderGraph);
  ok(!result.valid);
});

// ─── 6. Acyclicity ───────────────────────────────────────────────────────────

test("acyclic rejects a READING_NEXT cycle", () => {
  const graph = wordGraph([
    next("word-a", "word-b"),
    next("word-b", "word-a"),
  ]);
  const result = validateReadingOrderAcyclic(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("cycle")));
});

// ─── 7. Bidirectionality ─────────────────────────────────────────────────────

test("bidirectional rejects a READING_NEXT edge without its mirror", () => {
  const graph = wordGraph([next("word-a", "word-b")]);
  const result = validateReadingOrderBidirectional(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("no READING_PREVIOUS mirror")));
});

test("bidirectional rejects a READING_PREVIOUS edge without its mirror", () => {
  const graph = wordGraph([prev("word-b", "word-a")]);
  const result = validateReadingOrderBidirectional(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("no READING_NEXT mirror")));
});

// ─── 8. Single successor / predecessor ───────────────────────────────────────

test("single successor rejects a node with two READING_NEXT targets", () => {
  const graph = wordGraph([
    next("word-a", "word-b"),
    next("word-a", "word-c"),
  ]);
  const result = validateReadingOrderSingleSuccessor(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("2 READING_NEXT successors")));
});

test("single predecessor rejects a node with two READING_PREVIOUS targets", () => {
  // A node's previous is where its READING_PREVIOUS edge points, so word-a
  // having two of them means it has two predecessors.
  const graph = wordGraph([
    prev("word-a", "word-b"),
    prev("word-a", "word-c"),
  ]);
  const result = validateReadingOrderSinglePredecessor(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("2 READING_PREVIOUS predecessors")));
});

// ─── 9. Duplicate edges ──────────────────────────────────────────────────────

test("no duplicate edges rejects repeated (type, from, to) triples", () => {
  const graph = wordGraph([
    next("word-a", "word-b"),
    next("word-a", "word-b"),
  ]);
  const result = validateReadingOrderNoDuplicateEdges(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("duplicate edge")));
});

// ─── 10. Topology ────────────────────────────────────────────────────────────

test("topology rejects a READING_NEXT edge running backward in the sequence", () => {
  const graph = wordGraph([next("word-b", "word-a")]);
  const result = validateReadingOrderTopology(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("violates the reading sequence")));
});

test("topology rejects a READING_PREVIOUS edge running forward in the sequence", () => {
  const graph = wordGraph([prev("word-a", "word-b")]);
  const result = validateReadingOrderTopology(graph);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("violates the reading sequence")));
});
