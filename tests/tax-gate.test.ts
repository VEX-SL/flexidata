import { test, ok, equal, includes } from "./harness.ts";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { runPipeline } from "@/lib/pipeline/defaults";
import { receiptProfile } from "@/lib/pipeline/profiles/receipt";
import { invoiceProfile } from "@/lib/pipeline/profiles/invoice";
import type {
  AIClient,
  ExtractionProfile,
  ExtractionResult,
  FieldValue,
} from "@/lib/pipeline/types";
import { SUPERYPAY_RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";

/**
 * M14 — the `*_tax_id` grounding gate.
 *
 * A tax ID must survive only when BOTH hold: the document carries a tax
 * keyword (semantic gate) AND the VALUE itself is anchored to a real OCR
 * span (strict-grounding gate). The pre-M14 code checked only the keyword and
 * blindly committed whatever value the model produced — a fabricated tax ID
 * with a stray "الرقم الضريبي" line in the document survived end-to-end.
 *
 * Matrix (grounding level + full production pipeline):
 *   1. fabricated value + tax keyword present  → dropped (not found in source)
 *   2. real value + tax keyword present         → survives with evidence
 *   3. real value + tax keyword absent          → dropped (no tax identifier)
 *   4. reference number relabeled + keyword     → dropped (never borrow)
 *   5. real value printed with separators       → survives (verify tier)
 *   6. invoice seller_tax_id / buyer_tax_id     → same gate, both fields
 *   7. production pipeline end-to-end           → fabricated dropped, real kept,
 *                                                 baseline fields unaffected
 */

const REAL_TAX = "1234567890000003";
const FABRICATED_TAX = "9999999999999999";
const TAX_LINE = `الرقم الضريبي : ${REAL_TAX}`;
const REF_LINE = "انرقم المرجقي : 2013438351";
const WITH_TAX = `SuperPay\n${REF_LINE}\n${TAX_LINE}\nالمطلوب : 68.38`;
const NO_TAX = `SuperPay\n${REF_LINE}\nالمطلوب : 68.38`;

function candidates(
  profile: ExtractionProfile,
  map: Record<string, unknown>
): ExtractionResult {
  const schema = profile.schema;
  const fieldsMap: Record<string, FieldValue> = {};
  const fields: ExtractionResult["fields"] = [];
  for (const [key, value] of Object.entries(map)) {
    const field = schema.fields.find((f) => f.key === key);
    ok(field, `field ${key} must exist in profile ${profile.id}`);
    const fv: FieldValue = {
      value,
      rawValue: undefined,
      confidence: 0.9,
      source: "ai",
      status: "extracted",
    };
    fieldsMap[key] = fv;
    fields.push({ field: field!, value: fv });
  }
  return {
    profileType: profile.id,
    profileVersion: profile.version,
    fields,
    fieldsMap,
    cleanFields: { ...map },
    droppedFields: {},
  };
}

// ── Grounding level ─────────────────────────────────────────────────────────

test("tax gate: fabricated value with a tax keyword present is dropped", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates(receiptProfile, { merchant_tax_id: FABRICATED_TAX }),
    WITH_TAX
  );
  equal(out.fieldsMap.merchant_tax_id, undefined);
  includes(
    out.droppedFields.merchant_tax_id ?? "",
    "not found in source text",
    "fabricated tax id must be dropped for missing evidence"
  );
});

test("tax gate: real value with a tax keyword present survives with evidence", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates(receiptProfile, { merchant_tax_id: REAL_TAX }),
    WITH_TAX
  );
  const fv = out.fieldsMap.merchant_tax_id;
  ok(fv, "real tax id must survive grounding");
  equal(fv!.value, REAL_TAX);
  ok((fv!.evidence ?? []).length > 0, "surviving tax id must carry evidence");
  includes(fv!.evidence![0].quote, REAL_TAX);
  equal(fv!.confidence, 0.9, "label-matched evidence must keep full confidence");
});

test("tax gate: value without a tax keyword anywhere is dropped", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates(receiptProfile, { merchant_tax_id: REAL_TAX }),
    NO_TAX
  );
  equal(out.fieldsMap.merchant_tax_id, undefined);
  includes(
    out.droppedFields.merchant_tax_id ?? "",
    "no tax identifier in document"
  );
});

test("tax gate: a reference number relabeled as the tax id is dropped", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates(receiptProfile, { merchant_tax_id: "2013438351" }),
    WITH_TAX
  );
  equal(out.fieldsMap.merchant_tax_id, undefined);
  includes(
    out.droppedFields.merchant_tax_id ?? "",
    "value labeled for a different field",
    "tax id must never borrow the reference number"
  );
});

