/**
 * Unified before/after benchmark snapshot for the extraction-quality milestone.
 *
 * Measures the CURRENT production pipeline end to end over the whole corpus and
 * writes a single JSON snapshot with every metric the milestone tracks:
 *
 *   OCR accuracy            — ground-truth substring hit rate + page/line conf
 *   Extraction accuracy     — field-level ground-truth hit rate
 *   Required-field recall   — pipeline validation + GT-based recall
 *   Precision               — correct / (correct + wrong) on GT-judged fields
 *   False positives         — GT-judged fields that extracted a wrong value
 *   Confidence calibration  — mean confidence of correct vs wrong fields
 *   Runtime                 — OCR ms + pipeline ms per item and in aggregate
 *   Agent grounding quality — real-provider Q1/Q2 answers against the new
 *                             structured context (optional, --no-agent to skip)
 *
 * The runner is deterministic and identical for the "before" and "after" runs,
 * so the two snapshots differ only because the pipeline changed:
 *
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/run-snapshot.ts --out benchmark-before.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { recognizeMainThread as newRecognize } from "@/lib/tesseract-main";
import { runPipeline } from "@/lib/pipeline/defaults";
import type { RunJobOutput } from "@/lib/pipeline/types";
import type { StructuredDocument } from "@/lib/pipeline/structured-document";
import { buildAgentDocumentContext } from "@/lib/agent/document-context";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { getProviderManager } from "@/lib/ai/manager";
import { buildCorpus, scoreText } from "./corpus";
import type { CorpusItem } from "./corpus";

// ─── CLI ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith("--out="));
const outFile = outArg ? outArg.split("=")[1] : "benchmark-before.json";
const noAgent = argv.includes("--no-agent");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1].split(",") : null;

// Load .env (real providers for the pipeline and agent).
const envPath = new URL("../../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

// ─── Per-item ground truth (field level) ───────────────────────────────────

interface Check {
  key: string;
  label: string;
  match: (v: unknown) => boolean;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function contains(needle: string): (v: unknown) => boolean {
  return (v) => str(v).toUpperCase().includes(needle.toUpperCase());
}

function num(expect: number): (v: unknown) => boolean {
  return (v) => {
    const n = Number(str(v).replace(/[,،\s]/g, ""));
    return Number.isFinite(n) && Math.abs(n - expect) < 0.01;
  };
}

function date(expect: string): (v: unknown) => boolean {
  return (v) => str(v).replace(/\//g, "-").includes(expect) || str(v).includes(expect);
}

const FIELD_GT: Record<string, Check[]> = {
  "en-clean": [
    { key: "merchant_name", label: "merchant = AL RABIH", match: contains("RABIH") },
    { key: "total_amount", label: "total = 38.40", match: num(38.4) },
    { key: "receipt_date", label: "date = 2025-01-15", match: date("2025-01-15") },
    { key: "receipt_number", label: "receipt_number present", match: (v) => str(v).length > 0 },
  ],
  "en-lowcontrast": [
    { key: "merchant_name", label: "merchant = AL RABIH", match: contains("RABIH") },
    { key: "total_amount", label: "total = 38.40", match: num(38.4) },
    { key: "receipt_date", label: "date = 2025-01-15", match: date("2025-01-15") },
  ],
  "en-rot90": [],
  "en-slant2": [],
  "scan-blur": [
    { key: "merchant_name", label: "merchant = AL RABIH", match: contains("RABIH") },
    { key: "total_amount", label: "total = 38.40", match: num(38.4) },
    { key: "receipt_date", label: "date = 2025-01-15", match: date("2025-01-15") },
  ],
  "ar-thermal": [
    { key: "total_amount", label: "total = 45.50", match: num(45.5) },
    { key: "receipt_date", label: "date = 2025-01-15", match: date("2025-01-15") },
    { key: "merchant_name", label: "merchant non-empty", match: (v) => str(v).length > 0 },
    { key: "currency", label: "currency = SAR", match: contains("SAR") },
  ],
  "real-superpay": [
    { key: "total_amount", label: "total = 68.38", match: num(68.38) },
    { key: "receipt_date", label: "date = 2026-07-02", match: date("2026-07-02") },
    { key: "pos_number", label: "account = 391003452", match: contains("391003452") },
    { key: "customer_name", label: "customer = Zahra Aman", match: contains("Zahra") },
    { key: "receipt_number", label: "ref = 2013438351", match: contains("2013438351") },
    { key: "merchant_name", label: "merchant = SuperPay", match: contains("SUPERPAY") },
  ],
  "invoice-clean": [
    { key: "invoice_number", label: "invoice no = INV-2026-014", match: contains("INV-2026-014") },
    { key: "invoice_date", label: "issue date = 2026-02-14", match: date("2026-02-14") },
    { key: "due_date", label: "due date = 2026-03-14", match: date("2026-03-14") },
    { key: "seller_name", label: "seller = ACME CONSULTING", match: contains("ACME") },
    { key: "buyer_name", label: "buyer = KIM & SONS", match: contains("KIM") },
    { key: "subtotal", label: "subtotal = 150.00", match: num(150) },
    { key: "tax_amount", label: "VAT = 5.25", match: num(5.25) },
    { key: "total_amount", label: "total = 155.25", match: num(155.25) },
    { key: "currency", label: "currency = SAR", match: contains("SAR") },
  ],
  "contract-1pg": [
    { key: "contract_title", label: "title = SERVICE AGREEMENT", match: contains("SERVICE AGREEMENT") },
    { key: "contract_date", label: "contract date (signing or effective)", match: (v) => date("2025-02-20")(v) || date("2025-03-01")(v) },
    { key: "effective_date", label: "effective = 2025-03-01", match: date("2025-03-01") },
    { key: "expiry_date", label: "expiry = 2026-03-01", match: date("2026-03-01") },
    { key: "party_a_name", label: "party A = NOVATEL", match: contains("NOVATEL") },
    { key: "party_b_name", label: "party B = KIM & SONS", match: contains("KIM") },
    { key: "contract_value", label: "value = 14,400", match: num(14400) },
    { key: "currency", label: "currency = SAR", match: contains("SAR") },
  ],
};

// ─── Sample summarization ──────────────────────────────────────────────────

interface FieldSample {
  key: string;
  value: unknown;
  raw: unknown;
  status: string;
  confidence: number;
  reasons?: string[];
  evidence?: Array<{ quote: string; confidence?: number }>;
}

function summarizeOutput(out: RunJobOutput, ms: number) {
  const job = out.job;
  const traceById: Record<string, unknown> = {};
  for (const t of out.trace) {
    if (t.event === "finish" && t.data !== undefined) traceById[t.stage] = t.data;
  }
  return {
    ms,
    status: out.status,
    classification: job
      ? { profileType: job.classification.profileType, confidence: job.classification.confidence, source: job.classification.source }
      : null,
    validation: job
      ? { ok: job.validation.ok, missing: job.validation.missing, results: job.validation.results.length }
      : null,
    confidence: job ? { overall: job.confidence.overall, signals: { ...job.confidence.signals } } : null,
    fields: (job?.extraction.fields ?? []).map((f) => ({
      key: f.field.key,
      value: f.value.value,
      raw: f.value.rawValue ?? null,
      status: f.value.status,
      confidence: f.value.confidence,
      reasons: f.value.reasons,
      evidence: f.value.evidence?.map((e) => ({ quote: e.quote, confidence: e.confidence })),
    })),
    trace: traceById,
    error: out.error ?? null,
  };
}

const PROFILE_LABEL: Record<string, string> = { invoice: "Invoice", receipt: "Receipt", contract: "Contract", resume: "Resume", unknown: "Document" };

function structuredFromSample(sample: ReturnType<typeof summarizeOutput>): StructuredDocument | null {
  if (!sample.classification || !sample.validation) return null;
  return {
    profileType: sample.classification.profileType,
    profileLabel: PROFILE_LABEL[sample.classification.profileType] ?? sample.classification.profileType,
    overallConfidence: sample.confidence?.overall ?? 0,
    extractedAt: new Date().toISOString(),
    fields: sample.fields.map((f) => ({
      key: f.key,
      label: f.key.replace(/_/g, " "),
      value: f.value,
      rawValue: f.raw,
      confidence: f.confidence,
      source: "ai",
      status: f.status,
      evidence: f.evidence,
      reasons: f.reasons,
    })),
    dropped: sample.validation.missing.map((k) => ({ key: k, reason: "not found in document" })),
  };
}

// ─── Scoring ───────────────────────────────────────────────────────────────

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  return s.length > 0 && s !== "null" && s !== "[]";
}

function scoreFields(sample: ReturnType<typeof summarizeOutput>, item: CorpusItem) {
  const checks = FIELD_GT[item.id] ?? [];
  const map = new Map(sample.fields.map((f) => [f.key, f]));
  const detail = checks.map((c) => {
    const f = map.get(c.key);
    const ok = !!f && c.match(f.value);
    return { key: c.key, label: c.label, ok, value: f?.value ?? null, status: f?.status ?? "missing", confidence: f?.confidence ?? 0 };
  });
  const correct = detail.filter((d) => d.ok).length;
  const wrong = detail.filter((d) => !d.ok && d.status !== "missing").length;
  const missing = detail.filter((d) => d.status === "missing").length;
  const extracted = map.get("total_amount"); // unused, kept for clarity
  void extracted;
  const extraExtracted = sample.fields
    .filter((f) => isPresent(f.value) && !checks.some((c) => c.key === f.key))
    .map((f) => f.key);
  return {
    checks: detail,
    total: checks.length,
    correct,
    wrong,
    missing,
    recall: checks.length > 0 ? correct / checks.length : undefined,
    precision: correct + wrong > 0 ? correct / (correct + wrong) : undefined,
    falsePositives: wrong,
    extraExtracted,
  };
}

// ─── Agent grounding ───────────────────────────────────────────────────────

const AGENT_GT: Record<string, { total: RegExp; date: RegExp }> = {
  "en-clean": { total: /38[.,]?40/, date: /2025-01-15/ },
  "en-lowcontrast": { total: /38[.,]?40/, date: /2025-01-15/ },
  "scan-blur": { total: /38[.,]?40/, date: /2025-01-15/ },
  "ar-thermal": { total: /45[.,]?50/, date: /2025-01-15/ },
  "real-superpay": { total: /68[.,]?38/, date: /2026-07-02|02[-/]07[-/]2026/ },
  "invoice-clean": { total: /155[.,]?25/, date: /2026-02-14/ },
  "contract-1pg": { total: /14[.,]?400/, date: /2025-03-01/ },
};

async function askAgent(systemPrompt: string, q: string): Promise<{ answer: string; model: string }> {
  const manager = getProviderManager();
  const r = await manager.chatCompletion({
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: q }],
    maxTokens: 500,
    temperature: 0,
  });
  return { answer: r.content ?? "", model: r.model ?? "unknown" };
}

async function agentEval(item: CorpusItem, ocrText: string, sample: ReturnType<typeof summarizeOutput>) {
  const gt = AGENT_GT[item.id];
  if (!gt) return null;
  const structured = structuredFromSample(sample);
  const row = structured
    ? { title: `${item.id}.png`, parsed_content: ocrText, structured_content: structured }
    : { title: `${item.id}.png`, parsed_content: ocrText };
  const ctx = buildAgentDocumentContext([row]);
  const systemPrompt = buildSystemPrompt("agent") + `\n\n## Provided Context:\n${ctx.context}`;
  try {
    const a1 = await askAgent(systemPrompt, "What kind of document is this? What was the total amount and on what date?");
    const a2 = await askAgent(systemPrompt, "Can you see the image of the document? Describe what it looks like and how confident you are in the extracted values.");
    return {
      q1: {
        answer: a1.answer,
        model: a1.model,
        totalFound: gt.total.test(a1.answer),
        dateFound: gt.date.test(a1.answer),
        typeFound: /receipt|invoice|contract|agreement|إيصال|فاتورة|عقد/i.test(a1.answer),
      },
      q2: {
        answer: a2.answer,
        model: a2.model,
        claimsImage: /i can (see|view) the image|the image (shows|displays)|in the image/i.test(a2.answer),
        refuses: /i (can|do not) (see|view) an image|cannot see the image|no image|i'm sorry/i.test(a2.answer) && !/based on|from the extracted|structured|ocr text/i.test(a2.answer),
      },
    };
  } catch (err) {
    console.warn(`  agent eval failed for ${item.id}: ${(err as Error).message}`);
    return { q1: null, q2: null, error: (err as Error).message };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

const corpus = await buildCorpus();
mkdirSync("benchmarks/results", { recursive: true });

const gitCommit = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

interface SnapshotItem {
  ocr: { lines: number; chars: number; pageConf?: number; meanLineConf?: number; distinctConfs: number; hits: number; total: number; detail: Array<{ key: string; label: string; found: boolean }>; ms: number; text: string };
  pipeline: ReturnType<typeof summarizeOutput>;
  score: ReturnType<typeof scoreFields>;
  agent: Awaited<ReturnType<typeof agentEval>>;
}

const items: Record<string, SnapshotItem> = {};

for (const item of corpus) {
  if (only && !only.includes(item.id)) continue;
  console.log(`\n=== ${item.id} — ${item.label} ===`);

  const t0 = performance.now();
  const doc = await newRecognize(item.buffer, "eng+ara", { preprocess: true });
  const ocrMs = Math.round(performance.now() - t0);
  const confs = doc.lines.map((l) => l.confidence).filter((c): c is number => typeof c === "number");
  const scoredOcr = scoreText(doc.text, item);
  const ocr = {
    lines: doc.lines.length,
    chars: doc.text.replace(/\s+/g, "").length,
    pageConf: doc.confidence,
    meanLineConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined,
    distinctConfs: new Set(confs.map((c) => c.toFixed(3))).size,
    hits: scoredOcr.hits,
    total: scoredOcr.total,
    detail: scoredOcr.detail,
    ms: ocrMs,
    text: doc.text,
  };
  console.log(`  [ocr] lines=${ocr.lines} chars=${ocr.chars} pageConf=${(ocr.pageConf ?? 0).toFixed(3)} hits=${ocr.hits}/${ocr.total} ${ocr.ms}ms`);

  const t1 = performance.now();
  const out = await runPipeline({ sourceText: doc.text, ocr: doc }, {});
  const pipelineMs = Math.round(performance.now() - t1);
  const sample = summarizeOutput(out, pipelineMs);
  const score = scoreFields(sample, item);
  console.log(
    `  [pipe] ${sample.status} ${sample.classification?.profileType ?? "?"}/${pct(sample.classification?.confidence ?? 0)} validation=${sample.validation?.ok} score=${score.correct}/${score.total} conf=${pct(sample.confidence?.overall ?? 0)} ${pipelineMs}ms`
  );

  const agent = noAgent ? null : await agentEval(item, doc.text, sample);

  items[item.id] = { ocr, pipeline: sample, score, agent };
}

// ─── Aggregates ────────────────────────────────────────────────────────────

const aggOcr = { gtHits: 0, gtTotal: 0, pages: 0, pageConfSum: 0, lineConfSum: 0, lineConfCount: 0, msSum: 0 };
const aggExt = { correct: 0, wrong: 0, missing: 0, checked: 0, extra: 0, msSum: 0 };
const aggVal = { validItems: 0, totalItems: 0, missing: {} as Record<string, number> };
const calib = { correctConf: 0, correctCount: 0, wrongConf: 0, wrongCount: 0 };
const aggAgent = { answered: 0, totalFound: 0, dateFound: 0, typeFound: 0, claimsImage: 0, refuses: 0, models: new Set<string>() };

for (const item of corpus) {
  const s = items[item.id];
  if (!s) continue;
  aggOcr.gtHits += s.ocr.hits;
  aggOcr.gtTotal += s.ocr.total;
  aggOcr.pages += 1;
  if (s.ocr.pageConf !== undefined) aggOcr.pageConfSum += s.ocr.pageConf;
  if (s.ocr.meanLineConf !== undefined) {
    aggOcr.lineConfSum += s.ocr.meanLineConf;
    aggOcr.lineConfCount += 1;
  }
  aggOcr.msSum += s.ocr.ms;

  aggExt.correct += s.score.correct;
  aggExt.wrong += s.score.wrong;
  aggExt.missing += s.score.missing;
  aggExt.checked += s.score.total;
  aggExt.extra += s.score.extraExtracted.length;
  aggExt.msSum += s.pipeline.ms;

  if (s.pipeline.validation) {
    aggVal.totalItems += 1;
    if (s.pipeline.validation.ok) aggVal.validItems += 1;
    for (const k of s.pipeline.validation.missing) aggVal.missing[k] = (aggVal.missing[k] ?? 0) + 1;
  }

  for (const c of s.score.checks) {
    if (c.ok) {
      calib.correctConf += c.confidence;
      calib.correctCount += 1;
    } else if (c.status !== "missing") {
      calib.wrongConf += c.confidence;
      calib.wrongCount += 1;
    }
  }

  if (s.agent && s.agent.q1) {
    aggAgent.answered += 1;
    aggAgent.totalFound += s.agent.q1.totalFound ? 1 : 0;
    aggAgent.dateFound += s.agent.q1.dateFound ? 1 : 0;
    aggAgent.typeFound += s.agent.q1.typeFound ? 1 : 0;
    aggAgent.models.add(s.agent.q1.model);
  }
  if (s.agent && s.agent.q2) {
    aggAgent.claimsImage += s.agent.q2.claimsImage ? 1 : 0;
    aggAgent.refuses += s.agent.q2.refuses ? 1 : 0;
    aggAgent.models.add(s.agent.q2.model);
  }
}

const snapshot = {
  meta: {
    generatedAt: new Date().toISOString(),
    gitHead: gitCommit,
    engine: "new (production)",
    preprocess: true,
    corpusVersion: "v2",
    agentEval: !noAgent,
    pipeline: "current production pipeline (stages: classify → extract → ground → recover → validate → confidence)",
    changesApplied: ["A1 types (bbox/evidence/alternatives)", "A2 ocr per-word bbox", "A3 text-quality module (unused yet)"],
  },
  corpus: corpus.map((c) => ({ id: c.id, label: c.label, groundTruthLabels: c.groundTruthLabels })),
  items,
  aggregates: {
    ocr: {
      gtAccuracy: aggOcr.gtTotal > 0 ? aggOcr.gtHits / aggOcr.gtTotal : undefined,
      gtHits: aggOcr.gtHits,
      gtTotal: aggOcr.gtTotal,
      meanPageConf: aggOcr.pages > 0 ? aggOcr.pageConfSum / aggOcr.pages : undefined,
      meanLineConf: aggOcr.lineConfCount > 0 ? aggOcr.lineConfSum / aggOcr.lineConfCount : undefined,
      totalMs: aggOcr.msSum,
      meanMs: aggOcr.pages > 0 ? aggOcr.msSum / aggOcr.pages : undefined,
    },
    extraction: {
      accuracy: aggExt.checked > 0 ? aggExt.correct / aggExt.checked : undefined,
      recall: aggExt.checked > 0 ? aggExt.correct / aggExt.checked : undefined,
      precision: aggExt.correct + aggExt.wrong > 0 ? aggExt.correct / (aggExt.correct + aggExt.wrong) : undefined,
      correct: aggExt.correct,
      wrong: aggExt.wrong,
      missing: aggExt.missing,
      falsePositives: aggExt.wrong,
      checked: aggExt.checked,
      extraExtracted: aggExt.extra,
      totalMs: aggExt.msSum,
      meanMs: aggExt.msSum / aggVal.totalItems,
    },
    validation: {
      validItems: aggVal.validItems,
      totalItems: aggVal.totalItems,
      requiredFieldRecall: aggVal.totalItems > 0 ? aggVal.validItems / aggVal.totalItems : undefined,
      missingByField: aggVal.missing,
    },
    calibration: {
      meanConfCorrect: calib.correctCount > 0 ? calib.correctConf / calib.correctCount : undefined,
      meanConfWrong: calib.wrongCount > 0 ? calib.wrongConf / calib.wrongCount : undefined,
      correctCount: calib.correctCount,
      wrongCount: calib.wrongCount,
      gap: calib.correctCount > 0 && calib.wrongCount > 0 ? calib.correctConf / calib.correctCount - calib.wrongConf / calib.wrongCount : undefined,
    },
    runtime: {
      meanOcrMs: aggOcr.pages > 0 ? aggOcr.msSum / aggOcr.pages : undefined,
      meanPipelineMs: aggVal.totalItems > 0 ? aggExt.msSum / aggVal.totalItems : undefined,
      totalMs: aggOcr.msSum + aggExt.msSum,
    },
    agent: noAgent
      ? null
      : {
          answered: aggAgent.answered,
          totalFound: aggAgent.totalFound,
          dateFound: aggAgent.dateFound,
          typeFound: aggAgent.typeFound,
          claimsImage: aggAgent.claimsImage,
          refuses: aggAgent.refuses,
          models: [...aggAgent.models],
        },
  },
};

writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
console.log(`\nWrote ${outFile}`);
console.log(`OCR GT accuracy: ${pct(snapshot.aggregates.ocr.gtAccuracy ?? 0)}`);
console.log(`Extraction accuracy: ${pct(snapshot.aggregates.extraction.accuracy ?? 0)}`);
console.log(`Precision: ${pct(snapshot.aggregates.extraction.precision ?? 0)}`);
console.log(`Validation (required-field) recall: ${pct(snapshot.aggregates.validation.requiredFieldRecall ?? 0)}`);
console.log(`Calibration gap (correct − wrong): ${(snapshot.aggregates.calibration.gap ?? 0).toFixed(3)}`);
console.log(`Runtime: OCR ${snapshot.aggregates.runtime.meanOcrMs}ms, pipeline ${snapshot.aggregates.runtime.meanPipelineMs}ms`);

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
