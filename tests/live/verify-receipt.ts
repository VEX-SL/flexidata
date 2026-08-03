import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PipelineService } from "@/lib/pipeline/service";
import { classifyDocument } from "@/lib/pipeline/classifier";
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
const fileId = "3c168d34-0873-43b8-b13e-e492abce1ea4";
const idempotencyKey = `verify:receipt:${randomUUID()}`;

const service = new PipelineService();

console.log("== classifier (real AI) ==");
const classification = await classifyDocument(SUPERYPAY_RECEIPT_OCR);
console.log(
  JSON.stringify(
    {
      profileType: classification.profileType,
      confidence: classification.confidence,
      source: classification.source,
      reasons: classification.reasons,
    },
    null,
    2
  )
);

console.log("\n== full pipeline run (real AI, persisted like /documents) ==");
const { job, created } = await service.run(userId, {
  sourceText: SUPERYPAY_RECEIPT_OCR,
  fileId,
  idempotencyKey,
});

console.log(
  JSON.stringify(
    {
      id: job.id,
      status: job.status,
      profileType: job.profileType,
      profileVersion: job.profileVersion,
      validationOk: job.validation?.ok ?? null,
      missing: job.validation?.missing ?? null,
      overallConfidence: job.overallConfidence,
      provider: job.provider,
      model: job.model,
      fields: job.fields,
    },
    null,
    2
  )
);

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