test("tax gate: a real value printed with separators survives via the verify tier", () => {
  const src = `SuperPay\nالرقم الضريبي : 1234-5678-9000-0003`;
  const out = groundExtraction(
    receiptProfile,
    candidates(receiptProfile, { merchant_tax_id: REAL_TAX }),
    src
  );
  const fv = out.fieldsMap.merchant_tax_id;
  ok(fv, "separator-free tax id must survive grounding");
  equal(fv!.evidence![0].role, "derived");
});

test("tax gate: invoice seller_tax_id and buyer_tax_id use the same gate", () => {
  const invoiceSrc = `INVOICE\n${TAX_LINE}`;
  const fabricated = groundExtraction(
    invoiceProfile,
    candidates(invoiceProfile, {
      seller_tax_id: "7777777777777777",
      buyer_tax_id: "8888888888888888",
    }),
    invoiceSrc
  );
  equal(fabricated.fieldsMap.seller_tax_id, undefined);
  equal(fabricated.fieldsMap.buyer_tax_id, undefined);
  includes(
    fabricated.droppedFields.seller_tax_id ?? "",
    "not found in source text"
  );
  includes(
    fabricated.droppedFields.buyer_tax_id ?? "",
    "not found in source text"
  );

  const real = groundExtraction(
    invoiceProfile,
    candidates(invoiceProfile, {
      seller_tax_id: REAL_TAX,
      buyer_tax_id: REAL_TAX,
    }),
    invoiceSrc
  );
  ok(real.fieldsMap.seller_tax_id, "seller tax id survives grounding");
  ok(real.fieldsMap.buyer_tax_id, "buyer tax id survives grounding");
});

// ── Full production pipeline ────────────────────────────────────────────────

function fakeAI(data: Record<string, unknown>): AIClient {
  return {
    chatCompletion: async () => ({
      content: JSON.stringify({ data }),
      model: "fake",
      provider: "test",
    }),
  };
}

async function runExtraction(
  data: Record<string, unknown>,
  sourceText: string
): Promise<ExtractionResult> {
  const out = await runPipeline(
    { sourceText, profileType: "receipt" },
    { ai: fakeAI(data) }
  );
  ok(out.status === "complete" && out.job.extraction, "run must complete");
  return out.job.extraction!;
}

const BASE = {
  receipt_number: { raw: "2013438351", value: "2013438351", confidence: 0.9 },
  receipt_date: { raw: "02-07-2028", value: "2028-07-02", confidence: 0.9 },
  merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9 },
  total_amount: { raw: "68.38", value: 68.38, confidence: 0.9 },
};

test("production pipeline: fabricated tax id is dropped end-to-end", async () => {
  const src = SUPERYPAY_RECEIPT_OCR + `\n${TAX_LINE}`;
  const extraction = await runExtraction(
    {
      ...BASE,
      merchant_tax_id: { raw: FABRICATED_TAX, value: FABRICATED_TAX, confidence: 0.9 },
    },
    src
  );
  equal(
    extraction.fieldsMap.merchant_tax_id,
    undefined,
    "fabricated tax id must not survive the full pipeline"
  );
  includes(
    extraction.droppedFields.merchant_tax_id ?? "",
    "not found in source text"
  );
});

test("production pipeline: real tax id survives end-to-end with evidence", async () => {
  const src = SUPERYPAY_RECEIPT_OCR + `\n${TAX_LINE}`;
  const extraction = await runExtraction(
    {
      ...BASE,
      merchant_tax_id: { raw: REAL_TAX, value: REAL_TAX, confidence: 0.9 },
    },
    src
  );
  const fv = extraction.fieldsMap.merchant_tax_id;
  ok(fv, "real tax id must survive the full pipeline");
  equal(fv!.value, REAL_TAX);
  ok((fv!.evidence ?? []).length > 0, "surviving tax id must carry evidence");
});

test("production pipeline: baseline real fields stay intact", async () => {
  const extraction = await runExtraction(
    {
      ...BASE,
      customer_name: { raw: "Zahra Aman", value: "Zahra Aman", confidence: 0.9 },
      pos_number: { raw: "391803452", value: "391803452", confidence: 0.9 },
    },
    SUPERYPAY_RECEIPT_OCR
  );
  for (const key of ["receipt_number", "receipt_date", "merchant_name", "total_amount", "customer_name", "pos_number"]) {
    ok(extraction.fieldsMap[key], `${key} must survive the full pipeline`);
  }
});
