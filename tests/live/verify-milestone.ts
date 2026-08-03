import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PipelineService } from "@/lib/pipeline/service";
import { classifyDocument } from "@/lib/pipeline/classifier";
import { toStructuredDocument } from "@/lib/pipeline/structured-document";
import { buildAgentDocumentContext } from "@/lib/agent/document-context";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { getProviderManager } from "@/lib/ai/manager";
import { createAdminClient } from "@/lib/supabase/admin";
import { SUPERYPAY_RECEIPT_OCR } from "../fixtures/receipt-ocr.ts";

const envPath = new URL("../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const userId = "5fa261e2-b639-4b61-9d51-a7ebeea04f8b";
const service = new PipelineService();

console.log("== 1. classifier (real AI) ==");
const classification = await classifyDocument(SUPERYPAY_RECEIPT_OCR);
console.log(
  JSON.stringify(
    { profileType: classification.profileType, confidence: classification.confidence, source: classification.source, reasons: classification.reasons },
    null,
    2
  )
);

console.log("\n== 2. full pipeline run (real AI, persisted like /documents) ==");
const { job, created } = await service.run(userId, {
  sourceText: SUPERYPAY_RECEIPT_OCR,
  idempotencyKey: `verify:milestone:${randomUUID()}`,
});

const fieldView = (job.fields ?? []).map((f: any) => ({
  key: f.key,
  value: f.value,
  raw: f.raw,
  status: f.status,
  confidence: f.confidence,
  reasons: f.reasons ?? null,
}));
console.log(
  JSON.stringify(
    {
      id: job.id,
      status: job.status,
      profileType: job.profileType,
      validationOk: job.validation?.ok ?? null,
      missing: job.validation?.missing ?? null,
      overallConfidence: job.overallConfidence,
      confidenceSummary: job.confidence?.summary ?? null,
      fileUrl: job.fileUrl ?? null,
      hasOcr: !!job.ocr,
      fields: fieldView,
    },
    null,
    2
  )
);

console.log("\n== 3. agent context rendering (real extraction) ==");
const row = { title: "photo_2026-08-02_12-59-10.jpg", parsed_content: SUPERYPAY_RECEIPT_OCR, structured_content: null as any };
const out = await (async () => {
  // Rebuild the pipeline output in memory to serialize the Structured Document.
  const { runPipeline } = await import("@/lib/pipeline/defaults");
  return runPipeline({ sourceText: SUPERYPAY_RECEIPT_OCR }, {});
})();
const structured = toStructuredDocument(out);
row.structured_content = structured;
const { context } = buildAgentDocumentContext([row]);
console.log(context.slice(0, 4000));

console.log("\n== 4. real agent chat (natural questions) ==");
const systemPrompt = buildSystemPrompt("agent") + `\n\n## Provided Context:\n${context}`;
const manager = getProviderManager();

async function ask(q: string) {
  const r = await manager.chatCompletion({
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: q }],
    maxTokens: 700,
    temperature: 0,
  });
  console.log(`\nQ: ${q}\nA[${r.model}]:\n${r.content}`);
}

await ask("What did I buy, what was the total, and what's the receipt number?");
await ask("Can you see the image? Describe what the document looks like and how confident you are.");

if (created) {
  await createAdminClient()
    .from("extractions")
    .delete()
    .eq("id", job.id)
    .eq("user_id", userId);
  console.log(`\ncleaned up new extraction ${job.id}`);
} else {
  console.log("\n(reused an existing extraction row; nothing to clean up)");
}
