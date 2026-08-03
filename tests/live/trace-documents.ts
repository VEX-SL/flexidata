import { readFileSync } from "node:fs";
import { PipelineService } from "@/lib/pipeline/service";
import { parseFileBuffer } from "@/lib/file-parser";
import { classifyDocument, scoreByAliases } from "@/lib/pipeline/classifier";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { runPipeline } from "@/lib/pipeline/defaults";
import { defaultAIClient } from "@/lib/pipeline/ai";
import { createAdminClient } from "@/lib/supabase/admin";

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
const fileId = "59330fbd-8978-4f1a-b5fc-bc1d4c82f1a2"; // the exact upload the user re-tested at 12:22 UTC

const supabase = createAdminClient();
const section = (t: string) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);

// ── Step 1: replicate PipelineService.readFileText (real storage + real OCR) ──
section("STEP 1 — FILE READ + REAL OCR (PipelineService.readFileText path)");
const { data: file } = await supabase
  .from("files")
  .select("id, name, url, mime_type, original_name")
  .eq("id", fileId)
  .eq("user_id", userId)
  .single();
console.log("file row:", JSON.stringify(file));
const { data: blob } = await supabase.storage.from("files").download(file.name);
const buffer = Buffer.from(await blob.arrayBuffer());
console.log("downloaded bytes:", buffer.length);
const ocrText = await parseFileBuffer(buffer, file.mime_type, file.original_name);
console.log("\n--- OCR OUTPUT (real tesseract ara+eng) ---\n" + ocrText + "\n--- end OCR ---");

// ── Step 2: rule scores ──
section("STEP 2 — RULE SCORES PER PROFILE (docTypes matched in head 3000)");
for (const p of getProfileManager().candidates()) {
  console.log(`  ${p.id}: ${scoreByAliases(ocrText, p.id)}`);
}

// ── Step 3: raw AI classification (exact classifier.aiClassify prompt) ──
section("STEP 3 — RAW AI CLASSIFICATION (classifier.aiClassify, real model)");
const profiles = getProfileManager().candidates();
const options = profiles.map((p) => p.id).join(", ");
const aiPrompt =
  `Classify this document into exactly one type: ${options}.\n` +
  `Respond with ONLY JSON: {"type": "...", "confidence": 0.0-1.0, "reasons": ["..."]}.\n\n` +
  `Document (first 6000 characters):\n${ocrText.slice(0, 6000)}`;
const aiRaw = await defaultAIClient.chatCompletion({
  messages: [
    { role: "system", content: "You are a document classifier. Reply with ONLY a JSON object, no markdown." },
    { role: "user", content: aiPrompt },
  ],
  maxTokens: 300,
  temperature: 0,
});
console.log("AI raw output:", aiRaw.content);
let aiParsed: any = null;
try {
  const cleaned = aiRaw.content
    .replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1")
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end >= start) aiParsed = JSON.parse(cleaned.slice(start, end + 1));
} catch {}
console.log("AI parsed:", JSON.stringify(aiParsed));

// ── Step 4: final classifier decision (rule-gate applied) ──
section("STEP 4 — FINAL CLASSIFIER DECISION (classifyDocument)");
const classification = await classifyDocument(ocrText);
console.log(
  JSON.stringify(
    { profileType: classification.profileType, confidence: classification.confidence, source: classification.source, reasons: classification.reasons, candidates: classification.candidates },
    null,
    2
  )
);

// ── Step 5: extraction schema loaded ──
section("STEP 5 — EXTRACTION SCHEMA LOADED (profile for selected type)");
const profile = getProfileManager().getOrFallback(classification.profileType);
console.log("profile id:", profile.id, "| version:", profile.version, "| label:", profile.label);
for (const f of profile.schema.fields) {
  console.log(`  ${f.key}  [${f.type}]  ${f.label}${f.required ? "  (required)" : ""}`);
}

// ── Step 6: run the real pipeline (classify → extract → validate → confidence) ──
section("STEP 6 — FULL PIPELINE RUN (runPipeline, real model)");
const out = await runPipeline({ sourceText: ocrText, fileName: file.original_name, mimeType: file.mime_type }, {});
console.log("status:", out.status);
if (out.status === "complete" && out.job) {
  const { classification: cl, extraction, validation, confidence } = out.job;
  console.log("classification:", JSON.stringify({ profileType: cl.profileType, source: cl.source, confidence: cl.confidence, reasons: cl.reasons }));
  console.log("\nprovider/model:", extraction.provider, extraction.model);
  console.log("\nRAW EXTRACTED FIELDS (value / confidence / source):");
  for (const f of extraction.fields) {
    console.log(`  ${f.field.key} = ${JSON.stringify(f.value.value)}  (conf=${f.value.confidence}, src=${f.value.source}, status=${f.value.status})`);
  }
  console.log("\nDROPPED FIELDS:", JSON.stringify(extraction.droppedFields));
  console.log("\nVALIDATION:", JSON.stringify(validation));
  console.log("\nCONFIDENCE:", JSON.stringify(confidence));
  console.log("\nSTAGE TRACE:", JSON.stringify(out.trace, null, 1));
} else {
  console.log("pipeline error:", JSON.stringify(out.error));
}

// ── Step 7: persist through PipelineService exactly like /api/pipeline/run ──
section("STEP 7 — PipelineService.run (exactly what POST /api/pipeline/run does)");
const service = new PipelineService();
const idempotencyKey = `trace-proof:${Date.now()}`;
const { job, created } = await service.run(userId, {
  fileId,
  sourceText: ocrText,
  fileName: file.original_name,
  mimeType: file.mime_type,
  idempotencyKey,
});
console.log("created:", created, "| job id:", job.id);
console.log("\nFINAL JSON SENT TO THE UI (JobDTO):");
console.log(JSON.stringify(job, null, 2));

// ── cleanup: remove only this temp extraction row (never the user's file) ──
await supabase.from("extractions").delete().eq("id", job.id).eq("user_id", userId);
console.log("\n[cleanup] temp extraction row deleted:", job.id);
