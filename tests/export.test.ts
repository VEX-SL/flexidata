import type { ExtractionResult, FieldValue } from "@/lib/pipeline/types";
import { exportExtraction } from "@/lib/pipeline/exporter";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { test, ok, includes, equal } from "./harness.ts";

function fv(value: unknown, confidence = 0.9): FieldValue {
  return { value, confidence, source: "ai", status: "extracted" };
}

const fieldsMap: Record<string, FieldValue> = {
  receipt_number: fv("2013438351"),
  receipt_date: fv("2026-07-02"),
  merchant_name: fv("SuperPay"),
  customer_name: fv("Zahra Aman"),
  total_amount: fv(68.38),
};

const profile = getProfileManager().get("receipt")!;
const fields = profile.schema.fields
  .filter((f) => fieldsMap[f.key])
  .map((field) => ({ field, value: fieldsMap[field.key] }));

const extraction: ExtractionResult = {
  profileType: "receipt",
  profileVersion: 1,
  fields,
  fieldsMap,
  cleanFields: Object.fromEntries(
    Object.entries(fieldsMap).map(([k, v]) => [k, v.value])
  ),
  droppedFields: {},
};

test("JSON export of a receipt carries document_type and grounded fields", () => {
  const res = exportExtraction(extraction, { format: "json" });
  equal(res.format, "json");
  const content = res.content ?? "";
  includes(content, '"document_type": "receipt"');
  includes(content, "2013438351");
  includes(content, "68.38");
  ok(!content.includes("key_numbers"), "no fallback placeholders in export");
});

test("CSV export of a receipt uses receipt csv columns", () => {
  const res = exportExtraction(extraction, { format: "csv" });
  equal(res.format, "csv");
  const content = res.content ?? "";
  includes(content, "receipt_number");
  includes(content, "merchant_name");
  includes(content, "total_amount");
  includes(content, "SuperPay");
});
