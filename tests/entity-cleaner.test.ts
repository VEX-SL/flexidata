import { cleanExtraction } from "@/lib/pipeline/entity-cleaner";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { receiptProfile } from "@/lib/pipeline/profiles/receipt";
import { runPipeline } from "@/lib/pipeline/defaults";
import type {
  AIClient,
  ExtractionResult,
  OcrDocument,
} from "@/lib/pipeline/types";
import { test, ok, equal, includes } from "./harness.ts";
import { SUPERYPAY_RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";

/** Build a post-grounding extraction for the given fields (schema-driven). */
function rawExtraction(
  entries: Array<{ key: string; value: unknown; rawValue?: unknown }>
): ExtractionResult {
  const schema = receiptProfile.schema;
  const fields = entries.map((e) => {
    const field = schema.fields.find((f) => f.key === e.key)!;
    return {
      field,
      value: {
        value: e.value,
        rawValue: e.rawValue ?? e.value,
        confidence: 0.9,
        source: "ai" as const,
        status: "extracted" as const,
      },
    };
  });
  const fieldsMap: ExtractionResult["fieldsMap"] = {};
  const cleanFields: Record<string, unknown> = {};
  for (const nf of fields) {
    fieldsMap[nf.field.key] = nf.value;
    cleanFields[nf.field.key] = nf.value.value;
  }
  return {
    profileType: "receipt",
    profileVersion: 1,
    fields,
    fieldsMap,
    cleanFields,
    droppedFields: {},
  };
}

/** Ground a single-field candidate so the cleaner sees a post-grounding shape. */
function grounded(
  key: string,
  value: unknown,
  rawValue: unknown,
  src: string,
  ocr?: OcrDocument
): ExtractionResult {
  const profile = receiptProfile;
  const field = profile.schema.fields.find((f) => f.key === key)!;
  const fv = {
    value,
    rawValue,
    confidence: 0.9,
    source: "ai" as const,
    status: "extracted" as const,
  };
  const candidate: ExtractionResult = {
    profileType: "receipt",
    profileVersion: 1,
    fields: [{ field, value: fv }],
    fieldsMap: { [key]: fv },
    cleanFields: { [key]: value },
    droppedFields: {},
  };
  return groundExtraction(profile, candidate, src, ocr);
}

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

/** Build a structured OcrDocument with word-level boxes from plain lines. */
function ocrFrom(src: string): OcrDocument {
  return {
    text: src,
    confidence: 0.8,
    lines: src.split("\n").map((text) => ({
      text,
      words: text.split(/\s+/).filter(Boolean).map((w, i) => ({
        text: w,
        bbox: { x: i * 60, y: 0, width: 50, height: 12 },
      })),
    })),
  };
}

test("surrounding OCR separators are trimmed; metadata + evidence are preserved", () => {
  const src = "MERCHANT\n| AL RABIH SUPERMARKET |\nTOTAL\n38.40\n";
  const ocr = ocrFrom(src);
  const pre = grounded(
    "merchant_name",
    "| AL RABIH SUPERMARKET |",
    "| AL RABIH SUPERMARKET |",
    src,
    ocr
  );
  const out = cleanExtraction(receiptProfile, pre, src, ocr).extraction;

  const fv = out.fieldsMap.merchant_name;
  equal(fv.value, "AL RABIH SUPERMARKET");
  equal(fv.chosenReason, "entity_cleaned");
  // Grounding already appended label_not_matched (neutral label line); the
  // cleaner must append entity_cleaned, never replace or reset reasons.
  equal(fv.reasons, ["label_not_matched", "entity_cleaned"]);
  equal(fv.rawValue, "| AL RABIH SUPERMARKET |");
  // Evidence, bbox, word indices and confidence are preserved, not recomputed.
  equal(fv.evidence, pre.fieldsMap.merchant_name.evidence);
  equal(fv.confidence, pre.fieldsMap.merchant_name.confidence);
  equal(out.cleanFields.merchant_name, "AL RABIH SUPERMARKET");
  ok((fv.evidence?.[0].bbox?.width ?? 0) > 0, "bbox preserved");
  ok(Array.isArray(fv.evidence?.[0].wordIndices), "word indices preserved");
});

test("broken spacing is collapsed", () => {
  const src = "MERCHANT\nAL RABIH  SUPERMARKET\n";
  const pre = grounded("merchant_name", "AL RABIH  SUPERMARKET", "AL RABIH  SUPERMARKET", src);
  const out = cleanExtraction(receiptProfile, pre, src).extraction;
  equal(out.fieldsMap.merchant_name.value, "AL RABIH SUPERMARKET");
  equal(out.fieldsMap.merchant_name.chosenReason, "entity_cleaned");
});

test("duplicated punctuation is collapsed and trailing marks are trimmed", () => {
  const src = "MERCHANT\nSuperPay!!!\n";
  const pre = grounded("merchant_name", "SuperPay!!!", "SuperPay!!!", src);
  const out = cleanExtraction(receiptProfile, pre, src).extraction;
  equal(out.fieldsMap.merchant_name.value, "SuperPay");
});

test("invisible characters around the value are removed", () => {
  const src = "MERCHANT\n\u200bSuperPay\u200b\n";
  const pre = grounded("merchant_name", "\u200bSuperPay\u200b", "\u200bSuperPay\u200b", src);
  const out = cleanExtraction(receiptProfile, pre, src).extraction;
  equal(out.fieldsMap.merchant_name.value, "SuperPay");
  equal(out.fieldsMap.merchant_name.chosenReason, "entity_cleaned");
});

test("full-width Unicode is normalized to its canonical form", () => {
  const src = "MERCHANT\n\uFF2D\uFF25\uFF32\uFF23\uFF28\uFF21\uFF2E\uFF34\n"; // ＭＥＲＣＨＡＮＴ
  const pre = grounded("merchant_name", "ＭＥＲＣＨＡＮＴ", "ＭＥＲＣＨＡＮＴ", src);
  const out = cleanExtraction(receiptProfile, pre, src).extraction;
  equal(out.fieldsMap.merchant_name.value, "MERCHANT");
  equal(out.fieldsMap.merchant_name.chosenReason, "entity_cleaned");
});

test("already-clean values are left untouched (no metadata churn)", () => {
  const src = "MERCHANT\nSuperPay\n";
  const pre = grounded("merchant_name", "SuperPay", "SuperPay", src);
  const out = cleanExtraction(receiptProfile, pre, src).extraction;
  equal(out.fieldsMap.merchant_name.value, "SuperPay");
  equal(out.fieldsMap.merchant_name.chosenReason, undefined);
  equal(out.fieldsMap.merchant_name.reasons, pre.fieldsMap.merchant_name.reasons);
  ok(
    !(out.fieldsMap.merchant_name.reasons ?? []).includes("entity_cleaned"),
    "no entity_cleaned reason may be appended to a value that was not changed"
  );
  const stats = cleanExtraction(receiptProfile, pre, src).stats;
  equal(stats.cleaned, []);
  ok(stats.unchanged >= 1, "clean field must count as examined-but-unchanged");
});

test("cleaning never removes text from the middle of real content", () => {
  const src = "MERCHANT\nAL RABIH (SUPERMARKET)\n";
  // Only the closing paren is at the edge; stripping it would unbalance the
  // brackets, so the cleaner must leave the value untouched.
  const pre = grounded("merchant_name", "AL RABIH (SUPERMARKET)", "AL RABIH (SUPERMARKET)", src);
  const out = cleanExtraction(receiptProfile, pre, src).extraction;
  equal(out.fieldsMap.merchant_name.value, "AL RABIH (SUPERMARKET)");
  equal(out.fieldsMap.merchant_name.chosenReason, undefined);
});

test("grounding safety: cleaned value that cannot be re-grounded is discarded", () => {
  // "ACME,,LLC" → "ACME,LLC" would be a provable reduction, but the single
  // comma does not appear verbatim in the OCR line "ACME,,LLC", so the cleaned
  // version cannot be grounded and the original must stay.
  const src = "MERCHANT\nACME,,LLC\n";
  const pre = grounded("merchant_name", "ACME,,LLC", "ACME,,LLC", src);
  const out = cleanExtraction(receiptProfile, pre, src).extraction;
  equal(out.fieldsMap.merchant_name.value, "ACME,,LLC");
  equal(out.fieldsMap.merchant_name.chosenReason, undefined);
});

test("structured fields (numbers, dates, enums) are never cleaned", () => {
  const src =
    "RECEIPT\n02-07-2028 18:30:12 ,\nالمطلوب : 68.38 ;\nTOTAL\n38.40\n";
  const profile = receiptProfile;
  const schema = profile.schema;
  const mk = (key: string, value: unknown, rawValue: unknown) => {
    const field = schema.fields.find((f) => f.key === key)!;
    return { field, value: { value, rawValue, confidence: 0.9, source: "ai" as const, status: "extracted" as const } };
  };
  const extraction: ExtractionResult = {
    profileType: "receipt",
    profileVersion: 1,
    fields: [
      mk("receipt_date", "2028-07-02", "02-07-2028 18:30:12 ,"),
      mk("total_amount", 68.38, "68.38 ;"),
      mk("currency", "SAR", "SAR,"),
    ],
    fieldsMap: {},
    cleanFields: {},
    droppedFields: {},
  };
  for (const f of extraction.fields) {
    extraction.fieldsMap[f.field.key] = f.value;
    extraction.cleanFields[f.field.key] = f.value.value;
  }

  const out = cleanExtraction(profile, extraction, src).extraction;
  equal(out.fieldsMap.receipt_date.value, "2028-07-02");
  equal(out.fieldsMap.total_amount.value, 68.38);
  equal(out.fieldsMap.currency.value, "SAR");
  equal(out.fieldsMap.currency.chosenReason, undefined);
  const stats = cleanExtraction(profile, extraction, src).stats;
  equal(stats.cleaned, []);
});

test("clean stage runs in the default pipeline between ground and recover", async () => {
  const payload = JSON.stringify({
    data: {
      merchant_name: {
        raw: "| ACME Store |",
        value: "| ACME Store |",
        confidence: 0.9,
        evidence: "| ACME Store |",
      },
      total_amount: {
        raw: "38.40",
        value: 38.4,
        confidence: 0.9,
        evidence: "38.40",
      },
    },
  });
  const src = "Receipt\n| ACME Store |\nTOTAL 38.40\n";
  const out = await runPipeline(
    { sourceText: src, profileType: "receipt" },
    { ai: fakeAI(payload) }
  );
  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  ok(out.trace.some((t) => t.stage === "clean"), "clean stage must run");
  const order = Array.from(new Set(out.trace.map((t) => t.stage)));
  equal(
    order.join(","),
    "classify,extract,ground,clean,recover,validate,confidence",
    "clean must sit between ground and recover"
  );
  equal(out.job!.extraction.fieldsMap.merchant_name.value, "ACME Store");
  equal(out.job!.extraction.fieldsMap.merchant_name.chosenReason, "entity_cleaned");
});

test("name fields lose detached digit artifacts; metadata + evidence preserved", () => {
  const src = "MERCHANT\nله SuperPay 60\nTOTAL\n38.40\n";
  const ocr = ocrFrom(src);
  const pre = grounded("merchant_name", "SuperPay 60", "SuperPay 60", src, ocr);
  const out = cleanExtraction(receiptProfile, pre, src, ocr).extraction;
  const fv = out.fieldsMap.merchant_name;
  equal(fv.value, "SuperPay");
  equal(fv.chosenReason, "entity_cleaned");
  ok((fv.reasons ?? []).includes("entity_cleaned"), "reason must record the change");
  equal(fv.rawValue, "SuperPay 60");
  equal(fv.evidence, pre.fieldsMap.merchant_name.evidence);
  equal(out.cleanFields.merchant_name, "SuperPay");
  includes(cleanExtraction(receiptProfile, pre, src, ocr).stats.cleaned, "merchant_name");
});

test("digit-edge trimming applies only to name fields", () => {
  const src = "PAYMENT\nVISA \u2022\u2022 4242\nTOTAL\n38.40\n";
  const pre = grounded("payment_method", "VISA \u2022\u2022 4242", "VISA \u2022\u2022 4242", src);
  const out = cleanExtraction(receiptProfile, pre, src).extraction;
  equal(out.fieldsMap.payment_method.value, "VISA \u2022\u2022 4242");
  equal(out.fieldsMap.payment_method.chosenReason, undefined);
});

test("notes that are not grounded to a single OCR line are dropped", () => {
  const src = SUPERYPAY_RECEIPT_OCR;
  const extraction = rawExtraction([
    { key: "notes", value: "Mobile Number Hostinger;Description", rawValue: "Mobile Number Hostinger;Description " },
  ]);
  const out = cleanExtraction(receiptProfile, extraction, src).extraction;
  ok(!out.fieldsMap.notes, "line-merged notes must be dropped");
  ok(/not grounded/.test(out.droppedFields.notes ?? ""), "drop reason must explain the ungrounded value");
  includes(cleanExtraction(receiptProfile, extraction, src).stats.dropped, "notes");
});

test("grounded clean notes survive the cleaner", () => {
  const src = SUPERYPAY_RECEIPT_OCR;
  const extraction = rawExtraction([
    { key: "notes", value: "عملية ناجحة", rawValue: "عملية ناجحة" },
  ]);
  const out = cleanExtraction(receiptProfile, extraction, src).extraction;
  equal(out.fieldsMap.notes.value, "عملية ناجحة");
  ok(!out.droppedFields.notes, "grounded clean notes must not be dropped");
});

test("line items built from OCR fragments are suppressed (field dropped)", () => {
  const src = SUPERYPAY_RECEIPT_OCR;
  const extraction = rawExtraction([
    {
      key: "line_items",
      value: [
        { description: "Hostinger;Description\u2026)0123456788(", quantity: 1, unit_price: 68.38, amount: 68.38 },
      ],
      rawValue: "Hostinger;Description\u2026)0123456788(",
    },
  ]);
  const out = cleanExtraction(receiptProfile, extraction, src).extraction;
  ok(!out.fieldsMap.line_items, "garbage line item must be dropped");
  ok(out.droppedFields.line_items, "drop reason must be recorded");
});

test("footer/fragment line items are suppressed while real items survive", () => {
  const src = "RECEIPT\nMILK 3.50\nTOTAL 3.50\n";
  const extraction = rawExtraction([
    {
      key: "line_items",
      value: [
        { description: "MILK", quantity: 1, unit_price: 3.5, amount: 3.5 },
        { description: "X PURCHASE 8", quantity: 1, unit_price: 8, amount: 8 },
      ],
      rawValue: "MILK 3.50\nTOTAL 3.50",
    },
  ]);
  const out = cleanExtraction(receiptProfile, extraction, src).extraction;
  const items = out.fieldsMap.line_items!.value as Array<{ description: string }>;
  equal(items.length, 1, "fragment item must be suppressed");
  equal(items[0].description, "MILK");
  ok(!out.droppedFields.line_items, "field must survive when a real item remains");
});

test("line items with descriptions missing from the OCR are suppressed", () => {
  const src = "RECEIPT\nMILK 3.50\nTOTAL 3.50\n";
  const extraction = rawExtraction([
    {
      key: "line_items",
      value: [
        { description: "MILK", quantity: 1, unit_price: 3.5, amount: 3.5 },
        { description: "INVENTED PRODUCT", quantity: 1, unit_price: 9.99, amount: 9.99 },
      ],
      rawValue: "MILK 3.50\nINVENTED PRODUCT",
    },
  ]);
  const out = cleanExtraction(receiptProfile, extraction, src).extraction;
  const items = out.fieldsMap.line_items!.value as Array<{ description: string }>;
  equal(items.length, 1);
  equal(items[0].description, "MILK");
});

test("clean stage improves real-world output end-to-end", async () => {
  const payload = JSON.stringify({
    data: {
      merchant_name: { raw: "SuperPay 60", value: "SuperPay 60", confidence: 1, evidence: "له SuperPay 60" },
      receipt_number: { raw: "6070218301132167", value: "6070218301132167", confidence: 1, evidence: "رقم التمليه : 6070218301132167" },
      total_amount: { raw: "68.38", value: 68.38, confidence: 1, evidence: "العلى : 68.38" },
      notes: { raw: "Mobile Number Hostinger;Description", value: "Mobile Number Hostinger;Description", confidence: 1, evidence: "Hostinger;Description" },
    },
  });
  const out = await runPipeline(
    { sourceText: SUPERYPAY_RECEIPT_OCR, profileType: "receipt" },
    { ai: fakeAI(payload) }
  );
  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  equal(out.job!.extraction.fieldsMap.merchant_name.value, "SuperPay");
  // Line-merged notes (two real OCR lines glued by the model) are not verbatim
  // on any single OCR line: grounding now drops them, so they never reach the
  // cleaner at all. The end-to-end guarantee is unchanged.
  ok(!out.job!.extraction.fieldsMap.notes, "line-merged notes must be dropped");
  ok(
    /not found in source text/.test(out.job!.extraction.droppedFields.notes ?? ""),
    "line-merged notes must be dropped by grounding"
  );
  const cleanTrace = out.trace.find((t) => t.stage === "clean" && t.event === "finish")?.data as Record<string, unknown>;
  includes(cleanTrace.cleaned as string, "merchant_name");
});
