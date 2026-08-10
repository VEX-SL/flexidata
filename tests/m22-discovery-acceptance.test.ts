import type { AIClient } from "@/lib/pipeline/types";
import { extractDocument } from "@/lib/pipeline/extractor";
import { buildDynamicPrompt } from "@/lib/pipeline/extractor/prompt-builder";
import { universalGrounding } from "@/lib/pipeline/extractor/grounding";
import { recoverMissingFields } from "@/lib/pipeline/extractor/recovery";
import { validateExtraction } from "@/lib/pipeline/validator";
import { normalizeText } from "@/lib/pipeline/ocr";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { runPipeline } from "@/lib/pipeline/defaults";
import { SUPERYPAY_RECEIPT_OCR as RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";
import { test, ok, equal, assert, includes } from "./harness.ts";

/**
 * M22 — discovery acceptance. Verifies that dynamic mode is genuinely
 * schema-independent DISCOVERY:
 *  - universal grounding is deterministic verbatim-existence proof;
 *  - every accepted value is anchored to a verbatim OCR quote;
 *  - OCR garbage / fabricated values are never accepted;
 *  - independent identifiers are discovered separately, never merged;
 *  - arbitrary documents complete without schema-required failures;
 *  - recovery never re-injects legacy schema fields into a discovery result.
 */

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

function dynamicJSON(fields: Record<string, unknown>): string {
  return JSON.stringify({ data: fields });
}

const receiptProfile = () => getProfileManager().get("receipt")!;

/** Fields a GOOD model discovers on the SuperPay receipt (verbatim anchors). */
const SUPERPAY_FIELDS = {
  "transaction number": {
    raw: "6070218301132167",
    value: "6070218301132167",
    type: "string",
    label: "رقم التمليه",
    confidence: 0.9,
    evidence: "() رقم التمليه : 6070218301132167",
  },
  "account number": {
    raw: "391803452",
    value: "391803452",
    type: "string",
    label: "رقم الحساب",
    confidence: 0.9,
    evidence: "| رقم الحساب : 391803452",
  },
  total: {
    raw: "68.38",
    value: 68.38,
    type: "currency",
    label: "المطلوب",
    confidence: 0.9,
    evidence: "gla المطلوب : 68.38 ;",
  },
};

/* ─── Universal grounding: deterministic verbatim-existence proof ──────── */

test("universalGrounding proves a verbatim quote from one OCR line", () => {
  const brand = universalGrounding("له SuperPay 60", RECEIPT_OCR);
  equal(brand.grounded, true);
  equal(brand.matchedLine, 1);
  equal(brand.quote, "له SuperPay 60");

  const receipt = universalGrounding(
    "() رقم التمليه : 6070218301132167",
    RECEIPT_OCR
  );
  ok(receipt.grounded, "full-line receipt quote must ground");
  equal(receipt.matchedLine, 5);

  const total = universalGrounding("gla المطلوب : 68.38 ;", RECEIPT_OCR);
  ok(total.grounded, "full-line total quote must ground");
  equal(total.matchedLine, 15);
});

test("universalGrounding rejects OCR-garbage quotes that are not verbatim", () => {
  equal(
    universalGrounding("$ 60 SuperPay e&", RECEIPT_OCR).grounded,
    false,
    "garbage quote '60 SuperPay e&' must never ground"
  );
  equal(
    universalGrounding("60 SuperPay eX", RECEIPT_OCR).grounded,
    false,
    "'60 SuperPay eX' differs from 'له SuperPay 60' and must not ground"
  );
  equal(
    universalGrounding(
      "6070218301132167 391803452",
      RECEIPT_OCR
    ).grounded,
    false,
    "fragments from two different lines must never stitch into one quote"
  );
  equal(universalGrounding("", RECEIPT_OCR).grounded, false);
  equal(universalGrounding("   ", RECEIPT_OCR).grounded, false);
});

test("universalGrounding normalizes digits and Arabic variants deterministically", () => {
  // Arabic-Indic digits unify to Latin, so an alternate spelling of the same
  // reading still proves existence (deterministic, not fuzzy).
  const r = universalGrounding(
    "رقم التمليه : ٦٠٧٠٢١٨٣٠١١٣٢١٦٧",
    RECEIPT_OCR
  );
  ok(r.grounded, "Arabic-Indic digits must unify to the Latin OCR reading");
  const account = universalGrounding("رقم الحساب : 391803452", RECEIPT_OCR);
  ok(account.grounded, "substring quote grounds inside its OCR line");
});

/* ─── SuperPay acceptance: every accepted value is proven by verbatim evidence ─ */

test("SuperPay acceptance: each accepted discovery entity is anchored to a verbatim quote", async () => {
  const profile = receiptProfile();
  const result = await extractDocument(
    { profile, sourceText: RECEIPT_OCR, extractionMode: "dynamic" },
    fakeAI(dynamicJSON(SUPERPAY_FIELDS))
  );

  equal(result.cleanFields.transaction_number, "6070218301132167");
  equal(result.cleanFields.account_number, "391803452");
  equal(result.cleanFields.total, 68.38);

  const receiptEvidence = result.fieldsMap.transaction_number.evidence ?? [];
  ok(receiptEvidence.length > 0, "transaction number has evidence");
  ok(
    receiptEvidence.some((e) => e.quote.includes("6070218301132167")),
    "receipt value has verbatim value evidence"
  );
  ok(
    receiptEvidence.some((e) => e.quote.includes("رقم التمليه")),
    "transaction value anchored to its own label line"
  );

  const accountEvidence = result.fieldsMap.account_number.evidence ?? [];
  ok(
    accountEvidence.some((e) => e.quote.includes("391803452")),
    "account value has verbatim evidence"
  );

  const totalEvidence = result.fieldsMap.total.evidence ?? [];
  ok(
    totalEvidence.some((e) => e.quote.includes("68.38")),
    "total value has verbatim evidence"
  );
  ok(
    totalEvidence.some((e) => e.quote.includes("المطلوب")),
    "total anchored to its own label line"
  );

  // Every evidence quote is itself a verbatim substring of its OCR line.
  for (const evidence of [
    ...receiptEvidence,
    ...accountEvidence,
    ...totalEvidence,
  ]) {
    const line = RECEIPT_OCR.split("\n")[evidence.lineIndex ?? -1] ?? "";
    assert(
      normalizeText(line).includes(normalizeText(evidence.quote)),
      "evidence quote must be a verbatim substring of one OCR line"
    );
  }
});

test("SuperPay acceptance: OCR-garbage is never accepted as a receipt number", async () => {
  const profile = receiptProfile();
  const result = await extractDocument(
    { profile, sourceText: RECEIPT_OCR, extractionMode: "dynamic" },
    fakeAI(
      dynamicJSON({
        "receipt number": {
          raw: "$ 60 SuperPay e&",
          value: "$ 60 SuperPay e&",
          type: "string",
          label: "رقم التمليه",
          confidence: 0.99,
          evidence: "$ 60 SuperPay e&",
        },
      })
    )
  );

  assert(
    !("receipt_number" in result.cleanFields),
    "garbage value must be dropped, never become receipt_number"
  );
  equal(result.droppedFields.receipt_number, "not found in source text");
});

test("SuperPay acceptance: a real value never adopts a non-verbatim evidence quote", async () => {
  const profile = receiptProfile();
  const result = await extractDocument(
    { profile, sourceText: RECEIPT_OCR, extractionMode: "dynamic" },
    fakeAI(
      dynamicJSON({
        "receipt number": {
          raw: "6070218301132167",
          value: "6070218301132167",
          type: "string",
          label: "رقم التمليه",
          confidence: 0.99,
          evidence: "$ 60 SuperPay e&",
        },
      })
    )
  );

  equal(result.cleanFields.receipt_number, "6070218301132167");
  const quotes = (result.fieldsMap.receipt_number.evidence ?? [])
    .map((e) => e.quote)
    .join(" ");
  assert(
    !quotes.includes("e&") && !quotes.includes("$ 60"),
    "the garbage quote must never appear as evidence"
  );
  assert(
    quotes.includes("6070218301132167"),
    "the value stays anchored on the real OCR line"
  );
});

test("SuperPay acceptance: independent identifiers are discovered separately, never merged", async () => {
  const profile = receiptProfile();
  const result = await extractDocument(
    { profile, sourceText: RECEIPT_OCR, extractionMode: "dynamic" },
    fakeAI(
      dynamicJSON({
        "transaction number": {
          raw: "6070218301132167",
          value: "6070218301132167",
          type: "string",
          label: "رقم التمليه",
          confidence: 0.9,
          evidence: "() رقم التمليه : 6070218301132167",
        },
        "account number": {
          raw: "391803452",
          value: "391803452",
          type: "string",
          label: "رقم الحساب",
          confidence: 0.9,
          evidence: "| رقم الحساب : 391803452",
        },
        "reference number": {
          raw: "2013438351",
          value: "2013438351",
          type: "string",
          label: "انرقم المرجقي",
          confidence: 0.9,
          evidence: "B انرقم المرجقي : 2013438351",
        },
        "customer number": {
          raw: "9840833767",
          value: "9840833767",
          type: "string",
          label: "رقم العميل",
          confidence: 0.9,
          evidence: "8[ رقم العميل : 9840833767",
        },
      })
    )
  );

  const ids = [
    "transaction_number",
    "account_number",
    "reference_number",
    "customer_number",
  ];
  for (const key of ids) ok(key in result.cleanFields, `${key} discovered`);
  equal(
    ids.map((k) => result.cleanFields[k]),
    ["6070218301132167", "391803452", "2013438351", "9840833767"]
  );

  const accountQuotes = (result.fieldsMap.account_number.evidence ?? [])
    .map((e) => e.quote)
    .join(" ");
  assert(
    !accountQuotes.includes("6070218301132167"),
    "account evidence must not merge the transaction number"
  );
  const receiptQuotes = (result.fieldsMap.transaction_number.evidence ?? [])
    .map((e) => e.quote)
    .join(" ");
  assert(
    !receiptQuotes.includes("391803452"),
    "transaction evidence must not merge the account number"
  );
});

test("SuperPay acceptance: a grounded quote can never smuggle a fabricated value", async () => {
  const profile = receiptProfile();
  const result = await extractDocument(
    { profile, sourceText: RECEIPT_OCR, extractionMode: "dynamic" },
    fakeAI(
      dynamicJSON({
        discount: {
          raw: "999",
          value: 999,
          type: "number",
          label: "Discount",
          confidence: 0.99,
          evidence: "() رقم التمليه : 6070218301132167",
        },
      })
    )
  );

  assert(
    !("discount" in result.cleanFields),
    "invented value must be dropped even though its evidence quote is verbatim"
  );
  equal(result.droppedFields.discount, "not found in source text");
});

/* ─── Arbitrary document acceptance ─────────────────────────────────────── */

const ARBITRARY_DOC = [
  "Lab Report",
  "Patient: Sara",
  "Hemoglobin: 12.4 g/dL",
  "Doctor: Dr. Khalid",
  "",
].join("\n");

const ARBITRARY_FIELDS = {
  patient: {
    raw: "Sara",
    value: "Sara",
    type: "string",
    label: "Patient",
    confidence: 0.9,
    evidence: "Patient: Sara",
  },
  hemoglobin: {
    raw: "12.4",
    value: "12.4",
    type: "string",
    label: "Hemoglobin",
    confidence: 0.9,
    evidence: "Hemoglobin: 12.4 g/dL",
  },
};

test("arbitrary document discovers its own fields with no schema-required failures", async () => {
  const profile = receiptProfile();
  const result = await extractDocument(
    { profile, sourceText: ARBITRARY_DOC, extractionMode: "dynamic" },
    fakeAI(dynamicJSON(ARBITRARY_FIELDS))
  );

  equal(result.cleanFields.patient, "Sara");
  equal(result.cleanFields.hemoglobin, "12.4");

  const validation = validateExtraction(result);
  equal(validation.ok, true, "no schema-required failure on an arbitrary doc");
  equal(
    validation.missing.length,
    0,
    "receipt required fields must not be reported missing"
  );
});

test("full pipeline on an arbitrary document completes and never re-injects schema keys", async () => {
  const out = await runPipeline(
    { sourceText: ARBITRARY_DOC, profileType: "receipt", extractionMode: "dynamic" },
    { ai: fakeAI(dynamicJSON(ARBITRARY_FIELDS)) }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  const job = out.job!;
  equal(job.validation.ok, true);
  equal(job.validation.missing.length, 0);
  equal(job.extraction.cleanFields.patient, "Sara");
  assert(
    !("receipt_number" in job.extraction.cleanFields),
    "recovery must never re-inject receipt_number into a discovery result"
  );
  assert(
    !("merchant_name" in job.extraction.cleanFields),
    "recovery must never re-inject merchant_name into a discovery result"
  );
});

test("full pipeline in dynamic mode returns the SuperPay discovery result", async () => {
  const out = await runPipeline(
    { sourceText: RECEIPT_OCR, profileType: "receipt", extractionMode: "dynamic" },
    { ai: fakeAI(dynamicJSON(SUPERPAY_FIELDS)) }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  const job = out.job!;
  equal(job.classification.profileType, "receipt");
  equal(job.extraction.cleanFields.transaction_number, "6070218301132167");
  equal(job.extraction.cleanFields.account_number, "391803452");
  equal(job.extraction.cleanFields.total, 68.38);
  equal(job.validation.ok, true);
  equal(job.validation.missing.length, 0);
});

/* ─── Recovery / schema leakage guards ──────────────────────────────────── */

test("recoverMissingFields is a no-op for dynamic extractions", async () => {
  const profile = receiptProfile();
  const empty = await extractDocument(
    { profile, sourceText: RECEIPT_OCR, extractionMode: "dynamic" },
    fakeAI(dynamicJSON({}))
  );

  const recovered = recoverMissingFields(
    profile,
    empty,
    RECEIPT_OCR
  );
  equal(recovered.flagged.size, 0, "no schema fields flagged into discovery");
  equal(recovered.ambiguous.size, 0);
  equal(recovered.candidates.size, 0);
  assert(
    !("receipt_number" in empty.cleanFields),
    "precondition: the SuperPay OCR has no explicit receipt-number marker"
  );
});

test("dynamic prompt for the SuperPay OCR carries no receipt schema", () => {
  const profile = receiptProfile();
  const prompt = buildDynamicPrompt(RECEIPT_OCR);

  includes(prompt, "field discovery");
  includes(prompt, "قوري باي");
  includes(prompt, "Never merge fragments");
  includes(prompt, "Never invent");
  assert(!prompt.includes("{{schema}}"), "no {{schema}} placeholder in the dynamic prompt");
  assert(
    !prompt.includes(JSON.stringify(profile.schema)),
    "receipt schema must never be injected into the dynamic prompt"
  );
  assert(
    !prompt.includes("receipt_number"),
    "no legacy schema key may leak into the dynamic prompt"
  );
});
