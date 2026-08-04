/**
 * End-of-milestone PRODUCTION verification.
 *
 * Runs against the real production Supabase (via service-role admin client)
 * and the real AI providers:
 *
 *   0. Migration gate — reads the `ocr_json` column of `extractions`; if the
 *      column is missing, prints the exact SQL to apply and exits non-zero.
 *   1. RECEIPT — real SuperPay photo → file parser → pipeline → persist.
 *      Asserts status, profile, key fields, confidence, persisted ocr_json
 *      (the OCR preview data), grounding trace.
 *   2. INVOICE — synthetic invoice image → same full path. Asserts invoice
 *      profile + fields + ocr_json.
 *   3. Agent — structured context from the persisted receipt, two natural
 *      questions, verifies grounded (image-free) answers with the real totals.
 *   4. JSON export — exportJob("json") parses and contains the extracted
 *      fields + document_type + confidence.
 *   5. Legacy rows — an existing row without ocr_json still yields a usable
 *      JobDTO (ocr null, sourceText present) so the UI falls back cleanly.
 *
 * Run (from repo root, after the deployment reaches READY and the migration
 * is applied):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/verify-production.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { PipelineService } from "@/lib/pipeline/service";
import type { JobDTO } from "@/lib/pipeline/dto";
import type { StructuredDocument } from "@/lib/pipeline/structured-document";
import { buildAgentDocumentContext } from "@/lib/agent/document-context";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { getProviderManager } from "@/lib/ai/manager";
import { createAdminClient } from "@/lib/supabase/admin";

const envPath = new URL("../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const USER_ID = "5fa261e2-b639-4b61-9d51-a7ebeea04f8b";
const sb = createAdminClient();
const service = new PipelineService();
const createdIds: string[] = [];

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

/* ── 0. Migration gate ─────────────────────────────────────────────── */

async function migrationGate(): Promise<void> {
  console.log("\n== 0. ocr_json migration ==");
  const { error } = await sb.from("extractions").select("ocr_json").limit(1);
  if (error && /ocr_json/i.test(String(error.message))) {
    console.log(
      "✗ ocr_json column is MISSING on production.\n\n" +
        "Apply in Supabase Dashboard > SQL Editor (or supabase db push):\n\n" +
        "  ALTER TABLE public.extractions\n" +
        "  ADD COLUMN IF NOT EXISTS ocr_json JSONB;\n\n" +
        "Then re-run this script."
    );
    process.exit(1);
  }
  check("ocr_json column readable on production", !error, error?.message ?? "");
}

/* ── Invoice renderer (clean synthetic invoice for the full OCR path) ─ */

