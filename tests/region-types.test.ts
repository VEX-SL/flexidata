/**
 * Region role vocabulary tests — exact tokens, deterministic order and the
 * runtime guard for untyped sources.
 */
import { isRegionType, REGION_TYPE, REGION_TYPES } from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

test("region vocabulary matches the architecture exactly", () => {
  equal(REGION_TYPE, {
    UNKNOWN: "Unknown",
    HEADER: "Header",
    BODY: "Body",
    FOOTER: "Footer",
    SIDEBAR: "Sidebar",
    TABLE: "Table",
    FORM_FIELD: "FormField",
    STAMP: "Stamp",
    ANNOTATION: "Annotation",
    SIGNATURE_ZONE: "SignatureZone",
  });
});

test("region types iterate in vocabulary order", () => {
  equal(REGION_TYPES, [
    "Unknown",
    "Header",
    "Body",
    "Footer",
    "Sidebar",
    "Table",
    "FormField",
    "Stamp",
    "Annotation",
    "SignatureZone",
  ]);
});

test("every vocabulary member is recognized", () => {
  for (const type of REGION_TYPES) {
    ok(isRegionType(type), `recognizes ${type}`);
  }
});

test("untyped sources are rejected", () => {
  ok(!isRegionType("Unknownish"), "unknown string rejected");
  ok(!isRegionType("unknown"), "wrong case rejected");
  ok(!isRegionType(42), "non-string rejected");
  ok(!isRegionType(undefined), "undefined rejected");
});
