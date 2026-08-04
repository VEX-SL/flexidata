/**
 * Pipeline-level before/after benchmark.
 *
 * For every corpus item, feeds the OLD-engine OCR text (sourceText only — the
 * pre-milestone production path) and the NEW-engine OCR document (sourceText +
 * structured ocr) through the real pipeline with real AI providers, then
 * records classification, extracted fields (value/raw/status/confidence/
 * reasons/evidence), validation, overall confidence + signals, recovery/
 * ground trace summaries and timing.
 *
 * Run (from repo root):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/run-pipeline-level.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { recognizeMainThread as oldRecognize } from "../_engines/old-tesseract";
import { recognizeMainThread as newRecognize } from "@/lib/tesseract-main";
import { runPipeline } from "@/lib/pipeline/defaults";
import type { RunJobOutput, RunJobInput } from "@/lib/pipeline/types";
import { buildCorpus } from "./corpus";
import type { CorpusItem } from "./corpus";

// Load .env into process.env (like the live verification scripts).
const envPath = new URL("../../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

interface PipelineSample {
  ms: number;
  status: string;
  classification: { profileType: string; confidence: number; source: string };
  validation: { ok: boolean; missing: string[] };
  confidence: { overall: number; signals: Record<string, number> };
  fields: Array<{
    key: string;
    value: unknown;
    raw: unknown;
    status: string;
    confidence: number;
    reasons: string[] | undefined;
    evidence: Array<{ quote: string; confidence?: number }> | undefined;
  }>;
  trace: {
    extract?: unknown;
    ground?: unknown;
    recover?: unknown;
    validate?: unknown;
    confidence?: unknown;
  };
  error?: unknown;
}

function summarizeOutput(out: RunJobOutput, ms: number): PipelineSample {
  const job = out.job;
  const traceById: PipelineSample["trace"] = {};
  for (const t of out.trace) {
    if (t.event === "finish" && t.data !== undefined) traceById[t.stage as keyof PipelineSample["trace"]] = t.data;
  }
  return {
    ms,
    status: out.status,
    classification: job
      ? { profileType: job.classification.profileType, confidence: job.classification.confidence, source: job.classification.source }
      : { profileType: "error", confidence: 0, source: "error" },
    validation: job ? { ok: job.validation.ok, missing: job.validation.missing } : { ok: false, missing: [] },
    confidence: job
      ? { overall: job.confidence.overall, signals: { ...job.confidence.signals } }
      : { overall: 0, signals: {} },
    fields: job
      ? job.extraction.fields.map((f) => ({
          key: f.field.key,
          value: f.value.value,
          raw: f.value.rawValue ?? null,
          status: f.value.status,
          confidence: f.value.confidence,
          reasons: f.value.reasons,
          evidence: f.value.evidence?.map((e) => ({ quote: e.quote, confidence: e.confidence })),
        }))
      : [],
    trace: traceById,
    error: out.error,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Field-level ground truth: key → list of acceptable matches (numeric tolerant).
const FIELD_GT: Record<string, Array<{ key: string; match: (v: unknown) => boolean; label: string }>> = {
  "en-clean": [
    { key: "merchant_name", label: "merchant = AL RABIH", match: (v) => String(v ?? "").toUpperCase().includes("RABIH") },
    { key: "total_amount", label: "total = 38.40", match: (v) => Math.abs(Number(v) - 38.4) < 0.01 },
    { key: "receipt_date", label: "date = 2025-01-15", match: (v) => String(v ?? "").includes("2025-01-15") },
    { key: "receipt_number", label: "receipt_number present", match: (v) => !!v && String(v).trim().length > 0 },
  ],
  "en-lowcontrast": [
    { key: "merchant_name", label: "merchant = AL RABIH", match: (v) => String(v ?? "").toUpperCase().includes("RABIH") },
    { key: "total_amount", label: "total = 38.40", match: (v) => Math.abs(Number(v) - 38.4) < 0.01 },
    { key: "receipt_date", label: "date = 2025-01-15", match: (v) => String(v ?? "").includes("2025-01-15") },
  ],
  "en-rot90": [],
  "en-slant2": [],
  "ar-thermal": [
    { key: "total_amount", label: "total = 45.50", match: (v) => Math.abs(Number(v) - 45.5) < 0.01 },
    { key: "receipt_date", label: "date = 2025-01-15", match: (v) => String(v ?? "").includes("2025-01-15") },
    { key: "merchant_name", label: "merchant non-empty", match: (v) => !!v && String(v).trim().length > 0 },
  ],
  "real-superpay": [
    { key: "total_amount", label: "total = 68.38", match: (v) => Math.abs(Number(v) - 68.38) < 0.01 },
    { key: "receipt_date", label: "date = 2026-07-02", match: (v) => /2026-07-02|2026\/07\/02/.test(String(v ?? "")) },
    { key: "merchant_name", label: "merchant contains SuperPay", match: (v) => String(v ?? "").toUpperCase().includes("SUPERPAY") },
  ],
};

function scoreFields(sample: PipelineSample, item: CorpusItem): { hits: number; total: number; detail: Array<{ label: string; ok: boolean; value: unknown }> } {
  const checks = FIELD_GT[item.id] ?? [];
  const map = new Map(sample.fields.map((f) => [f.key, f.value]));
  const detail = checks.map((c) => ({ label: c.label, ok: c.match(map.get(c.key)), value: map.get(c.key) }));
  return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

async function runOne(label: string, item: CorpusItem, input: RunJobInput): Promise<PipelineSample> {
  const t0 = performance.now();
  const out = await runPipeline(input, {});
  const ms = Math.round(performance.now() - t0);
  const sample = summarizeOutput(out, ms);
  const scored = scoreFields(sample, item);
  const requiredPresent = sample.fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== "").length;
  console.log(
    `  [${label}] ${sample.status} ${sample.classification.profileType}/${pct(sample.classification.confidence)} fields=${sample.fields.length}(present=${requiredPresent}) validation=${sample.validation.ok} score=${scored.hits}/${scored.total} conf=${pct(sample.confidence.overall)} ${ms}ms`
  );
  console.log(
    `    flags: ${sample.fields.filter((f) => f.status === "flagged").map((f) => f.key).join(",") || "-"}  ambiguous: ${sample.fields.filter((f) => f.status === "ambiguous").map((f) => f.key).join(",") || "-"}`
  );
  if (sample.trace.recover) console.log(`    recover: ${JSON.stringify(sample.trace.recover)}`);
  if (sample.trace.ground) console.log(`    ground: ${JSON.stringify(sample.trace.ground)}`);
  return sample;
}

const corpus = await buildCorpus();
mkdirSync("benchmarks/results", { recursive: true });

const results: Record<string, { old?: PipelineSample; new?: PipelineSample; scoreOld?: { hits: number; total: number; detail: unknown[] }; scoreNew?: { hits: number; total: number; detail: unknown[] } }> = {};

for (const item of corpus) {
  console.log(`\n=== ${item.id} — ${item.label} ===`);
  const oldDoc = await oldRecognize(item.buffer, "eng+ara");
  const newDoc = await newRecognize(item.buffer, "eng+ara", { preprocess: true });

  const oldSample = await runOne("old", item, { sourceText: oldDoc.text });
  const newSample = await runOne("new", item, { sourceText: newDoc.text, ocr: newDoc });

  results[item.id] = {
    old: oldSample,
    new: newSample,
    scoreOld: scoreFields(oldSample, item),
    scoreNew: scoreFields(newSample, item),
  };
}

writeFileSync(
  "benchmarks/results/pipeline-level.json",
  JSON.stringify(
    {
      corpusMeta: corpus.map((c) => ({ id: c.id, label: c.label, groundTruth: c.groundTruth })),
      results,
    },
    null,
    2
  )
);
console.log("\nWrote benchmarks/results/pipeline-level.json");