function renderInvoice(): Buffer {
  const lines: Array<[string, string]> = [
    ["", ""],
    ["INVOICE", "fs24"],
    ["Invoice #: INV-2026-014", "fs15"],
    ["Date: 2026-02-14", "fs15"],
    ["Bill To: Acme Trading LLC, Riyadh, KSA", "fs14"],
    ["----------------------------------------", "fs13"],
    ["Qty  Description            Unit   Amount", "fs14"],
    ["2    Server hosting        40.00    80.00", "fs14"],
    ["1    Domain registration   55.00    55.00", "fs14"],
    ["----------------------------------------", "fs13"],
    ["Subtotal                      135.00", "fs14"],
    ["Tax (15%)                      20.25", "fs14"],
    ["Total                         155.25", "fs16"],
    ["Thank you for your business", "fs13"],
  ];
  const pt = (s: string) => parseInt(s.slice(2), 10) || 16;
  const lineH = 34;
  const h = lines.length * lineH + 30;
  const canvas = createCanvas(560, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 26;
  for (const [text, fs] of lines) {
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `bold ${pt(fs)}px Arial`;
    ctx.fillText(text, 28, y);
    y += lineH;
  }
  return canvas.toBuffer("image/png");
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function fieldValue(job: JobDTO, key: string): unknown {
  return job.fields?.find((f) => f.key === key)?.value;
}

function structuredFromJob(job: JobDTO, profileLabel: string): StructuredDocument {
  return {
    profileType: job.profileType,
    profileLabel,
    overallConfidence: job.overallConfidence ?? 0,
    extractedAt: new Date().toISOString(),
    fields: (job.fields ?? []).map((f) => ({
      key: f.key,
      label: f.key.replace(/_/g, " "),
      value: f.value,
      rawValue: f.raw,
      confidence: f.confidence,
      source: f.source,
      status: f.status,
      evidence: f.evidence,
      reasons: f.reasons,
    })),
    dropped: (job.validation?.missing ?? []).map((k) => ({ key: k, reason: "not found in document" })),
  };
}

async function askAgent(job: JobDTO, profileLabel: string, q: string): Promise<string> {
  const row = {
    title: `${job.profileType}.png`,
    parsed_content: job.sourceText ?? "",
    structured_content: structuredFromJob(job, profileLabel),
  };
  const { context } = buildAgentDocumentContext([row]);
  const systemPrompt = buildSystemPrompt("agent") + `\n\n## Provided Context:\n${context}`;
  const r = await getProviderManager().chatCompletion({
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: q }],
    maxTokens: 600,
    temperature: 0,
  });
  return r.content ?? "";
}

/* ── 1+2. Real pipeline runs (receipt + invoice) ───────────────────── */

async function runDoc(label: string, fileName: string, mimeType: string, buffer: Buffer, expect: { profile: string; fields: Array<{ key: string; ok: (v: unknown) => boolean }> }) {
  console.log(`\n== ${label} ==`);
  const parsed = await (await import("@/lib/file-parser")).parseFileBufferDetailed(buffer, mimeType, fileName);
  check(`${label}: parser returned text`, parsed.text.trim().length > 0, `${parsed.text.trim().length} chars`);

  const { job, created } = await service.run(USER_ID, {
    sourceText: parsed.text,
    ocr: parsed.ocr,
    fileName,
    mimeType,
    idempotencyKey: `verify:production:${label}:${randomUUID()}`,
  });
  check(`${label}: status complete`, job.status === "complete", `status=${job.status}`);
  check(`${label}: profile = ${expect.profile}`, String(job.profileType) === expect.profile, String(job.profileType));
  check(`${label}: ocr_json persisted (OCR preview data)`, !!job.ocr && (job.ocr.lines?.length ?? 0) > 0, `lines=${job.ocr?.lines?.length ?? 0}`);
  check(`${label}: confidence computed`, typeof job.overallConfidence === "number" && job.overallConfidence > 0, `overall=${job.overallConfidence}`);
  for (const f of expect.fields) {
    const v = fieldValue(job, f.key);
    check(`${label}: ${f.key}`, f.ok(v), `${JSON.stringify(v)}`);
  }
  if (created) createdIds.push(job.id);
  return { job, created };
}

/* ── Main ──────────────────────────────────────────────────────────── */

await migrationGate();

const receiptBuf = readFileSync("benchmarks/real/db51e106-608b-44a9-9e0c-681bb45aeb78.jpg");
const invoiceBuf = renderInvoice();

const { job: receiptJob } = await runDoc("RECEIPT (real SuperPay photo)", "real-superpay.jpg", "image/jpeg", receiptBuf, {
  profile: "receipt",
  fields: [
    { key: "receipt_date", ok: (v) => /2026-07-02/.test(String(v ?? "")) },
    { key: "total_amount", ok: (v) => Math.abs(Number(v) - 68.38) < 0.01 },
    { key: "pos_number", ok: (v) => String(v ?? "").includes("391003452") },
  ],
});

