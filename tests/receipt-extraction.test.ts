import type { AIClient } from "@/lib/pipeline/types";
import { extractDocument } from "@/lib/pipeline/extractor";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { test, ok, equal, assert } from "./harness.ts";
import { SUPERYPAY_RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

const GROUNDED = JSON.stringify({
  data: {
    receipt_number: {
      raw: "2013438351",
      value: "2013438351",
      confidence: 0.9,
      evidence: "انرقم المرجقي : 2013438351",
    },
    receipt_date: {
      raw: "02-07-2028 18:30:12",
      value: "2028-07-02",
      confidence: 0.85,
      evidence: "تبيخ الوقت : 02-07-2028 18:30:12",
    },
    merchant_name: {
      raw: "SuperPay",
      value: "SuperPay",
      confidence: 0.9,
      evidence: "له SuperPay 60",
    },
    merchant_tax_id: null,
    customer_name: {
      raw: "Zahra Aman",
      value: "Zahra Aman",
      confidence: 0.85,
      evidence: "Zahra Aman =",
    },
    currency: null,
    subtotal: null,
    tax_amount: null,
    discount_amount: null,
    total_amount: {
      raw: "68.38",
      value: 68.38,
      confidence: 0.9,
      evidence: "العلى : 68.38",
    },
    payment_method: null,
    cashier_name: null,
    pos_number: {
      raw: "391803452",
      value: "391803452",
      confidence: 0.85,
      evidence: "رقم الحساب : 391803452",
    },
    notes: {
      raw: "عملية ناجحة",
      value: "عملية ناجحة",
      confidence: 0.8,
      evidence: "عملية ناجحة",
    },
    line_items: null,
  },
});

test("receipt extraction keeps grounded fields with evidence + raw values", async () => {
  const profile = getProfileManager().get("receipt");
  ok(profile, "receipt profile must be registered");

  const result = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(GROUNDED)
  );

  equal(result.profileType, "receipt");
  equal(result.cleanFields.receipt_number, "2013438351");
  equal(result.cleanFields.receipt_date, "2028-07-02");
  equal(result.cleanFields.merchant_name, "SuperPay");
  equal(result.cleanFields.customer_name, "Zahra Aman");
  equal(result.cleanFields.total_amount, 68.38);
  ok(!result.droppedFields.merchant_name, "merchant_name must survive grounding");
  ok(!result.droppedFields.total_amount, "total_amount must survive grounding");
});

test("every surviving field preserves raw OCR value + evidence anchors", async () => {
  const profile = getProfileManager().get("receipt");
  const result = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(GROUNDED)
  );

  const numberFv = result.fieldsMap.receipt_number;
  equal(numberFv.rawValue, "2013438351");
  ok(numberFv.evidence && numberFv.evidence.length > 0, "evidence attached");
  ok(
    numberFv.evidence![0].lineIndex !== undefined,
    "evidence references an OCR line"
  );
  equal(numberFv.evidence![0].role, "value-match");

  const dateFv = result.fieldsMap.receipt_date;
  equal(dateFv.rawValue, "02-07-2028 18:30:12");
  ok(
    dateFv.evidence!.some((e) => e.role === "derived" || e.role === "value-match"),
    "date evidence anchored"
  );
});

test("grounded notes carry OCR evidence end-to-end (no false no_direct_evidence)", async () => {
  const profile = getProfileManager().get("receipt");
  const result = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(GROUNDED)
  );

  const notes = result.fieldsMap.notes;
  ok(notes, "verbatim clean notes must survive");
  equal(notes.value, "عملية ناجحة");
  ok(notes.evidence && notes.evidence.length > 0, "notes must carry OCR evidence");
  equal(notes.evidence![0].role, "value-match");
  ok(
    notes.evidence![0].lineIndex !== undefined,
    "notes evidence must reference an OCR line"
  );
  ok(
    !(notes.reasons ?? []).includes("no_direct_evidence"),
    "grounded notes must not be flagged no_direct_evidence"
  );
});

test("confidence is composed per field, not a fixed 0.85", async () => {
  const profile = getProfileManager().get("receipt");
  const result = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(GROUNDED)
  );

  // number: label match (المرجقي) → factor 1 → 0.9 * 1 = 0.9
  equal(result.fieldsMap.receipt_number.confidence, 0.9);
  // merchant: neutral label → factor 0.92 → 0.9 * 0.92 = 0.828 ≈ 83
  equal(Math.round(result.fieldsMap.merchant_name.confidence * 100), 83);
  // date: label match (الوقت) → 0.85 * 1 = 0.85
  equal(result.fieldsMap.receipt_date.confidence, 0.85);
});

