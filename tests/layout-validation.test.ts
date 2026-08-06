/**
 * Graph validation primitive tests — structured results, deterministic errors,
 * frozen outputs, and compatibility with both the raw edge model and the
 * semantic graph.
 */
import {
  LayoutGraph,
  LAYOUT_EDGE_TYPE,
  NODE_LEVEL,
  SemanticGraph,
  validateFrozenGraph,
  validateKnownEdgeTypes,
  validateNoSelfLoops,
  validateUniqueNodeIds,
} from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

function semanticGraph(): SemanticGraph {
  return new SemanticGraph()
    .addNode("a", { level: NODE_LEVEL.WORD })
    .addNode("b", { level: NODE_LEVEL.WORD })
    .addEdge(LAYOUT_EDGE_TYPE.READING_NEXT, "a", "b");
}

// ─── validateNoSelfLoops ────────────────────────────────────────────────────

test("validateNoSelfLoops accepts clean edges", () => {
  const result = validateNoSelfLoops([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
  ok(result.valid);
  equal(result.errors, []);
});

test("validateNoSelfLoops reports every self-loop", () => {
  const result = validateNoSelfLoops([
    { from: "a", to: "b" },
    { from: "a", to: "a" },
    { from: "b", to: "b" },
  ]);
  ok(!result.valid);
  equal(result.errors, [
    "self-loop edge on node a",
    "self-loop edge on node b",
  ]);
});

test("validateNoSelfLoops accepts an empty collection", () => {
  ok(validateNoSelfLoops([]).valid);
});

test("validateNoSelfLoops works on Milestone 1 LayoutGraph edges", () => {
  const g = new LayoutGraph().addEdge("a", "b").addEdge("b", "c");
  ok(validateNoSelfLoops(g.edges()).valid);
});

// ─── validateUniqueNodeIds ──────────────────────────────────────────────────

test("validateUniqueNodeIds accepts unique ids", () => {
  const result = validateUniqueNodeIds(["a", "b", "c"]);
  ok(result.valid);
  equal(result.errors, []);
});

test("validateUniqueNodeIds reports duplicates", () => {
  const result = validateUniqueNodeIds(["a", "b", "a", "c", "b"]);
  ok(!result.valid);
  equal(result.errors, ["duplicate node id a", "duplicate node id b"]);
});

test("validateUniqueNodeIds accepts an empty collection", () => {
  ok(validateUniqueNodeIds([]).valid);
});

// ─── validateKnownEdgeTypes ─────────────────────────────────────────────────

test("validateKnownEdgeTypes accepts vocabulary edges", () => {
  const result = validateKnownEdgeTypes([
    { type: "CONTAINS" },
    { type: "READING_PREVIOUS" },
  ]);
  ok(result.valid);
  equal(result.errors, []);
});

test("validateKnownEdgeTypes reports unknown and non-string types", () => {
  const result = validateKnownEdgeTypes([
    { type: "CONTAINS" },
    { type: "NOPE" },
    { type: 42 },
  ]);
  ok(!result.valid);
  equal(result.errors, [
    "unknown edge type \"NOPE\"",
    "unknown edge type 42",
  ]);
});

test("validateKnownEdgeTypes accepts an empty collection", () => {
  ok(validateKnownEdgeTypes([]).valid);
});

test("validateKnownEdgeTypes works on typed semantic edges", () => {
  const g = semanticGraph();
  ok(validateKnownEdgeTypes(g.edges()).valid);
});

// ─── validateFrozenGraph ────────────────────────────────────────────────────

test("validateFrozenGraph accepts a frozen graph", () => {
  const result = validateFrozenGraph(semanticGraph().freeze());
  ok(result.valid);
  equal(result.errors, []);
});

test("validateFrozenGraph rejects an unfrozen graph", () => {
  const result = validateFrozenGraph(semanticGraph());
  ok(!result.valid);
  ok(result.errors.includes("semantic graph is not frozen"));
  ok(result.errors.includes("semantic graph instance is not frozen"));
});

test("validation results are frozen and deterministic", () => {
  const result = validateNoSelfLoops([{ from: "a", to: "a" }]);
  ok(Object.isFrozen(result), "result is frozen");
  ok(Object.isFrozen(result.errors), "error list is frozen");
  equal(
    validateNoSelfLoops([{ from: "a", to: "a" }]),
    validateNoSelfLoops([{ from: "a", to: "a" }]),
    "same input yields identical output"
  );
});
