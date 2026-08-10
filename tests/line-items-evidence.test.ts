import { test, ok, equal, assert } from "./harness.ts";
import { groundExtraction, valueNeedles } from "@/lib/pipeline/extractor/grounding";
import { receiptProfile } from "@/lib/pipeline/profiles/receipt";
import { runPipeline } from "@/lib/pipeline/defaults";
import type { AIClient, ExtractionResult, OcrDocument } from "@/lib/pipeline/types";

/**
 * M16 — line items are real, grounded data and must carry the same evidence
 * proof as every other field. Before this milestone the grounding `line_items`
 * branch short-circuited before the evidence search, so committed items (whose
 * descriptions are verified against OCR lines by the clean stage) carried NO
 * evidence, a false `no_direct_evidence` reason and an unfair confidence
 * penalty. M16 anchors line_items on their item descriptions and composes
 * real confidence — the same evidence ladder every scalar field uses.
 */

/** Minimal candidate extraction carrying one field value. */
function candidates(
  key: string,
  value: unknown,
  extra: { rawValue?: unknown; confidence?: number } = {}
): ExtractionResult {
  const schema = receiptProfile.schema;
  const field = schema.fields.find((f) => f.key === key)!;
  const fv = {
    value,
    rawValue: extra.rawValue,
    confidence: extra.confidence ?? 0.9,
    source: "ai" as const,
    status: "extracted" as const,
  };
  return {
    profileType: "receipt",
    profileVersion: 1,
    fields: [{ field, value: fv }],
    fieldsMap: { [key]: fv },
    cleanFields: { [key]: value },
    droppedFields: {},
  };
}

/** OcrDocument with word-level boxes + confidences (processed-image pixel space). */
function ocrWithWords(
  lines: Array<{ text: string; words: Array<{ text: string; confidence?: number; bbox: { x: number; y: number; width: number; height: number } }> }>
): OcrDocument {
  return {
    text: lines.map((l) => l.text).join("\n"),
    lines: lines.map((l) => ({
      text: l.text,
      words: l.words.map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })),
    })),
  };
}

const ITEMIZED_SRC = "CORNER STORE\nMILK 3.50\nBREAD 2.00\nTOTAL 5.50";

const itemizedLines = [
  { text: "CORNER STORE", words: [
    { text: "CORNER", bbox: { x: 0, y: 0, width: 60, height: 12 } },
    { text: "STORE", bbox: { x: 64, y: 0, width: 40, height: 12 } },
  ] },
  { text: "MILK 3.50", words: [
    { text: "MILK", confidence: 0.95, bbox: { x: 0, y: 16, width: 40, height: 12 } },
    { text: "3.50", confidence: 0.9, bbox: { x: 44, y: 16, width: 40, height: 12 } },
  ] },
  { text: "BREAD 2.00", words: [
    { text: "BREAD", confidence: 0.9, bbox: { x: 0, y: 32, width: 50, height: 12 } },
    { text: "2.00", confidence: 0.85, bbox: { x: 54, y: 32, width: 40, height: 12 } },
  ] },
  { text: "TOTAL 5.50", words: [
    { text: "TOTAL", bbox: { x: 0, y: 48, width: 50, height: 12 } },
    { text: "5.50", bbox: { x: 54, y: 48, width: 40, height: 12 } },
  ] },
];

const items = (description: string, amount: number) => ({
  description,
  quantity: 1,
  unit_price: amount,
  amount,
});

test("grounded line items carry per-description OCR evidence (no false no_direct_evidence)", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates(
      "line_items",
      [items("MILK", 3.5), items("BREAD", 2)],
      { rawValue: "MILK 3.50\nBREAD 2.00" }
    ),
    ITEMIZED_SRC,
    ocrWithWords(itemizedLines)
  );
  const lineItems = out.fieldsMap.line_items;
  ok(lineItems, "grounded line items must survive grounding");
  ok(lineItems!.evidence && lineItems!.evidence.length === 2, "each grounded description must carry evidence");
  const byLine = new Map(lineItems!.evidence!.map((e) => [e.lineIndex, e]));
  equal(byLine.get(1)?.quote, "MILK");
  equal(byLine.get(1)?.role, "value-match");
  equal(byLine.get(2)?.quote, "BREAD");
  equal(byLine.get(2)?.role, "value-match");
  ok(!(lineItems!.reasons ?? []).includes("no_direct_evidence"), "grounded items must not be flagged no_direct_evidence");
  ok((lineItems!.reasons ?? []).includes("label_not_matched"), "label-neutral items keep the label_not_matched reason");
  // 0.9 (ai) * mean(0.95, 0.90) (ocr) * 0.8 (label-neutral) = 0.666 — no 0.9 penalty.
  assert(Math.abs((lineItems!.confidence ?? 0) - 0.666) < 1e-9, `confidence must be 0.666, got ${lineItems!.confidence}`);
});

test("fully fabricated line items (descriptions absent from the OCR) are dropped in grounding", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates(
      "line_items",
      [items("INVENTED PRODUCT A", 1), items("INVENTED PRODUCT B", 2)],
      { rawValue: "INVENTED PRODUCT A\nINVENTED PRODUCT B" }
    ),
    "RECEIPT\nMILK 3.50\nTOTAL 3.50",
    ocrWithWords(itemizedLines)
  );
  ok(!out.fieldsMap.line_items, "items whose descriptions are not in the document must be dropped");
  ok(/not found in source text/.test(out.droppedFields.line_items ?? ""), "drop reason must explain the ungrounded descriptions");
});