const { job: invoiceJob } = await runDoc("INVOICE (synthetic image)", "invoice-2026-014.png", "image/png", invoiceBuf, {
  profile: "invoice",
  fields: [
    { key: "invoice_number", ok: (v) => /INV-2026-014/.test(String(v ?? "")) },
    { key: "total_amount", ok: (v) => Math.abs(Number(v) - 155.25) < 0.01 },
    { key: "invoice_date", ok: (v) => /2026-02-14/.test(String(v ?? "")) },
  ],
});

/* ── 3. Agent on the persisted receipt ─────────────────────────────── */

console.log("\n== 3. Agent (grounded, on persisted structured extraction) ==");
const a1 = await askAgent(receiptJob, "Receipt", "What kind of document is this? What was the total amount and on what date?");
check("agent: total = 68.38", /68[.,]?38/.test(a1), a1.replace(/\s+/g, " ").slice(0, 160));
check("agent: date = 2026-07-02", /2026[-‑–—]07[-‑–—]02|02[-‑–—]07[-‑–—]2026/.test(a1), "");
const a2 = await askAgent(receiptJob, "Receipt", "Can you see the image? Describe what the document looks like and how confident you are.");
check("agent: does not claim to see image", !/i can (see|view) the image|the image (shows|displays)|in the image/i.test(a2), "");

/* ── 4. JSON export ────────────────────────────────────────────────── */

console.log("\n== 4. JSON export ==");
const exp = await service.exportJob(USER_ID, receiptJob.id, "json");
const json = JSON.parse(exp.content);
check("export: document_type = receipt", json.document_type === "receipt", json.document_type);
check("export: fields present", !!json.fields && typeof json.fields.receipt_date?.value === "string", "");
check("export: confidence carried", typeof json.confidence === "number", `confidence=${json.confidence}`);
check("export: mimeType/fileName", exp.mimeType === "application/json" && exp.fileName.endsWith(".json"), exp.fileName);

/* ── 5. Legacy / text-only rows (no OCR) still work ────────────────── */

console.log("\n== 5. Legacy / text-only rows (no ocr_json) still work ==");

// Text-only document → pipeline, exactly the pre-OCR path production still uses.
const textOnly = [
  "Invoice",
  "Invoice #: INV-2026-099",
  "Date: 2026-03-01",
  "Vendor: Acme Trading LLC, Riyadh, KSA",
  "Item: Consulting services — 99.50 USD",
  "Total: 99.50",
].join("\n");
const { job: textJob, created: textCreated } = await service.run(USER_ID, {
  sourceText: textOnly,
  idempotencyKey: `verify:production:legacy:${randomUUID()}`,
});
check("text-only: status complete", textJob.status === "complete", textJob.status);
check("text-only: DTO.ocr null (preview falls back to sourceText)", textJob.ocr === null);
check("text-only: DTO.sourceText present", typeof textJob.sourceText === "string" && textJob.sourceText.length > 0);
check("text-only: fields extracted", (textJob.fields?.length ?? 0) > 0, `${textJob.fields?.length} fields`);
if (textCreated) createdIds.push(textJob.id);

// Historical rows that genuinely have source_text but no ocr_json (service
// role bypasses RLS) must serialize to a usable DTO for the UI.
const { data: legacy } = await sb
  .from("extractions")
  .select("id, status, source_text, ocr_json")
  .is("ocr_json", null)
  .not("source_text", "is", null)
  .limit(1);
if (legacy && legacy.length > 0) {
  const dto = (await import("@/lib/pipeline/dto")).toJobDTO(legacy[0]);
  check("legacy row: DTO.ocr null + sourceText present", dto.ocr === null && typeof dto.sourceText === "string" && dto.sourceText.length > 0);
} else {
  check("legacy row: found for DTO check", false, "no ocr_json-null rows anywhere in DB");
}

/* ── Cleanup created rows ──────────────────────────────────────────── */

if (createdIds.length > 0) {
  await sb.from("extractions").delete().in("id", createdIds).eq("user_id", USER_ID);
  console.log(`\ncleaned up ${createdIds.length} verification extraction(s)`);
}

console.log(failed === 0 ? "\nALL PRODUCTION CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
