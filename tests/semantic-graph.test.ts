/**
 * Semantic graph tests — typed node/edge construction with strict rejection,
 * per-type traversal, level queries, freezing and deterministic, frozen views.
 */
import {
  LAYOUT_EDGE_TYPE,
  NODE_LEVEL,
  REGION_TYPE,
  SemanticGraph,
} from "@/lib/layout";
import type { LayoutEdgeType } from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

function sampleGraph(): SemanticGraph {
  return new SemanticGraph()
    .addNode("page0", { level: NODE_LEVEL.PAGE })
    .addNode("header", { level: NODE_LEVEL.REGION, regionType: REGION_TYPE.HEADER })
    .addNode("body", { level: NODE_LEVEL.REGION })
    .addNode("block1", { level: NODE_LEVEL.BLOCK })
    .addNode("line1", { level: NODE_LEVEL.LINE })
    .addNode("w1", { level: NODE_LEVEL.WORD })
    .addNode("w2", { level: NODE_LEVEL.WORD })
    .addEdge(LAYOUT_EDGE_TYPE.CONTAINS, "page0", "header")
    .addEdge(LAYOUT_EDGE_TYPE.CONTAINS, "page0", "body")
    .addEdge(LAYOUT_EDGE_TYPE.CHILD_OF, "header", "block1")
    .addEdge(LAYOUT_EDGE_TYPE.CHILD_OF, "block1", "line1")
    .addEdge(LAYOUT_EDGE_TYPE.CHILD_OF, "line1", "w1")
    .addEdge(LAYOUT_EDGE_TYPE.CHILD_OF, "line1", "w2")
    .addEdge(LAYOUT_EDGE_TYPE.READING_NEXT, "w1", "w2")
    .addEdge(LAYOUT_EDGE_TYPE.READING_PREVIOUS, "w2", "w1")
    .addEdge(LAYOUT_EDGE_TYPE.ALIGNED_HORIZONTAL, "w1", "w2")
    .addEdge(LAYOUT_EDGE_TYPE.ADJACENT, "w1", "w2");
}

// ─── Node construction ──────────────────────────────────────────────────────

test("addNode registers ids with levels and defaults region type", () => {
  const g = sampleGraph();
  equal(g.nodeCount, 7);
  equal(g.nodes(), ["page0", "header", "body", "block1", "line1", "w1", "w2"]);
  equal(g.nodeLevel("w1"), NODE_LEVEL.WORD);
  equal(g.regionType("header"), REGION_TYPE.HEADER);
  equal(g.regionType("body"), REGION_TYPE.UNKNOWN, "region defaults to Unknown");
  equal(g.regionType("w1"), undefined, "non-regions carry no region type");
});

test("addNode rejects empty ids", () => {
  let threw = false;
  try {
    new SemanticGraph().addNode("", { level: NODE_LEVEL.PAGE });
  } catch (e) {
    threw = e instanceof Error && /empty/.test(e.message);
  }
  ok(threw, "empty id throws");
});

test("addNode rejects duplicate ids", () => {
  let threw = false;
  try {
    new SemanticGraph()
      .addNode("a", { level: NODE_LEVEL.WORD })
      .addNode("a", { level: NODE_LEVEL.WORD });
  } catch (e) {
    threw = e instanceof Error && /duplicate/.test(e.message);
  }
  ok(threw, "duplicate node throws");
});

test("addNode rejects region types on non-region nodes", () => {
  let threw = false;
  try {
    new SemanticGraph().addNode("w", {
      level: NODE_LEVEL.WORD,
      regionType: REGION_TYPE.BODY,
    });
  } catch (e) {
    threw = e instanceof Error && /REGION/.test(e.message);
  }
  ok(threw, "misplaced region type throws");
});

// ─── Edge construction ──────────────────────────────────────────────────────

test("addEdge requires registered endpoints", () => {
  const g = new SemanticGraph().addNode("a", { level: NODE_LEVEL.WORD });
  let threw = false;
  try {
    g.addEdge(LAYOUT_EDGE_TYPE.CONTAINS, "a", "missing");
  } catch (e) {
    threw = e instanceof Error && /target/.test(e.message);
  }
  ok(threw, "unknown target throws");

  threw = false;
  try {
    g.addEdge(LAYOUT_EDGE_TYPE.CONTAINS, "missing", "a");
  } catch (e) {
    threw = e instanceof Error && /source/.test(e.message);
  }
  ok(threw, "unknown source throws");
});

