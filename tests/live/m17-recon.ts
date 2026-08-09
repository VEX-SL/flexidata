/**
 * M17 verification probe — runs the REAL production pipeline (classify ->
 * extract -> ground -> clean -> recover -> validate -> confidence) against the
 * M16 itemized fixture and a real-label variant.
 *
 * AFTER this fix:
 *   A) the generic "RECEIPT" header must NOT be recovered as `receipt_number`
 *      (before M17 it became "MILK 3.50" — see M16-COMPLETION-REPORT.md,
 *      secondary finding);
 *   B) a real "Receipt Number: 20134" label must recover "20134" — before M17
 *      the label's own tokens leaked into the value ("number: 20134").
 */
import { runPipeline } from "@/lib/pipeline/defaults";
import type { AIClient } from "@/lib/pipeline/types";

const SOURCE =
  "CORNER STORE\nRECEIPT\nMILK 3.50\nBREAD 2.00\nTOTAL 5.50\nDate: 2025-01-15";
const SOURCE_WITH_LABEL =
  "CORNER STORE\nReceipt Number: 20134\nMILK 3.50\nBREAD 2.00\nTOTAL 5.50\nDate: 2025-01-15";

function fakeAI(data: Record<string, unknown>): AIClient {
  return {
    chatCompletion: async () => ({
      content: JSON.stringify({ data }),
      model: "fake",
      provider: "test",
    }),
  };
}

// The M16 candidate set — the model provides everything EXCEPT receipt_number,
// so the recovery/FIND arm decides what happens to the missing required field.
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

async function probe(title: string, sourceText: string) {
  const out = await runPipeline(
    { sourceText, profileType: "receipt" },
    { ai: fakeAI(candidateSet) }
  );
  if (out.status !== "complete") {
    console.error("pipeline failed:", out.error);
    process.exit(1);
  }
  const { extraction } = out.job;
  const n = extraction.fieldsMap.receipt_number;
  console.log(`=== ${title} ===`);
  if (n) {
    console.log(
      `receipt_number = ${JSON.stringify(n.value)} conf=${n.confidence?.toFixed(4)} ` +
        `source=${n.source} status=${n.status} reasons=[${(n.reasons ?? []).join(", ")}] ` +
        `evidence=[${(n.evidence ?? [])
          .map((e) => `L${e.lineIndex} [${e.role}] "${e.quote}"`)
          .join(", ")}]`
    );
  } else {
    console.log(
      `receipt_number = MISSING (drop: ${extraction.droppedFields.receipt_number ?? "(none)"})`
    );
  }
  console.log(
    `committed fields: ${extraction.fields.map((f) => f.field.key).join(", ")}`
  );
  console.log("");
}

await probe(
  "A) M16 itemized fixture - generic 'RECEIPT' header (before M17: 'MILK 3.50')",
  SOURCE
);
await probe(
  "B) real label 'Receipt Number: 20134' (before M17: 'number: 20134')",
  SOURCE_WITH_LABEL
);
