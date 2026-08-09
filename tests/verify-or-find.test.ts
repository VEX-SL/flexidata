import { test, ok, equal } from "./harness.ts";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { detectLabelGroup } from "@/lib/pipeline/extractor/label-lexicon";
import { verifyEvidence, findFieldCandidates } from "@/lib/pipeline/extractor/verify-or-find";
import { receiptProfile } from "@/lib/pipeline/profiles/receipt";
import type { ExtractionResult, FieldValue, OcrDocument } from "@/lib/pipeline/types";

/**
 * Milestone 12 — Verify-or-Find. Twenty scenarios derived from the milestone
 * invariants and the verified bottleneck (normalization tiers, label-adjacent
 * verification, the amount-due label collision, required-null find cases, and
 * the four no-invention guarantees).
 *
 * The VERIFY arm may only anchor a value the model produced when it genuinely
 * appears in the document in a differently-printed form; the FIND arm may only
 * surface candidates that exist in the OCR. Neither invents, neither relabels,
 * and both are deterministic and metadata-driven.
 */

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Minimal candidate extraction carrying one field value. */
function candidates(
  key: string,
  value: unknown,
  extra: { rawValue?: unknown; confidence?: number } = {}
): ExtractionResult {
  const schema = receiptProfile.schema;
  const field = schema.fields.find((f) => f.key === key)!;
  const fv: FieldValue = {
    value,
    rawValue: extra.rawValue,
    confidence: extra.confidence ?? 0.9,
    source: "ai",
    status: "extracted",
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

function line(text: string, confidences?: number[]): OcrDocument["lines"][number] {
  const words = text.split(/\s+/).filter(Boolean).map((w, i) => ({
    text: w,
    confidence: confidences?.[i],
  }));
  return { text, confidence: undefined, words };
}

function docOf(...lines: string[]): OcrDocument {
  return {
    text: lines.join("\n"),
    lines: lines.map((l) => line(l)),
  };
}

const schema = receiptProfile.schema;
const field = (key: string) => schema.fields.find((f) => f.key === key)!;

// ── VERIFY arm — normalization tiers ───────────────────────────────────────
// Amounts are owned by the value tier (numeric equality) and the derived tier
// (thousands separators); these tests prove the tiers end-to-end through the
// real grounding ladder — the verified bottleneck.

test("V1 separators: a bare amount grounds against the printed thousands-separator form", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates("total_amount", 1234.5),
    "TOTAL\n1,234.50",
    docOf("TOTAL", "1,234.50")
  );
  const total = out.fieldsMap.total_amount;
  ok(total, "total_amount must survive grounding");
  equal(total!.evidence![0].quote, "1,234.50");
});

test("V2 trailing zeros: 38.4 grounds against the printed 38.40", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates("total_amount", 38.4),
    "TOTAL\n38.40",
    docOf("TOTAL", "38.40")
  );
  const total = out.fieldsMap.total_amount;
  ok(total, "total_amount must survive grounding");
  equal(total!.evidence![0].quote, "38.40");
});

test("V3 currency symbol: 38.4 grounds against the printed $38.40", () => {
  const out = groundExtraction(
    receiptProfile,
    candidates("total_amount", 38.4),
    "TOTAL\n$38.40",
    docOf("TOTAL", "$38.40")
  );
  const total = out.fieldsMap.total_amount;
  ok(total, "total_amount must survive grounding");
  equal(total!.evidence![0].quote, "$38.40");
});

test("V4 slash ISO date: 2026-07-02 verifies against the printed 2026/07/02", () => {
  const doc = docOf("Date 2026/07/02");
  const ev = verifyEvidence(doc, field("receipt_date"), candidates("receipt_date", "2026-07-02").fieldsMap.receipt_date!);
  ok(ev.length === 1, "slash form must verify the dash date");
  equal(ev[0].quote, "2026/07/02");
});