test("a single generic footer item still fails the itemized gate", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates("line_items", [items("TOTAL", 5.5)], { rawValue: "TOTAL" }),
    "CORNER STORE\nTOTAL 5.50",
    ocrWithWords(itemizedLines)
  );
  ok(!out.fieldsMap.line_items, "a lone generic footer marker must not pass the itemized gate");
  ok(/no itemized product list/.test(out.droppedFields.line_items ?? ""), "gate reason must be recorded");
});

test("item descriptions on lines containing label words are NOT vetoed (items anchor on their own content)", () => {
  // "Tap water" is a real product whose line contains the payment label word
  // "tap". The relabel veto guards borrowed VALUES; a line item's evidence IS
  // its own description, so the field must survive with both items.
  const src = "CORNER STORE\nTap water 3.00\nBREAD 2.00\nTOTAL 5.00";
  const out = groundExtraction(
    receiptProfile,
    candidates("line_items", [items("Tap water", 3), items("BREAD", 2)], { rawValue: "Tap water 3.00\nBREAD 2.00" }),
    src,
    ocrWithWords([
      { text: "CORNER STORE", words: [{ text: "CORNER", bbox: { x: 0, y: 0, width: 60, height: 12 } }, { text: "STORE", bbox: { x: 64, y: 0, width: 40, height: 12 } }] },
      { text: "Tap water 3.00", words: [
        { text: "Tap", bbox: { x: 0, y: 16, width: 30, height: 12 } },
        { text: "water", bbox: { x: 34, y: 16, width: 40, height: 12 } },
        { text: "3.00", bbox: { x: 78, y: 16, width: 40, height: 12 } },
      ] },
      { text: "BREAD 2.00", words: [
        { text: "BREAD", bbox: { x: 0, y: 32, width: 50, height: 12 } },
        { text: "2.00", bbox: { x: 54, y: 32, width: 40, height: 12 } },
      ] },
      { text: "TOTAL 5.00", words: [
        { text: "TOTAL", bbox: { x: 0, y: 48, width: 50, height: 12 } },
        { text: "5.00", bbox: { x: 54, y: 48, width: 40, height: 12 } },
      ] },
    ])
  );
  const lineItems = out.fieldsMap.line_items;
  ok(lineItems, "items on label-word lines must survive (no relabel veto for array evidence)");
  equal(lineItems!.evidence!.length, 2);
  ok(lineItems!.evidence!.some((e) => e.lineIndex === 1), "the 'Tap water' line must be evidence");
});

test("mixed grounded + invented items keep the grounded evidence and no false no_direct_evidence", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates("line_items", [items("MILK", 3.5), items("INVENTED PRODUCT X", 9.99)], { rawValue: "MILK 3.50\nINVENTED PRODUCT X" }),
    "RECEIPT\nMILK 3.50\nTOTAL 3.50",
    ocrWithWords(itemizedLines)
  );
  const lineItems = out.fieldsMap.line_items;
  ok(lineItems, "field must survive when at least one description is grounded");
  ok(lineItems!.evidence!.length >= 1, "grounded description must produce evidence");
  ok(!(lineItems!.reasons ?? []).includes("no_direct_evidence"), "must not be flagged no_direct_evidence");
});

test("valueNeedles anchors array fields on item descriptions, not the concatenated rawValue", () => {
  const lineItemsField = receiptProfile.schema.fields.find((f) => f.key === "line_items")!;
  const needles = valueNeedles(lineItemsField, {
    value: [items("MILK", 3.5), items("BREAD", 2)],
    rawValue: "MILK 3.50\nBREAD 2.00",
    confidence: 0.9,
    source: "ai",
    status: "extracted",
  });
  equal(needles.join("|"), "MILK|BREAD", "array anchors are the item descriptions");

  // Scalar behavior is unchanged: the verbatim raw value is the needle.
  const merchantField = receiptProfile.schema.fields.find((f) => f.key === "merchant_name")!;
  equal(
    valueNeedles(merchantField, {
      value: "SuperPay",
      rawValue: "SuperPay",
      confidence: 0.9,
      source: "ai",
      status: "extracted",
    }).join("|"),
    "SuperPay"
  );
});

test("full production pipeline: itemized receipt commits line items with evidence and honest reasons", async () => {
  const SOURCE =
    "CORNER STORE\nReceipt number: 20134\nMILK 3.50\nBREAD 2.00\nTOTAL 5.50\nDate: 2025-01-15";
  const data = {
    receipt_number: { raw: "20134", value: "20134", confidence: 0.9 },
    receipt_date: { raw: "2025-01-15", value: "2025-01-15", confidence: 0.9 },
    merchant_name: { raw: "CORNER STORE", value: "CORNER STORE", confidence: 0.9 },
    total_amount: { raw: "5.50", value: 5.5, confidence: 0.9 },
    line_items: {
      raw: "MILK 3.50\nBREAD 2.00",
      value: [items("MILK", 3.5), items("BREAD", 2)],
      confidence: 0.9,
    },
  };
  const fakeAI: AIClient = {
    chatCompletion: async () => ({ content: JSON.stringify({ data }), model: "fake", provider: "test" }),
  };
  const out = await runPipeline({ sourceText: SOURCE, profileType: "receipt" }, { ai: fakeAI });
  assert(out.status === "complete", `pipeline must complete (got ${out.status})`);
  const lineItems = out.job.extraction.fieldsMap.line_items;
  ok(lineItems, "line items must survive the full pipeline");
  ok(lineItems!.evidence && lineItems!.evidence.length === 2, "line items must carry OCR evidence end-to-end");
  ok(!(lineItems!.reasons ?? []).includes("no_direct_evidence"), "no false no_direct_evidence reason end-to-end");
  equal(Math.round((lineItems!.confidence ?? 0) * 100), 72, "confidence must drop the unfair penalty (0.9 * 1 * 0.8)");
});
