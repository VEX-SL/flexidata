/**
 * READ-ONLY live verification of the recovery stage on the REAL model:
 *   1. the current SuperPay receipt (prod file, exact stored OCR)
 *   2. an invoice fixture
 *   3. a contract fixture (additional document type)
 * Runs the full pipeline (classify pinned → extract → ground → recover →
 * validate → confidence) with the real provider chain. Nothing is persisted.
 *
 * Expected outcome for the receipt: `total_amount` must no longer be null —
 * either grounded by the model, or (as before) recovered from the OCR and
 * flagged. Any field the model leaves null and recovery cannot anchor is
 * retried on a different provider once.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseFileBufferDetailed } from "@/lib/file-parser";
import { runPipeline } from "@/lib/pipeline/defaults";
import { getProviderManager } from "@/lib/ai/manager";
import type { AIClient } from "@/lib/pipeline/types";
import type { JobResult } from "@/lib/pipeline/types";

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
const EXTRACTION_ID = "bcb15879-e37a-4f14-95e5-e0c41cf5b41c";
const supabase = createAdminClient();

const section = (t: string) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);
const report: Record<string, unknown> = {};

const wrapped: AIClient = {
  chatCompletion: (request) => getProviderManager().chatCompletion(request),
  retryProviders: (request, skipProviders) =>
    getProviderManager().chatCompletion(request, 1, { skipProviders }),
};

function summarize(job: JobResult, label: string): Record<string, unknown> {
  const flagged = job.extraction.fields
    .filter((f) => f.value.status === "flagged")
    .map((f) => ({
      key: f.field.key,
      value: f.value.value,
      raw: f.value.rawValue,
      confidence: f.value.confidence,
      evidence: f.value.evidence?.map((e) => ({ lineIndex: e.lineIndex, quote: e.quote })),
    }));
  const ambiguous = job.extraction.fields
    .filter((f) => f.value.status === "ambiguous")
    .map((f) => ({ key: f.field.key, alternatives: f.value.alternatives }));
  return {
    label,
    profileType: job.extraction.profileType,
    provider: job.extraction.provider,
    model: job.extraction.model,
    overallConfidence: job.confidence.overall,
    validationMissing: job.validation.missing,
    cleanFields: job.extraction.cleanFields,
    flagged,
    ambiguous,
    dropped: job.extraction.droppedFields,
  };
}

async function runCase(label: string, profileType: "receipt" | "invoice" | "contract", sourceText: string, ocr?: object): Promise<void> {
  section(`CASE ${label} (${profileType})`);
  const out = await runPipeline(
    { sourceText, profileType, ocr: ocr as never },
    { ai: wrapped }
  );
  if (out.status !== "complete" || !out.job) {
    console.log("  status:", out.status, JSON.stringify(out.error));
    report[label] = { status: out.status, error: out.error };
    return;
  }
  const summary = summarize(out.job, label);
  report[label] = summary;
  console.log(JSON.stringify(summary, null, 2));
}

// ── Case 1: the current SuperPay receipt (exact stored OCR + fresh structured OCR) ──
section("CASE receipt — LOAD PROD RECEIPT");
const { data: full } = await supabase
  .from("extractions")
  .select("id, file_id, source_text, profile_type, overall_confidence")
  .eq("id", EXTRACTION_ID)
  .eq("user_id", userId)
  .single();
if (!full) throw new Error(`extraction ${EXTRACTION_ID} not found`);
console.log("stored row:", JSON.stringify({ id: full.id, file_id: full.file_id, profile_type: full.profile_type, prior_overall: full.overall_confidence }));

let receiptOcr: object | undefined;
try {
  const { data: file } = await supabase
    .from("files")
    .select("id, name, url, mime_type, original_name")
    .eq("id", full.file_id)
    .eq("user_id", userId)
    .single();
  const { data: blob } = await supabase.storage.from("files").download(file.name);
  const parsed = await parseFileBufferDetailed(
    Buffer.from(await blob.arrayBuffer()),
    file.mime_type,
    file.original_name
  );
  receiptOcr = parsed.ocr;
  console.log("fresh OCR page confidence:", parsed.ocr?.confidence ?? null, "lines:", parsed.ocr?.lines.length ?? null);
} catch (err) {
  console.log("fresh OCR unavailable, using stored source_text only:", err instanceof Error ? err.message : err);
}

await runCase("receipt (SuperPay)", "receipt", full.source_text ?? "", receiptOcr);

// ── Case 2: invoice fixture ────────────────────────────────────────────────
const INVOICE = `INVOICE
Invoice No: INV-2026-0147
Invoice Date: 2026-07-28
Seller: Acme Industrial Supplies LLC
Buyer: Oasis Retail Group
Subtotal: 500.00
VAT Amount: 75.00
Total: 575.00
Payment Method: Bank Transfer
Bank: First Gulf Bank`;
await runCase("invoice fixture", "invoice", INVOICE);

// ── Case 3: contract fixture (additional document type) ───────────────────
const CONTRACT = `EMPLOYMENT AGREEMENT
Contract Date: 2026-03-01
Party A: Nova Tech Solutions
Party B: Sara Ahmed
Jurisdiction: Dubai, UAE
Contract Value: 120,000.00
Governing Law: UAE Federal Law
Notice Period: 3 months`;
await runCase("contract fixture", "contract", CONTRACT);

const outPath = resolve("C:/Users/dell/AppData/Local/Temp/opencode/verify-recovery.json");
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log(`\n[done] verification report written to ${outPath}`);
