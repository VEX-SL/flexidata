/**
 * READ-ONLY diagnostic — post-M13 extraction output on the real SuperPay
 * receipt OCR.
 *
 * Reproduces exactly what the production "ground" stage does
 * (`src/lib/pipeline/stages/ground.ts`):
 *   groundExtraction(profile, candidates, sourceText, ocr,
 *                    createLayoutEvidenceProvider(layoutReaderFor(ocr)))
 * and dumps the grounded fieldsMap, evidence, composed confidences and
 * dropped fields. The fixture is the real prod OCR (`tests/fixtures/
 * receipt-ocr.ts`); per-word OCR confidence is 0.768 (the M13 assumption) so
 * the numbers match the documented arithmetic.
 *
 * Run: node --experimental-strip-types --experimental-transform-types
 *   --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs
 *   tests/live/post-m13-extraction-output.ts
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
import { SUPERYPAY_RECEIPT_OCR } from "../fixtures/receipt-ocr.ts";

const AI_CONF = 0.9;
const WORD_CONF = 0.768;

function mkWord(text: string, x: number, y: number): OcrWord {
  return { text, confidence: WORD_CONF, bbox: { x, y, width: 30, height: 12 } };
}

function buildDoc(): OcrDocument {
  const lines = SUPERYPAY_RECEIPT_OCR.split(/\r?\n/);
  const out: OcrLine[] = lines.map((text, li) => {
    const y = li * 16;
    const words = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w, wi) => mkWord(w, wi * 40, y));
    return {
      text,
      originalText: text,
      words,
      bbox: unionBoxes(words.map((w) => w.bbox!))!,
    };
  });
  return { text: SUPERYPAY_RECEIPT_OCR, lines: out };
}

const GROUNDED = JSON.stringify({
  data: {
    receipt_number: { raw: "2013438351", value: "2013438351", confidence: 0.9, evidence: "انرقم المرجقي : 2013438351" },
    receipt_date: { raw: "02-07-2028 18:30:12", value: "2028-07-02", confidence: 0.85, evidence: "تبيخ الوقت : 02-07-2028 18:30:12" },
    merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: AI_CONF, evidence: "له SuperPay 60" },
    customer_name: { raw: "Zahra Aman", value: "Zahra Aman", confidence: 0.85, evidence: "Zahra Aman =" },
    total_amount: { raw: "68.38", value: 68.38, confidence: 0.9, evidence: "العلى : 68.38" },
    pos_number: { raw: "391803452", value: "391803452", confidence: 0.85, evidence: "رقم الحساب : 391803452" },
    notes: { raw: "عملية ناجحة", value: "عملية ناجحة", confidence: 0.8, evidence: "عملية ناجحة" },
  },
});

const profile = getProfileManager().get("receipt")!;
const ocr = buildDoc();
const candidates = candidatesFromAICall(profile, {
  content: GROUNDED,
  model: "diagnostic",
  provider: "test",
});
const provider = createLayoutEvidenceProvider(layoutReaderFor(ocr));
const grounded = groundExtraction(
  profile,
  candidates,
  SUPERYPAY_RECEIPT_OCR,
  ocr,
  provider
);

console.log("\n=== POST-M13 EXTRACTION OUTPUT (real SuperPay OCR, layout path) ===\n");
console.log(`word OCR confidence assumed: ${WORD_CONF}`);
console.log(`drop threshold (MIN_CONFIDENCE): 0.3\n`);

for (const field of profile.schema.fields) {
  const fv = grounded.fieldsMap[field.key];
  if (!fv) continue;
  console.log(`— ${field.key}: "${String(fv.value)}"  confidence=${(fv.confidence ?? 0).toFixed(4)}`);
  if (fv.reasons?.length) console.log(`    reasons: [${fv.reasons.join(", ")}]`);
  for (const e of fv.evidence ?? []) {
    console.log(
      `    evidence line ${e.lineIndex} [${"scope" in e && e.scope}] role=${e.role}` +
        ` conf=${typeof e.confidence === "number" ? e.confidence.toFixed(4) : "—"}` +
        ` quote="${e.quote}"`
    );
  }
}

console.log("\n=== DROPPED FIELDS ===\n");
if (Object.keys(grounded.droppedFields).length === 0) {
  console.log("(none)");
} else {
  for (const [key, reason] of Object.entries(grounded.droppedFields)) {
    console.log(`— ${key}: ${reason}`);
  }
}

const m = grounded.fieldsMap.merchant_name;
console.log("\n=== M13 CHECK: merchant_name ===\n");
console.log(`evidence confidence (combineConfidence of OCR-only line): ${m?.evidence?.[0]?.confidence?.toFixed(4) ?? "?"}`);
console.log(`composed: aiConf ${AI_CONF} × ocrFactor ${(m?.evidence?.[0]?.confidence ?? 0).toFixed(4)} × label 0.8 = ${(m?.confidence ?? 0).toFixed(4)}`);
console.log(`survives grounding: ${m !== undefined} (${(m?.confidence ?? 0) >= 0.3 ? "≥ 0.3" : "DROPPED < 0.3"})`);