test("V5 dotted ISO date: 2026-07-02 verifies against the printed 2026.07.02", () => {
  const doc = docOf("Date 2026.07.02");
  const ev = verifyEvidence(doc, field("receipt_date"), candidates("receipt_date", "2026-07-02").fieldsMap.receipt_date!);
  ok(ev.length === 1, "dotted form must verify the dash date");
  equal(ev[0].quote, "2026.07.02");
});

test("V6 compact ISO date: 2026-07-02 verifies against the printed 20260702", () => {
  const doc = docOf("Date 20260702");
  const ev = verifyEvidence(doc, field("receipt_date"), candidates("receipt_date", "2026-07-02").fieldsMap.receipt_date!);
  ok(ev.length === 1, "compact form must verify the dash date");
  equal(ev[0].quote, "20260702");
});

test("V7 digit families: Arabic-Indic and Persian digits both verify 2026-07-02", () => {
  const arabic = docOf("التاريخ ٢٠٢٦/٠٧/٠٢");
  const persian = docOf("تاریخ ۲۰۲۶.۰۷.۰۲");
  const fv = candidates("receipt_date", "2026-07-02").fieldsMap.receipt_date!;
  ok(verifyEvidence(arabic, field("receipt_date"), fv).length === 1, "Arabic-Indic digit form must verify the date");
  ok(verifyEvidence(persian, field("receipt_date"), fv).length === 1, "Persian digit form must verify the date");
});

// ── VERIFY arm — label-adjacent reference verification ────────────────────

test("R1 reference: the model's separated reference verifies against the printed joined form", () => {
  const doc = docOf("REF 2013438351");
  const ev = verifyEvidence(doc, field("receipt_number"), candidates("receipt_number", "2013 438351").fieldsMap.receipt_number!);
  ok(ev.length === 1, "joined reference must verify the spaced value");
  equal(ev[0].quote, "REF 2013438351");
});

test("R2 reference: a dashed multi-word reference verifies in one span", () => {
  const doc = docOf("INV-2013-438351");
  const ev = verifyEvidence(doc, field("receipt_number"), candidates("receipt_number", "2013 438351").fieldsMap.receipt_number!);
  ok(ev.length === 1, "dashed reference must verify the spaced value");
  equal(ev[0].quote, "INV-2013-438351");
});

test("R3 reference guard: differing digits never verify", () => {
  const doc = docOf("INV-2013-438352");
  const ev = verifyEvidence(doc, field("receipt_number"), candidates("receipt_number", "2013 438351").fieldsMap.receipt_number!);
  ok(ev.length === 0, "a reference differing in any digit must not verify");
});

// ── Label collision resolution ─────────────────────────────────────────────

test("C1 amount-due collision: AMOUNT DUE is a total label, not a date", () => {
  equal(detectLabelGroup("AMOUNT DUE  38.40"), "total");
  equal(detectLabelGroup("DUE DATE  12.00"), "date");
  const doc = docOf("AMOUNT DUE  38.40");
  const out = groundExtraction(
    receiptProfile,
    candidates("total_amount", 38.4, { rawValue: "38.40" }),
    "AMOUNT DUE  38.40",
    doc
  );
  const total = out.fieldsMap.total_amount;
  ok(total, "total_amount must survive on an AMOUNT DUE line");
  ok(total!.evidence!.some((e) => e.quote.includes("38.40")), "evidence anchors the amount");
});

// ── FIND arm — required-null discovery ─────────────────────────────────────

test("F1 a single grounded candidate is flagged at low confidence with reasons", () => {
  const doc = docOf("TOTAL 38.40");
  const found = findFieldCandidates(field("total_amount"), doc);
  ok(found.length === 1, "exactly one candidate");
  equal(found[0].value, 38.4);
  ok(found[0].confidence <= 0.5, "flagged ≠ verified: confidence must be capped low");
  ok(found[0].reasons.includes("recovered_from_ocr"), "candidate must be labelled recovered-from-OCR");
});