test("addEdge rejects self-loops", () => {
  let threw = false;
  try {
    new SemanticGraph()
      .addNode("a", { level: NODE_LEVEL.WORD })
      .addEdge(LAYOUT_EDGE_TYPE.CONTAINS, "a", "a");
  } catch (e) {
    threw = e instanceof Error && /self-loop/.test(e.message);
  }
  ok(threw, "self-loop throws");
});

test("addEdge rejects unknown edge types", () => {
  let threw = false;
  try {
    new SemanticGraph()
      .addNode("a", { level: NODE_LEVEL.WORD })
      .addNode("b", { level: NODE_LEVEL.WORD })
      .addEdge("WRONG" as LayoutEdgeType, "a", "b");
  } catch (e) {
    threw = e instanceof Error && /unknown edge type/.test(e.message);
  }
  ok(threw, "unknown type throws");
});

test("addEdge rejects exact duplicate edges but keeps distinct ones", () => {
  const g = new SemanticGraph()
    .addNode("a", { level: NODE_LEVEL.WORD })
    .addNode("b", { level: NODE_LEVEL.WORD });

  let threw = false;
  try {
    g.addEdge(LAYOUT_EDGE_TYPE.ALIGNED_HORIZONTAL, "a", "b").addEdge(
      LAYOUT_EDGE_TYPE.ALIGNED_HORIZONTAL,
      "a",
      "b"
    );
  } catch (e) {
    threw = e instanceof Error && /duplicate edge/.test(e.message);
  }
  ok(threw, "duplicate triple throws");

  const g2 = new SemanticGraph()
    .addNode("a", { level: NODE_LEVEL.WORD })
    .addNode("b", { level: NODE_LEVEL.WORD })
    .addEdge(LAYOUT_EDGE_TYPE.ALIGNED_HORIZONTAL, "a", "b")
    .addEdge(LAYOUT_EDGE_TYPE.ALIGNED_VERTICAL, "a", "b")
    .addEdge(LAYOUT_EDGE_TYPE.ALIGNED_HORIZONTAL, "b", "a");
  equal(g2.edgeCount, 3, "same pair under different types/directions is distinct");
});

test("edges are first-class frozen objects in insertion order", () => {
  const g = sampleGraph();
  equal(g.edgeCount, 10);
  ok(Object.isFrozen(g.edges()), "edges view is frozen");
  for (const edge of g.edges()) {
    ok(Object.isFrozen(edge), "each edge object is frozen");
  }
  equal(g.edges()[0], {
    type: "CONTAINS",
    from: "page0",
    to: "header",
  });
  equal(g.hasEdge(LAYOUT_EDGE_TYPE.CONTAINS, "page0", "header"), true);
  equal(g.hasEdge(LAYOUT_EDGE_TYPE.CONTAINS, "header", "page0"), false);
});

test("edgesOfType returns per-type collections", () => {
  const g = sampleGraph();
  const contains = g.edgesOfType(LAYOUT_EDGE_TYPE.CONTAINS);
  equal(contains.length, 2);
  ok(Object.isFrozen(contains), "per-type view is frozen");
  for (const edge of contains) {
    equal(edge.type, LAYOUT_EDGE_TYPE.CONTAINS);
  }
  equal(g.edgesOfType(LAYOUT_EDGE_TYPE.ADJACENT).length, 1);
  equal(g.edgesOfType(LAYOUT_EDGE_TYPE.ALIGNED_VERTICAL).length, 0);
});

// ─── Traversal ──────────────────────────────────────────────────────────────

test("children and parent follow CHILD_OF edges", () => {
  const g = sampleGraph();
  equal(g.children("header"), ["block1"]);
  equal(g.children("block1"), ["line1"]);
  equal(g.children("line1"), ["w1", "w2"]);
  equal(g.children("w1"), []);
  equal(g.parent("line1"), ["block1"]);
  equal(g.parent("header"), []);
});

test("readingNext and readingPrevious follow their edge types", () => {
  const g = sampleGraph();
  equal(g.readingNext("w1"), ["w2"]);
  equal(g.readingPrevious("w2"), ["w1"]);
  equal(g.readingNext("w2"), []);
  equal(g.readingPrevious("w1"), []);
});

