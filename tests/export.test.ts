import type { ExtractionResult, FieldValue } from "@/lib/pipeline/types";
import { exportExtraction } from "@/lib/pipeline/exporter";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import * as mammoth from "mammoth";
import * as XLSX from "xlsx";
import { PDFDocument } from "pdf-lib";
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

test("XLSX export produces a real workbook with flat record, field detail and OCR sheets", async () => {
  const res = await exportExtraction(
    extraction,
    { format: "xlsx" },
    { ocrText: "فاتورة ضريبية\nTOTAL 68.38" }
  );

  equal(res.format, "xlsx");
  ok(res.buffer instanceof Uint8Array, "xlsx export ships binary bytes");
  ok(res.buffer!.length > 0, "xlsx buffer is not empty");
  includes(res.mimeType, "spreadsheetml");
  ok(res.fileName.endsWith(".xlsx"), "file name ends with .xlsx");
  ok(
    res.buffer![0] === 0x50 && res.buffer![1] === 0x4b,
    "xlsx buffer starts with a zip magic (PK)"
  );

  const workbook = XLSX.read(Buffer.from(res.buffer!), { type: "buffer" });
  ok(workbook.SheetNames.includes("Extraction"), "flat record sheet present");
  ok(workbook.SheetNames.includes("Fields"), "field detail sheet present");
  ok(workbook.SheetNames.includes("OCR"), "OCR sheet present when text exists");

  // Sheet 1 must stay in lock-step with the CSV columns/values.
  const flat = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.Extraction, {
    header: 1,
  });
  const header = (flat[0] ?? []).map(String);
  const values = flat[1] ?? [];
  includes(header.join("|"), "receipt_number");
  includes(values.map(String).join("|"), "SuperPay");

  const amountIndex = header.indexOf("total_amount");
  ok(amountIndex >= 0, "total_amount column present");
  ok(
    typeof values[amountIndex] === "number",
    "amounts stay numbers so Excel can sum them"
  );

  // Sheet 2 is the readable report: one row per non-empty field.
  const detail = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets.Fields
  );
  equal(detail.length, extraction.fields.length, "one row per non-empty field");
  const receiptRow = detail.find(
    (row) => String(row["الحقل"]) === "receipt_number"
  );
  ok(receiptRow, "detail sheet carries a receipt_number row");
  equal(receiptRow!["القيمة"], "2013438351");
  equal(receiptRow!["الثقة (٪)"], 90, "confidence rounded to a percent number");

  const ocr = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.OCR, {
    header: 1,
  });
  includes(ocr.flat().map(String).join("\n"), "فاتورة ضريبية");
});

test("PDF export produces a real PDF with the Arabic font embedded", async () => {
  const res = await exportExtraction(
    extraction,
    { format: "pdf" },
    {
      ocrText: "إجمالي المبلغ 68.38 ر.س\nReceipt SuperPay",
      confidence: 0.92,
    }
  );

  equal(res.format, "pdf");
  ok(res.buffer instanceof Uint8Array, "pdf export ships binary bytes");
  includes(res.mimeType, "application/pdf");
  ok(res.fileName.endsWith(".pdf"), "file name ends with .pdf");

  const bytes = res.buffer!;
  ok(bytes.length > 3000, "pdf carries an embedded font, not a shell");
  ok(
    bytes[0] === 0x25 &&
      bytes[1] === 0x44 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x2d,
    "pdf buffer starts with %PDF"
  );

  const text = new TextDecoder("latin1").decode(bytes);
  ok(text.includes("/Type0"), "composite (Type0) font — required for Arabic");
  ok(text.includes("/FontFile2"), "TrueType font file attached to the page");
  ok(text.includes("Amiri"), "the bundled Arabic font is the one embedded");

  // A real parser must accept the bytes back: this catches broken xref/trailer
  // or font-subsetting corruption that a byte scan would happily walk past.
  const reopened = await PDFDocument.load(bytes);
  ok(reopened.getPageCount() >= 1, "pdf re-parses with at least one page");
  const [pageW, pageH] = reopened.getPage(0).getSize();
  equal(Math.round(pageW), 595, "A4 width");
  equal(Math.round(pageH), 842, "A4 height");
});

test("PDF export paginates long OCR text instead of clipping it", async () => {
  const longOcr = Array.from(
    { length: 120 },
    (_, i) => `سطر رقم ${i + 1} من النص المستخرج من الوثيقة`
  ).join("\n");
  const res = await exportExtraction(
    extraction,
    { format: "pdf" },
    { ocrText: longOcr }
  );

  const reopened = await PDFDocument.load(res.buffer!);
  const pages = reopened.getPageCount();
  ok(pages > 1, `long OCR text spans multiple pages (got ${pages})`);
  for (let i = 0; i < pages; i++) {
    const [w, h] = reopened.getPage(i).getSize();
    equal(Math.round(w), 595, `page ${i + 1} is A4`);
    equal(Math.round(h), 842, `page ${i + 1} is A4`);
  }
});
