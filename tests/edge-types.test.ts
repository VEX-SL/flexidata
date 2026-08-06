/**
 * Edge vocabulary tests — exact tokens, deterministic order and the runtime
 * guard for untyped sources.
 */
import {
  isLayoutEdgeType,
  LAYOUT_EDGE_TYPE,
  LAYOUT_EDGE_TYPES,
} from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

test("edge vocabulary matches the architecture exactly", () => {
  equal(LAYOUT_EDGE_TYPE, {
    CONTAINS: "CONTAINS",
    CHILD_OF: "CHILD_OF",
    ADJACENT: "ADJACENT",
    ALIGNED_HORIZONTAL: "ALIGNED_HORIZONTAL",
    ALIGNED_VERTICAL: "ALIGNED_VERTICAL",
    READING_NEXT: "READING_NEXT",
    READING_PREVIOUS: "READING_PREVIOUS",
  });
});

test("edge types iterate in vocabulary order", () => {
  equal(LAYOUT_EDGE_TYPES, [
    "CONTAINS",
    "CHILD_OF",
    "ADJACENT",
    "ALIGNED_HORIZONTAL",
    "ALIGNED_VERTICAL",
    "READING_NEXT",
    "READING_PREVIOUS",
  ]);
});

test("every vocabulary member is recognized", () => {
  for (const type of LAYOUT_EDGE_TYPES) {
    ok(isLayoutEdgeType(type), `recognizes ${type}`);
  }
});

test("untyped sources are rejected", () => {
  ok(!isLayoutEdgeType("FOO"), "unknown string rejected");
  ok(!isLayoutEdgeType(""), "empty string rejected");
  ok(!isLayoutEdgeType(42), "non-string rejected");
  ok(!isLayoutEdgeType(undefined), "undefined rejected");
  ok(!isLayoutEdgeType(null), "null rejected");
});
