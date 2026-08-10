/**
 * M14 reconnaissance probe (read-only diagnostic — no production code).
 *
 * Runs the EXACT production ground path (`groundExtraction` + layout
 * provider) against the real 24-line SuperPay OCR fixture and probes:
 *
 *  1. Does a CLEAN notes value that is NOT present in the document survive
 *     grounding? (expectation per no-invention: must be dropped)
 *  2. Does a line_items array of 2+ entries whose descriptions are NOT in
 *     the document survive? (expectation: must be dropped)
 *  3. Does a tax_id value not present in the document survive on a document
 *     keyword check alone? (expectation: value must be verified)
 *  4. Baseline: real fields grounded correctly on the full fixture.
 */
import { candidatesFromAICall } from "@/lib/pipeline/extractor";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import {
  createLayoutEvidenceProvider,
  layoutReaderFor,
} from "@/lib/extraction/layout-aware-evidence";
import { unionBoxes } from "@/lib/pipeline/geometry";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { SUPERYPAY_RECEIPT_OCR } from "../../tests/fixtures/receipt-ocr.ts";

const WORD_CONF = 0.768;

function mkWord(text: string, x: number, y: number): OcrWord {
  return { text, confidence: WORD_CONF, bbox: { x, y, width: 30, height: 12 } };
}

function buildDoc(): OcrDocument {
  const lines = SUPERYPAY_RECEIPT_OCR.split(/\r?\n/);
  const out: OcrLine[] = lines.map((text, li) => {
    const y = li * 16;
    const words = text.split(/\s+/).filter(Boolean).map((w, wi) => mkWord(w, wi * 40, y));
    return { text, originalText: text, words, bbox: unionBoxes(words.map((w) => w.bbox!))! };
  });
  return { text: SUPERYPAY_RECEIPT_OCR, lines: out };
}

const profile = getProfileManager().get("receipt")!;
const ocr = buildDoc();

function ground(data: Record<string, unknown>): ReturnType<typeof groundExtraction> {
  const candidates = candidatesFromAICall(profile, {
    content: JSON.stringify({ data }),
    model: "probe",
    provider: "test",
  });
  return groundExtraction(
    profile,
    candidates,
    SUPERYPAY_RECEIPT_OCR,
    ocr,
    createLayoutEvidenceProvider(layoutReaderFor(ocr))
  );
}

const section = (t: string) => console.log(`\n=== ${t} ===`);

// 1. Hallucinated clean note: NOT in the document.
section("PROBE 1 — clean note ABSENT from document");
{
  const out = ground( { notes: { raw: "Thank you for shopping", value: "Thank you for shopping", confidence: 0.9 } } );
  console.log(`fieldsMap.notes = ${out.fieldsMap.notes ? JSON.stringify({ value: out.fieldsMap.notes.value, confidence: out.fieldsMap.notes.confidence }) : "DROPPED"}`);
  console.log(`droppedFields.notes = ${JSON.stringify(out.droppedFields.notes ?? "—")}`);
}

// 1b. Legit note PRESENT in document (عملية ناجحة, line 17 of full fixture).
section("PROBE 1b — real note PRESENT in document");
{
  const out = ground( { notes: { raw: "عملية ناجحة", value: "عملية ناجحة", confidence: 0.9 } } );
  const fv = out.fieldsMap.notes;
  console.log(`fieldsMap.notes = ${fv ? JSON.stringify({ value: fv.value, confidence: fv.confidence, evidence: fv.evidence?.map((e) => `L${e.lineIndex}:${e.quote}`) }) : "DROPPED"}`);
  console.log(`droppedFields.notes = ${JSON.stringify(out.droppedFields.notes ?? "—")}`);
}

// 2. Fabricated line items: 2 entries, descriptions absent from the document.
section("PROBE 2 — fabricated 2-item list absent from document");
{
  const out = ground( {
    line_items: [
      { description: "Quantum Widget 9000", quantity: 1, unit_price: 99.99, amount: 99.99 },
      { description: "Holographic Cable", quantity: 2, unit_price: 10.0, amount: 20.0 },
    ],
  } );
  console.log(`fieldsMap.line_items = ${out.fieldsMap.line_items ? "SURVIVED (BUG)" : "DROPPED"}`);
  console.log(`droppedFields.line_items = ${JSON.stringify(out.droppedFields.line_items ?? "—")}`);
}

// 3. tax_id value absent but a tax keyword present elsewhere.
section("PROBE 3 — tax_id value absent, generic tax keyword present");
{
  const srcWithTax = SUPERYPAY_RECEIPT_OCR + "\nالرقم الضريبي : 1234567890000003";
  const candidates = candidatesFromAICall(profile, {
    content: JSON.stringify({ data: { merchant_tax_id: { raw: "9999999999999999", value: "9999999999999999", confidence: 0.9 } } }),
    model: "probe",
    provider: "test",
  });
  const out = groundExtraction(profile, candidates, srcWithTax, ocr, createLayoutEvidenceProvider(layoutReaderFor(ocr)));
  console.log(`fieldsMap.merchant_tax_id = ${out.fieldsMap.merchant_tax_id ? JSON.stringify({ value: out.fieldsMap.merchant_tax_id.value, evidence: out.fieldsMap.merchant_tax_id.evidence?.length }) : "DROPPED"}`);
  console.log(`droppedFields.merchant_tax_id = ${JSON.stringify(out.droppedFields.merchant_tax_id ?? "—")}`);
}

// 4. Baseline: real fields from the full fixture.
section("PROBE 4 — baseline real fields (full 24-line fixture)");
{
  const out = ground({
    receipt_number: { raw: "2013438351", value: "2013438351", confidence: 0.9 },
    merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9 },
    customer_name: { raw: "Zahra Aman", value: "Zahra Aman", confidence: 0.9 },
    total_amount: { raw: "68.38", value: 68.38, confidence: 0.9 },
    pos_number: { raw: "391803452", value: "391803452", confidence: 0.9 },
  });
  for (const key of ["receipt_number", "merchant_name", "customer_name", "total_amount", "pos_number"]) {
    const fv = out.fieldsMap[key];
    console.log(`${key}: ${fv ? `OK value=${fv.value} conf=${fv.confidence?.toFixed(4)} evidence=[${fv.evidence?.map((e) => `L${e.lineIndex}:${e.quote}`).join(", ")}]` : `DROPPED (${out.droppedFields[key]})`}`);
  }
}
