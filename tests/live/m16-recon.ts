/**
 * M16 reconnaissance probe (read-only diagnostic — no production code).
 *
 * Runs the REAL production pipeline (classify -> extract -> ground -> clean ->
 * recover -> validate -> confidence) with a fake AI against a small realistic
 * itemized receipt. Target hypothesis: line_items that are genuinely grounded
 * (each description appears on its own OCR line) are committed with NO
 * evidence, a false `no_direct_evidence` reason and an unfair NO_EVIDENCE
 * penalty, because the grounding `line_items` branch short-circuits (`continue`)
 * before the evidence search. The clean stage re-grounds the descriptions and
 * throws the anchors away.
 */
import { runPipeline } from "@/lib/pipeline/defaults";
import type { AIClient } from "@/lib/pipeline/types";

const SOURCE =
  "CORNER STORE\nRECEIPT\nMILK 3.50\nBREAD 2.00\nTOTAL 5.50\nDate: 2025-01-15";

function fakeAI(data: Record<string, unknown>): AIClient {
  return {
    chatCompletion: async () => ({
      content: JSON.stringify({ data }),
      model: "fake",
      provider: "test",
    }),
  };
}

const candidateSet: Record<string, unknown> = {
  merchant_name: { raw: "CORNER STORE", value: "CORNER STORE", confidence: 0.9 },
  total_amount: { raw: "5.50", value: 5.5, confidence: 0.9 },
  receipt_date: { raw: "2025-01-15", value: "2025-01-15", confidence: 0.9 },
  line_items: {
    raw: "MILK 3.50\nBREAD 2.00",
    value: [
      { description: "MILK", quantity: 1, unit_price: 3.5, amount: 3.5 },
      { description: "BREAD", quantity: 1, unit_price: 2, amount: 2 },
    ],
    confidence: 0.9,
  },
};

const out = await runPipeline(
  { sourceText: SOURCE, profileType: "receipt" },
  { ai: fakeAI(candidateSet) }
);

if (out.status !== "complete") {
  console.error("pipeline failed:", out.error);
  process.exit(1);
}

const { extraction } = out.job;

console.log("=== M16 recon — full production path (itemized receipt) ===");
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

const items = extraction.fieldsMap.line_items;
console.log("\n=== line_items verdict ===");
if (items) {
  console.log(
    `SURVIVES with ${(items.value as unknown[]).length} item(s), ` +
      `evidence=[${(items.evidence ?? [])
        .map((e) => `L${e.lineIndex} "${e.quote}"`)
        .join(", ")}], ` +
      `reasons=[${(items.reasons ?? []).join(", ")}], conf=${items.confidence?.toFixed(4)}`
  );
  const hasNoDirect = (items.reasons ?? []).includes("no_direct_evidence");
  const hasEvidence = (items.evidence ?? []).length > 0;
  if (hasNoDirect && !hasEvidence) {
    console.log("\nDEFECT PROVEN: grounded line_items carry no evidence + false no_direct_evidence");
  } else {
    console.log("\nline_items carry evidence; defect not present");
  }
} else {
  console.log("line_items dropped:", extraction.droppedFields.line_items);
}