test("outgoing and incoming filter by edge type", () => {
  const g = sampleGraph();
  equal(g.outgoing("w1", LAYOUT_EDGE_TYPE.ALIGNED_HORIZONTAL), ["w2"]);
  equal(g.outgoing("w1", LAYOUT_EDGE_TYPE.ADJACENT), ["w2"]);
  equal(g.outgoing("w1", LAYOUT_EDGE_TYPE.READING_NEXT), ["w2"]);
  equal(g.outgoing("w1", LAYOUT_EDGE_TYPE.READING_PREVIOUS), []);
  equal(g.incoming("w2", LAYOUT_EDGE_TYPE.READING_NEXT), ["w1"]);
  equal(g.incoming("w1", LAYOUT_EDGE_TYPE.READING_NEXT), []);
});

test("neighbors deduplicates across edge types in first-encounter order", () => {
  const g = sampleGraph();
  equal(g.neighbors("w1"), ["line1", "w2"], "structural parent first, w2 collapses");
  equal(g.neighbors("w2"), ["line1", "w1"]);
  equal(g.neighbors("line1"), ["block1", "w1", "w2"]);
  equal(g.neighbors("header"), ["page0", "block1"]);
  equal(g.neighbors("nobody"), []);
});

test("unknown ids answer queries with empty frozen views", () => {
  const g = new SemanticGraph();
  equal(g.children("nope"), []);
  equal(g.neighbors("nope"), []);
  ok(Object.isFrozen(g.children("nope")));
});

// ─── Level queries ──────────────────────────────────────────────────────────

test("pages, regions, blocks, lines and words filter by level", () => {
  const g = sampleGraph();
  equal(g.pages(), ["page0"]);
  equal(g.regions(), ["header", "body"]);
  equal(g.blocks(), ["block1"]);
  equal(g.lines(), ["line1"]);
  equal(g.words(), ["w1", "w2"]);
  ok(Object.isFrozen(g.regions()), "level view is frozen");
});

test("level queries ignore non-matching levels", () => {
  const g = new SemanticGraph()
    .addNode("r", { level: NODE_LEVEL.REGION })
    .addNode("w", { level: NODE_LEVEL.WORD });
  equal(g.pages(), []);
  equal(g.regions(), ["r"]);
  equal(g.lines(), []);
  equal(g.words(), ["w"]);
});

// ─── Freezing and immutability ──────────────────────────────────────────────

test("freeze() makes the graph immutable", () => {
  const g = new SemanticGraph()
    .addNode("a", { level: NODE_LEVEL.WORD })
    .addNode("b", { level: NODE_LEVEL.WORD })
    .addEdge(LAYOUT_EDGE_TYPE.READING_NEXT, "a", "b")
    .freeze();

  ok(g.isFrozen, "isFrozen reflects the terminal state");
  ok(Object.isFrozen(g), "instance is non-extensible");

  let threw = false;
  try {
    g.addNode("c", { level: NODE_LEVEL.WORD });
  } catch (e) {
    threw = e instanceof Error && /frozen/.test(e.message);
  }
  ok(threw, "node mutation after freeze throws");

  threw = false;
  try {
    g.addEdge(LAYOUT_EDGE_TYPE.READING_NEXT, "b", "a");
  } catch (e) {
    threw = e instanceof Error && /frozen/.test(e.message);
  }
  ok(threw, "edge mutation after freeze throws");
});

test("query views are frozen copies even before freeze", () => {
  const g = new SemanticGraph()
    .addNode("a", { level: NODE_LEVEL.WORD })
    .addNode("b", { level: NODE_LEVEL.WORD })
    .addEdge(LAYOUT_EDGE_TYPE.READING_NEXT, "a", "b");
  ok(Object.isFrozen(g.nodes()));
  ok(Object.isFrozen(g.edges()));
  ok(Object.isFrozen(g.children("a")));
  ok(Object.isFrozen(g.words()));
});

test("same construction yields identical graphs (determinism)", () => {
  equal(sampleGraph().nodes(), sampleGraph().nodes());
  equal(sampleGraph().edges(), sampleGraph().edges());
  equal(sampleGraph().neighbors("w1"), sampleGraph().neighbors("w1"));
  equal(sampleGraph().regions(), sampleGraph().regions());
});
