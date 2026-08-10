/**
 * M14 production-path probe (read-only diagnostic — no production code).
 *
 * Runs the REAL production pipeline (`runPipeline` = classify → extract →
 * ground → clean → recover → validate → confidence) with a fake AI against
 * the real 24-line SuperPay OCR fixture to confirm which hallucinated values
 * actually survive end-to-end in production:
 *
 *   A. Hallucinated CLEAN notes absent from the document.
 *   B. Fabricated 2-item line_items list absent from the document.
 *   C. tax_id value absent from the document while a tax keyword IS present
 *      (TARGET — the clean stage re-verifies notes/line_items against OCR but
 *      never re-verifies *_tax_id values).
 *   D. Baseline: real fields from the full fixture.
 */
import { runPipeline } from "@/lib/pipeline/defaults";
import type { AIClient } from "@/lib/pipeline/types";
import { SUPERYPAY_RECEIPT_OCR } from "../../tests/fixtures/receipt-ocr.ts";

const section = (t: string) => console.log(`\n=== ${t} ===`);

function fakeAI(data: Record<string, unknown>): AIClient {
  return {
    chatCompletion: async () => ({
      content: JSON.stringify({ data }),
      model: "fake",
      provider: "test",
    }),
  };
}

async function run(data: Record<string, unknown>, sourceText: string = SUPERYPAY_RECEIPT_OCR) {
  const out = await runPipeline(
    { sourceText, profileType: "receipt" },
    { ai: fakeAI(data) }
  );
  return out.status === "complete" ? out.job.extraction : null;
}

section("PROD A — hallucinated clean notes absent from document");
{
  const extraction = await run({
    merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9 },
    total_amount: { raw: "68.38", value: 68.38, confidence: 0.9 },
    notes: { raw: "Thank you for shopping", value: "Thank you for shopping", confidence: 0.9 },
  });
  console.log(`notes = ${extraction?.fieldsMap.notes ? "SURVIVED" : "DROPPED"} :: ${extraction?.droppedFields.notes ?? "—"}`);
}

section("PROD B — fabricated 2-item list absent from document");
{
  const extraction = await run({
    merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9 },
    total_amount: { raw: "68.38", value: 68.38, confidence: 0.9 },
    line_items: [
      { description: "Quantum Widget 9000", quantity: 1, unit_price: 99.99, amount: 99.99 },
      { description: "Holographic Cable", quantity: 2, unit_price: 10.0, amount: 20.0 },
    ],
  });
  console.log(`line_items = ${extraction?.fieldsMap.line_items ? "SURVIVED" : "DROPPED"} :: ${extraction?.droppedFields.line_items ?? "—"}`);
}

section("PROD C — tax_id value absent, tax keyword present (TARGET)");
{
  const srcWithTax = SUPERYPAY_RECEIPT_OCR + "\nالرقم الضريبي : 1234567890000003";
  const extraction = await run({
    merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9 },
    total_amount: { raw: "68.38", value: 68.38, confidence: 0.9 },
    merchant_tax_id: { raw: "9999999999999999", value: "9999999999999999", confidence: 0.9 },
  }, srcWithTax);
  console.log(`merchant_tax_id = ${extraction?.fieldsMap.merchant_tax_id ? "SURVIVED (BUG)" : "DROPPED"} :: ${extraction?.droppedFields.merchant_tax_id ?? "—"}`);
}

section("PROD D — baseline real fields (full 24-line fixture)");
{
  const extraction = await run({
    receipt_number: { raw: "2013438351", value: "2013438351", confidence: 0.9 },
    merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9 },
    customer_name: { raw: "Zahra Aman", value: "Zahra Aman", confidence: 0.9 },
    total_amount: { raw: "68.38", value: 68.38, confidence: 0.9 },
    pos_number: { raw: "391803452", value: "391803452", confidence: 0.9 },
  });
  for (const key of ["receipt_number", "merchant_name", "customer_name", "total_amount", "pos_number"]) {
    const fv = extraction?.fieldsMap[key];
    console.log(`${key}: ${fv ? `OK value=${JSON.stringify(fv.value)} conf=${fv.confidence?.toFixed(4)} evidence=[${(fv.evidence ?? []).map((e) => `L${e.lineIndex}:${e.quote}`).join(", ")}]` : `DROPPED (${extraction?.droppedFields[key]})`}`);
  }
}
