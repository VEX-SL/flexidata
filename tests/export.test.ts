import type { ExtractionResult, FieldValue } from "@/lib/pipeline/types";
import { exportExtraction } from "@/lib/pipeline/exporter";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import * as mammoth from "mammoth";
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

test("JSON export of a receipt carries document_type and grounded fields", async () => {
  const res = await exportExtraction(extraction, { format: "json" });
  equal(res.format, "json");
  const content = res.content ?? "";
  includes(content, '"document_type": "receipt"');
  includes(content, "2013438351");
  includes(content, "68.38");
  ok(!content.includes("key_numbers"), "no fallback placeholders in export");
});

test("JSON export carries the verbatim OCR text and no provider/model metadata", async () => {
  const res = await exportExtraction(
    extraction,
    { format: "json" },
    { ocrText: "سطر واحد\nسطر ثاني\nTOTAL 68.38" }
  );
  const content = res.content ?? "";
  includes(content, '"ocr": "سطر واحد\\nسطر ثاني\\nTOTAL 68.38"');
  includes(content, "سطر واحد");
  ok(!content.includes('"provider"'), "provider metadata never exported");
  ok(!content.includes('"model"'), "model metadata never exported");
});

test("CSV export of a receipt uses receipt csv columns", async () => {
  const res = await exportExtraction(extraction, { format: "csv" });
  equal(res.format, "csv");
  const content = res.content ?? "";
  includes(content, "receipt_number");
  includes(content, "merchant_name");
  includes(content, "total_amount");
  includes(content, "SuperPay");
});

test("Word export produces a .docx with the OCR text verbatim", async () => {
  const ocrText =
    "بسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ\nالْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ";
  const res = await exportExtraction(
    extraction,
    { format: "word" },
    { ocrText }
  );
  equal(res.format, "word");
  ok(res.buffer instanceof Uint8Array, "word export ships binary docx bytes");
  ok(res.buffer!.length > 0, "docx buffer is not empty");
  includes(res.mimeType, "wordprocessingml");
  ok(res.fileName.endsWith(".docx"), "file name ends with .docx");

  const bytes = res.buffer!;
  ok(
    bytes[0] === 0x50 && bytes[1] === 0x4b,
    "docx buffer starts with a zip magic (PK)"
  );

  // End-to-end: mammoth decodes the docx back to plain text and the OCR lines
  // appear exactly as read — nothing normalized, reordered or rewritten.
  const decoded = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  includes(decoded.value, "بسْمِ", "first OCR line verbatim in the word doc");
  includes(decoded.value, "الْحَمْدُ لِلَّهِ", "second OCR line verbatim in the word doc");
  includes(decoded.value, "SuperPay", "extracted fields are included");
});
