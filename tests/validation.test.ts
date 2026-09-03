import type { ExtractionResult, FieldValue } from "@/lib/pipeline/types";
import { validateExtraction } from "@/lib/pipeline/validator";
import { test, ok, equal } from "./harness.ts";

function fv(value: unknown, confidence = 0.9): FieldValue {
  return { value, confidence, source: "ai", status: "extracted" };
}

const grounded: ExtractionResult = {
  profileType: "receipt",
  profileVersion: 1,
  fields: [],
  fieldsMap: {
    receipt_number: fv("2013438351"),
    receipt_date: fv("2026-07-02"),
    merchant_name: fv("SuperPay"),
    customer_name: fv("Zahra Aman"),
    total_amount: fv(68.38),
  },
  cleanFields: {},
  droppedFields: {},
};

const emptyInvoice: ExtractionResult = {
  profileType: "invoice",
  profileVersion: 1,
  fields: [],
  fieldsMap: {},
  cleanFields: {},
  droppedFields: {},
};

test("grounded receipt extraction validates against the receipt profile", () => {
  const result = validateExtraction(grounded);
  ok(result.ok, `receipt extraction must validate: ${JSON.stringify(result.missing)}`);
  equal(result.missing.length, 0);
});

test("receipt validation is lenient: missing receipt fields are never flagged", () => {
  const result = validateExtraction({
    ...grounded,
    fieldsMap: { merchant_name: fv("SuperPay") },
  });
  equal(result.ok, true, "receipt slips must not hard-fail on missing optional fields");
  equal(result.missing.length, 0, "missing receipt_number/date/total must not be flagged");
});

test("a receipt wrongly extracted as an invoice fails invoice validation", () => {
  const result = validateExtraction(emptyInvoice);
  equal(result.ok, false);
  equal(result.missing, ["invoice_number", "invoice_date", "seller_name", "buyer_name", "total_amount"]);
});
