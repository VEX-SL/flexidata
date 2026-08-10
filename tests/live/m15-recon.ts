/**
 * M15 reconnaissance probe (read-only diagnostic — no production code).
 *
 * Runs the REAL production pipeline (classify → extract → ground → clean →
 * recover → validate → confidence) with a fake AI against the real 24-line
 * SuperPay OCR fixture, returning a realistic COMPLETE candidate set.
 *
 * Target hypothesis: committed free-text / array fields that the model got
 * right (value verbatim in the OCR) still carry NO evidence and the reason
 * `no_direct_evidence`, because the grounding notes branch short-circuits
 * before the evidence search. The clean stage then re-grounds them internally
 * and throws the anchor away. Final output contradicts its own proof.
 */
import { runPipeline } from "@/lib/pipeline/defaults";
import type { AIClient } from "@/lib/pipeline/types";
import { SUPERYPAY_RECEIPT_OCR } from "../../tests/fixtures/receipt-ocr.ts";

function fakeAI(data: Record<string, unknown>): AIClient {
  return {
    chatCompletion: async () => ({
      content: JSON.stringify({ data }),
      model: "fake",
      provider: "test",
    }),
  };
}

const fullCandidateSet: Record<string, unknown> = {
  receipt_number: { raw: "2013438351", value: "2013438351", confidence: 0.9 },
  receipt_date: { raw: "02-07-2028", value: "2028-07-02", confidence: 0.9 },
  merchant_name: { raw: "SuperPay", value: "SuperPay", confidence: 0.9 },
  customer_name: { raw: "Zahra Aman", value: "Zahra Aman", confidence: 0.9 },
  total_amount: { raw: "68.38", value: 68.38, confidence: 0.9 },
  pos_number: { raw: "391803452", value: "391803452", confidence: 0.9 },
  notes: { raw: "عملية ناجحة", value: "عملية ناجحة", confidence: 0.9 },
};

const out = await runPipeline(
  { sourceText: SUPERYPAY_RECEIPT_OCR, profileType: "receipt" },
  { ai: fakeAI(fullCandidateSet) }
);

if (out.status !== "complete") {
  console.error("pipeline failed:", out.error);
  process.exit(1);
}

const { extraction, confidence } = out.job;

console.log("=== M15 recon — full production path (real fixture) ===");
for (const nf of extraction.fields) {
  const v = nf.value;
  const ev = (v.evidence ?? [])
    .map((e) => `L${e.lineIndex} [${e.role}] "${e.quote}"`)
    .join(" | ");
  console.log(
    `${nf.field.key}: value=${JSON.stringify(v.value)} conf=${v.confidence?.toFixed(4)} ` +
      `reasons=[${(v.reasons ?? []).join(", ")}] evidence=${ev || "(none)"}`
  );
}

console.log("\n=== dropped ===");
for (const [k, r] of Object.entries(extraction.droppedFields)) {
  console.log(`${k}: ${r}`);
}

console.log("\n=== overall confidence ===");
console.log(
  `overall=${confidence.overall.toFixed(4)} ` +
    `signals.evidence=${confidence.signals.evidence.toFixed(4)} ` +
    `signals.extraction=${confidence.signals.extraction.toFixed(4)}`
);

const notes = extraction.fieldsMap.notes;
console.log("\n=== notes verdict ===");
if (notes) {
  console.log(
    `SURVIVES with evidence=${JSON.stringify(notes.evidence)} reasons=[${(notes.reasons ?? []).join(", ")}]`
  );
} else {
  console.log(`DROPPED :: ${extraction.droppedFields.notes}`);
}