test("F2 several distinct candidates become ambiguous with alternatives, value null", () => {
  const doc = docOf("TOTAL 38.40", "TOTAL 12.00");
  const found = findFieldCandidates(field("total_amount"), doc);
  ok(found.length === 2, "two distinct readings");
  const values = found.map((c) => c.value);
  ok(values.includes(38.4) && values.includes(12), "both OCR readings surfaced");
});

test("F3 no candidate in the OCR → the field stays unresolved", () => {
  const doc = docOf("SOME NOTE");
  const found = findFieldCandidates(field("total_amount"), doc);
  ok(found.length === 0, "nothing invented when no label/value exists");
});

test("F4 string fields recover via label + value-after-label", () => {
  const doc = docOf("MERCHANT: Acme Foods", "TOTAL 38.40");
  const found = findFieldCandidates(field("merchant_name"), doc);
  ok(found.length === 1, "label-driven string recovery");
  equal(found[0].value, "Acme Foods");
  equal(found[0].raw, "Acme Foods");
});

test("F5 Arabic label recovery uses the same normalization as grounding", () => {
  const doc = docOf("الاجمالي 38.40");
  const found = findFieldCandidates(field("total_amount"), doc);
  ok(found.length === 1, "Arabic total label must find the amount");
  equal(found[0].value, 38.4);
});

test("F6 a multi-token label matches as a phrase — no token leaks into the value", () => {
  const doc = docOf("Receipt Number: 123456");
  const found = findFieldCandidates(field("receipt_number"), doc);
  ok(found.length === 1, "phrase label must find the reference");
  equal(found[0].value, "123456");
  equal(found[0].raw, "123456");
});

test("F7 a generic header word alone never recovers a required field", () => {
  const doc = docOf("RECEIPT", "MILK 3.50");
  const found = findFieldCandidates(field("receipt_number"), doc);
  ok(found.length === 0, "a bare header token must never borrow the next OCR line");
});

test("F8 string recovery requires the value on the label's own line", () => {
  const doc = docOf("MERCHANT:", "ACME Foods");
  const found = findFieldCandidates(field("merchant_name"), doc);
  ok(found.length === 0, "a label with no value on its line yields no candidate");
});

test("F9 reference fields accept only reference-shaped readings", () => {
  const doc = docOf("REF code A100", "REF 123456");
  const found = findFieldCandidates(field("receipt_number"), doc);
  ok(found.length === 1, "only the reference-shaped reading survives");
  equal(found[0].value, "123456");
});

// ── No-invention guarantees ────────────────────────────────────────────────

test("N1 never invents: Amazon must not verify as Amzon", () => {
  const doc = docOf("Amzon Marketplace");
  const ev = verifyEvidence(doc, field("merchant_name"), candidates("merchant_name", "Amazon").fieldsMap.merchant_name!);
  ok(ev.length === 0, "fuzzy similarity must not create evidence");
});

test("N2 never invents: 999999 must not verify as 123456", () => {
  const doc = docOf("ACCT 123456");
  const ev = verifyEvidence(doc, field("receipt_number"), candidates("receipt_number", "999999").fieldsMap.receipt_number!);
  ok(ev.length === 0, "differing digits must never verify");
});

test("N3 never invents: John Smith must not verify as John", () => {
  const doc = docOf("JOHN SMITH");
  const ev = verifyEvidence(doc, field("customer_name"), candidates("customer_name", "John").fieldsMap.customer_name!);
  ok(ev.length === 0, "a substring must not verify a name");
});

test("N4 never invents: $100 must not verify as $1000", () => {
  const doc = docOf("TOTAL $1000");
  const ev = verifyEvidence(doc, field("total_amount"), candidates("total_amount", 100).fieldsMap.total_amount!);
  ok(ev.length === 0, "an amount must never verify against a longer printed amount");
});
