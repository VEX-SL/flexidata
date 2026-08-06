/**
 * Node hierarchy level tests — exact tokens, coarse-to-fine order and the
 * runtime guard for untyped sources.
 */
import { isNodeLevel, NODE_LEVEL, NODE_LEVELS } from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

test("node levels match the architecture exactly", () => {
  equal(NODE_LEVEL, {
    PAGE: "Page",
    REGION: "Region",
    BLOCK: "Block",
    LINE: "Line",
    WORD: "Word",
  });
});

test("node levels iterate coarsest to finest", () => {
  equal(NODE_LEVELS, ["Page", "Region", "Block", "Line", "Word"]);
});

test("every vocabulary member is recognized", () => {
  for (const level of NODE_LEVELS) {
    ok(isNodeLevel(level), `recognizes ${level}`);
  }
});

test("untyped sources are rejected", () => {
  ok(!isNodeLevel("Line2"), "unknown string rejected");
  ok(!isNodeLevel("line"), "wrong case rejected");
  ok(!isNodeLevel(42), "non-string rejected");
  ok(!isNodeLevel(undefined), "undefined rejected");
});
