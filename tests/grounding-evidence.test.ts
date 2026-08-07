import { test, ok, equal } from "./harness.ts";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { assessTextQuality, isNoiseFragment } from "@/lib/pipeline/text-quality";
import { receiptProfile } from "@/lib/pipeline/profiles/receipt";
import type { ExtractionResult, OcrDocument } from "@/lib/pipeline/types";

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

/** OcrDocument with word-level boxes (processed-image pixel space). */
function ocrWithWords(lines: Array<{ text: string; words: Array<{ text: string; confidence?: number; bbox: { x: number; y: number; width: number; height: number } }> }>): OcrDocument {
  return {
    text: lines.map((l) => l.text).join("\n"),
    confidence: 0.8,
    lines: lines.map((l) => ({
      text: l.text,
      confidence: l.words.length ? undefined : undefined,
      words: l.words.map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })),
    })),
  };
}

const receipt = [
  { text: "AL RABIH SUPERMARKET", words: [
    { text: "AL", bbox: { x: 24, y: 26, width: 20, height: 12 } },
    { text: "RABIH", bbox: { x: 48, y: 26, width: 50, height: 12 } },
    { text: "SUPERMARKET", bbox: { x: 102, y: 26, width: 110, height: 12 } },
  ] },
  { text: "TOTAL  38.40", words: [
    { text: "TOTAL", confidence: 0.97, bbox: { x: 24, y: 300, width: 50, height: 14 } },
    { text: "38.40", confidence: 0.98, bbox: { x: 90, y: 300, width: 60, height: 14 } },
  ] },
];

test("grounding emits wordIndices + bbox for matched spans", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates("total_amount", 38.4, { rawValue: "38.40" }),
    "AL RABIH SUPERMARKET\nTOTAL  38.40",
    ocrWithWords(receipt)
  );
  const total = out.fieldsMap.total_amount;
  ok(total, "total_amount must survive grounding");
  const ev = total!.evidence![0];
  ok(ev, "evidence must exist");
  equal(ev.quote, "38.40");
  equal(ev.lineIndex, 1);
  ok(Array.isArray(ev.wordIndices) && ev.wordIndices.length === 1, "wordIndices must point at the value word");
  equal(ev.wordIndices![0], 1);
  ok(ev.bbox && ev.bbox.x === 90, "bbox must be the value word's box");
  ok(ev.source === "ocr", "evidence source must be ocr");
});

test("grounding picks the label-matched span and records differing readings as alternatives", () => {
  // The same date printed two ways (header ISO, footer dd-mm-yyyy) is a real
  // near-duplicate: the derived-evidence matcher sees both, primary must be
  // the label-matched span, and the other reading becomes an alternative.
  const lines = [
    { text: "Date: 2026-07-02", words: [
      { text: "Date:", confidence: 0.99, bbox: { x: 0, y: 0, width: 40, height: 12 } },
      { text: "2026-07-02", confidence: 0.9, bbox: { x: 60, y: 0, width: 80, height: 12 } },
    ] },
    { text: "Issued 02-07-2026", words: [
      { text: "Issued", confidence: 0.99, bbox: { x: 0, y: 40, width: 50, height: 12 } },
      { text: "02-07-2026", confidence: 0.99, bbox: { x: 55, y: 40, width: 80, height: 12 } },
    ] },
  ];
  const out = groundExtraction(
    receiptProfile,
    candidates("receipt_date", "2026-07-02"),
    "Date: 2026-07-02\nIssued 02-07-2026",
    ocrWithWords(lines)
  );
  const date = out.fieldsMap.receipt_date;
  ok(date, "receipt_date must survive grounding");
  // Both spans sit on a date-labeled line; the higher-confidence one wins.
  equal(date!.evidence![0].quote, "02-07-2026");
  equal(date!.evidence![0].confidence!, 0.99);
  ok(date!.evidence![0].wordIndices && date!.evidence![0].wordIndices.length === 1, "wordIndices must be set");
  ok(Array.isArray(date!.alternatives) && date!.alternatives.length >= 1, "differing reading must be recorded as an alternative");
  ok(date!.chosenReason && date!.chosenReason.length > 0, "chosenReason must explain the pick");
});

test("identical duplicate spans are collapsed with an explanatory chosenReason", () => {
  const lines = [
    { text: "TOTAL  38.40", words: [
      { text: "TOTAL", bbox: { x: 0, y: 0, width: 40, height: 12 } },
      { text: "38.40", confidence: 0.6, bbox: { x: 60, y: 0, width: 50, height: 12 } },
    ] },
    { text: "AMOUNT DUE  38.40", words: [
      { text: "AMOUNT", bbox: { x: 0, y: 40, width: 50, height: 12 } },
      { text: "DUE", bbox: { x: 55, y: 40, width: 30, height: 12 } },
      { text: "38.40", confidence: 0.99, bbox: { x: 90, y: 40, width: 50, height: 12 } },
    ] },
  ];
  const out = groundExtraction(
    receiptProfile,
    candidates("total_amount", 38.4, { rawValue: "38.40" }),
    "TOTAL  38.40\nAMOUNT DUE  38.40",
    ocrWithWords(lines)
  );
  const total = out.fieldsMap.total_amount;
  ok(total, "total_amount must survive grounding");
  // Both spans read the same value; both lines carry the total label
  // ("AMOUNT DUE" is not a date), so the higher-confidence span wins.
  equal(total!.evidence![0].quote, "38.40");
  equal(total!.evidence![0].confidence!, 0.99);
  ok(!total!.alternatives || total!.alternatives.length === 0, "identical readings add no alternatives");
  ok(total!.chosenReason && /appears on 2 lines/.test(total!.chosenReason), "chosenReason must explain the identical duplicates");
});

test("generic noise filter drops garbled notes but keeps clean text", () => {
  // Real OCR line-merge artifact (letters+digits glued) → garbage.
  ok(isNoiseFragment("Hostinger;Description…)0123456788("), "oversized letter+digit token must be garbage");
  // Symbol-dominated fragments → garbage.
  ok(isNoiseFragment("¥§©®™  ¥§©®™"), "symbol-dominated fragment must be garbage");
  // Clean notes survive.
  ok(!isNoiseFragment("Thank you for shopping"), "clean note must not be garbage");
  ok(!isNoiseFragment("Mobile Number"), "short clean note must not be garbage");
  ok(!isNoiseFragment("Payment: Bank transfer SA1234567890"), "real note with reference must not be garbage");
});

test("grounding drops garbage notes via the generic filter", () => {
  const src = "some line\nHostinger;Description…)0123456788(";
  const out = groundExtraction(
    receiptProfile,
    candidates("notes", "Hostinger;Description…)0123456788("),
    src,
    ocrWithWords([{ text: "Hostinger;Description…)0123456788(", words: [
      { text: "Hostinger;Description…)0123456788(", bbox: { x: 0, y: 0, width: 200, height: 12 } },
    ] }])
  );
  ok(!out.fieldsMap.notes, "garbage notes must be dropped");
  ok(out.droppedFields.notes, "drop reason must be recorded");
});

test("text-quality module reports interpretable reasons", () => {
  const q = assessTextQuality("Hostinger;Description…)0123456788(");
  equal(q.noiseScore, 1);
  ok(q.reasons.length > 0, "reasons must explain the garbage verdict");
});