test("ungrounded values and relabeled values are dropped (strict grounding)", async () => {
  const profile = getProfileManager().get("receipt");

  // Relabel: model claims the reference number (2013438351) is the tax ID.
  const relabel = JSON.stringify({
    data: {
      merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9, evidence: "SuperPay" },
      merchant_tax_id: { raw: "2013438351", value: "2013438351", confidence: 0.9, evidence: "انرقم المرجقي : 2013438351" },
      total_amount: { raw: "68.38", value: 68.38, confidence: 0.9, evidence: "العلى : 68.38" },
    },
  });
  const relabelResult = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(relabel)
  );
  equal(relabelResult.cleanFields.merchant_tax_id, undefined);
  ok(
    relabelResult.droppedFields.merchant_tax_id,
    "tax id must never borrow the reference number"
  );

  // Ungrounded: model invents a value that is not in the document at all.
  const invented = JSON.stringify({
    data: {
      merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9, evidence: "SuperPay" },
      customer_name: { raw: "INVENTED NAME", value: "INVENTED NAME", confidence: 0.9, evidence: "INVENTED NAME" },
      total_amount: { raw: "68.38", value: 68.38, confidence: 0.9, evidence: "العلى : 68.38" },
    },
  });
  const inventedResult = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(invented)
  );
  equal(inventedResult.cleanFields.customer_name, undefined);
  ok(
    /not found in source text/.test(inventedResult.droppedFields.customer_name ?? ""),
    "ungrounded value dropped with reason"
  );
});

test("structured OCR word confidence lowers composed field confidence", async () => {
  const profile = getProfileManager().get("receipt");
  const lines = SUPERYPAY_RECEIPT_OCR.split("\n").map((lineText) => ({
    text: lineText,
    words: lineText
      .split(/\s+/)
      .filter(Boolean)
      .map((text) => ({ text, confidence: 0.5 })),
  }));

  const result = await extractDocument(
    {
      profile: profile!,
      sourceText: SUPERYPAY_RECEIPT_OCR,
      ocr: { text: SUPERYPAY_RECEIPT_OCR, lines },
    },
    fakeAI(GROUNDED)
  );

  // number: 0.9 (ai) * 0.5 (ocr) * 1 (label) = 0.45
  equal(Math.round(result.fieldsMap.receipt_number.confidence * 100), 45);
});

test("currency is dropped when no currency is printed in the document", async () => {
  const profile = getProfileManager().get("receipt");
  const withCurrency = JSON.stringify({
    data: {
      merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9, evidence: "SuperPay" },
      currency: { raw: "SAR", value: "SAR", confidence: 0.9, evidence: "SuperPay" },
      total_amount: { raw: "68.38", value: 68.38, confidence: 0.9, evidence: "العلى : 68.38" },
    },
  });
  const result = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(withCurrency)
  );
  equal(result.cleanFields.currency, undefined);
  ok(/currency not stated/.test(result.droppedFields.currency ?? ""), "currency dropped with reason");
});

test("phantom line items and OCR-garbage notes are dropped", async () => {
  const profile = getProfileManager().get("receipt");
  const noisy = JSON.stringify({
    data: {
      merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9, evidence: "SuperPay" },
      total_amount: { raw: "68.38", value: 68.38, confidence: 0.9, evidence: "العلى : 68.38" },
      line_items: {
        raw: "X PURCHASE 8",
        value: [{ description: "X PURCHASE 8", quantity: 1, unit_price: 68.38, amount: 68.38 }],
        confidence: 0.9,
        evidence: "X PURCHASE 8",
      },
      notes: {
        raw: "Hostinger;Description © ;)0123456788(",
        value: "Hostinger;Description © ;)0123456788(",
        confidence: 0.9,
        evidence: "Hostinger;Description ©",
      },
    },
  });
  const result = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(noisy)
  );
  equal(result.cleanFields.line_items, undefined);
  equal(result.cleanFields.notes, undefined);
});

test("flat model output (no envelope) still extracts backward-compatibly", async () => {
  const profile = getProfileManager().get("receipt");
  const flat = JSON.stringify({
    receipt_number: "2013438351",
    merchant_name: "SuperPay",
    total_amount: 68.38,
  });
  const result = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(flat)
  );
  equal(result.cleanFields.receipt_number, "2013438351");
  equal(result.cleanFields.total_amount, 68.38);
  assert(result.fieldsMap.receipt_number.confidence > 0, "flat path still yields confidence");
});
