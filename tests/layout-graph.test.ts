/**
 * Layout graph data-structure tests — node/edge bookkeeping, adjacency and
 * immutable query views. No reading-order or validation algorithms live here
 * yet; the class is exercised purely as a structure.
 */
import { LayoutGraph } from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

test("addNode registers ids in insertion order", () => {
  const g = new LayoutGraph().addNode("a").addNode("b").addNode("a");
  equal(g.nodeCount, 2, "duplicate add is idempotent");
  equal(g.nodes(), ["a", "b"]);
  ok(g.hasNode("a"));
  ok(!g.hasNode("z"));
});

test("addNode rejects empty ids", () => {
  let threw = false;
  try {
    new LayoutGraph().addNode("");
  } catch (e) {
    threw = e instanceof Error && /empty/.test(e.message);
  }
  ok(threw, "empty id throws");
});

test("addEdge auto-registers endpoint nodes", () => {
  const g = new LayoutGraph().addEdge("a", "b");
  ok(g.hasNode("a"));
  ok(g.hasNode("b"));
  equal(g.nodeCount, 2);
  equal(g.edgeCount, 1);
});

test("successors and predecessors mirror the edges", () => {
  const g = new LayoutGraph().addEdge("a", "b").addEdge("a", "c").addEdge("c", "d");
  equal(g.successors("a"), ["b", "c"]);
  equal(g.successors("c"), ["d"]);
  equal(g.successors("d"), []);
  equal(g.predecessors("d"), ["c"]);
  equal(g.predecessors("b"), ["a"]);
  equal(g.predecessors("a"), []);
  ok(g.hasEdge("a", "c"));
  ok(!g.hasEdge("c", "a"));
});

test("edges preserve insertion order", () => {
  const g = new LayoutGraph().addEdge("x", "y").addEdge("y", "z").addEdge("x", "z");
  equal(g.edges(), [
    { from: "x", to: "y" },
    { from: "y", to: "z" },
    { from: "x", to: "z" },
  ]);
  equal(g.edgeCount, 3);
});

test("multiple edges between the same pair are preserved", () => {
  const g = new LayoutGraph().addEdge("a", "b").addEdge("a", "b");
  equal(g.edgeCount, 2);
  equal(g.successors("a"), ["b", "b"]);
});

test("self-loop edges are rejected", () => {
  let threw = false;
  try {
    new LayoutGraph().addEdge("a", "a");
  } catch (e) {
    threw = e instanceof Error && /self-loop/.test(e.message);
  }
  ok(threw, "self-loop throws");
});

test("isolated nodes have no neighbors", () => {
  const g = new LayoutGraph().addNode("solo");
  equal(g.successors("solo"), []);
  equal(g.predecessors("solo"), []);
  equal(g.edgeCount, 0);
});

test("query views are frozen copies", () => {
  const g = new LayoutGraph().addEdge("a", "b");
  const succ = g.successors("a");
  ok(Object.isFrozen(succ), "successor view is frozen");
  equal(g.successors("a"), ["b"], "fresh queries are unaffected");

  const nodes = g.nodes();
  ok(Object.isFrozen(nodes), "node view is frozen");
  const edges = g.edges();
  ok(Object.isFrozen(edges), "edge view is frozen");
});

test("chains are plain data — no order or cycle semantics yet", () => {
  const g = new LayoutGraph().addEdge("a", "b").addEdge("b", "c");
  equal(g.nodes(), ["a", "b", "c"]);
  equal(g.nodeCount, 3);
  equal(g.edgeCount, 2);
});
