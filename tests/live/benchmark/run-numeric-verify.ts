/**
 * Read-only before/after benchmark: current OCR engine vs OCR + Numeric
 * Verifier, across every corpus fixture (not SuperPay-only).
 *
 * Per fixture: 3 OCR passes — baseline (verifyNumerics off), verifier on,
 * baseline again (OCR-noise check). Numeric ground-truth keys are scored per
 * field; verifier decisions come from doc.meta.numericVerifications.
 *
 * Run (from repo root):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/run-numeric-verify.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { buildCorpus } from "./corpus";
import type { CorpusItem } from "./corpus";
import type { OcrDocument } from "@/lib/pipeline/types";

interface VerifyRecord {
  kind: string;
  primaryValue: string;
  primaryConfidence?: number;
  verifiedValue?: string;
  verifiedConfidence?: number;
  decision: string;
  reason: string;
}

interface FixtureResult {
  id: string;
  label: string;
  numericGT: Array<{ key: string; label: string }>;
  beforeText: string;
  afterText: string;
  before2Text: string;
  noise: boolean;
  correctBefore: number;
  correctAfter: number;
  incorrectBefore: number;
  incorrectAfter: number;
  changedCorrectly: number;
  changedIncorrectly: number;
  regressions: Array<{ key: string; label: string }>;
  correctedKeys: Array<{ key: string; label: string }>;
  ambiguous: number;
  triggered: number;
  rejectedReplacement: number;
  applied: number;
  appliedCorrect: number;
  records: VerifyRecord[];
  wallBeforeMs: number;
  wallAfterMs: number;
  wallBefore2Ms: number;
}

function numericGT(item: CorpusItem): Array<{ key: string; label: string }> {
  return item.groundTruth
    .map((key, i) => ({ key, label: item.groundTruthLabels[i] ?? key }))
    .filter((f) => /\d/.test(f.key));
}

function foundIn(text: string, key: string): boolean {
  const norm = text.replace(/\s+/g, " ");
  return norm.includes(key) || new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(norm);
}

function canonical(key: string): string {
  return key.replace(/[^0-9]/g, "");
}

async function runOnce(buffer: Buffer, verify: boolean): Promise<{ doc: OcrDocument; ms: number }> {
  const t0 = performance.now();
  const doc = await recognizeMainThread(buffer, "ara+eng", { verifyNumerics: verify });
  return { doc, ms: Math.round(performance.now() - t0) };
}

function recordsOf(doc: OcrDocument): VerifyRecord[] {
  const m = doc.meta?.numericVerifications;
  if (Array.isArray(m)) return m as VerifyRecord[];
  return [];
}

const corpus = await buildCorpus();
const results: FixtureResult[] = [];

for (const item of corpus) {
  const fields = numericGT(item);
  console.log(`\n=== ${item.id} — ${item.label} (numeric GT: ${fields.length}) ===`);

  const b0 = await runOnce(item.buffer, false);
  const a = await runOnce(item.buffer, true);
  const b2 = await runOnce(item.buffer, false);

  const beforeText = b0.doc.text;
  const afterText = a.doc.text;
  const before2Text = b2.doc.text;
  const noise = beforeText !== before2Text;

  const records = recordsOf(a.doc);
  const appliedRecs = records.filter((r) => r.decision === "use_verified");
  const readRecs = records.filter((r) => r.decision === "keep_primary" && r.verifiedValue !== undefined);
  const ambiguousRecs = records.filter(
    (r) => r.decision === "ambiguous_keep_primary" || /ambiguous/.test(r.reason)
  );

  let correctBefore = 0;
  let correctAfter = 0;
  const changedCorrectly: Array<{ key: string; label: string }> = [];
  const changedIncorrectly: Array<{ key: string; label: string }> = [];
  const correctedKeys: Array<{ key: string; label: string }> = [];

  for (const f of fields) {
    const before = foundIn(beforeText, f.key);
    const after = foundIn(afterText, f.key);
    if (before) correctBefore++;
    if (after) correctAfter++;
    if (after && !before) {
      changedCorrectly.push(f);
      correctedKeys.push(f);
    }
    if (!after && before) changedIncorrectly.push(f);
  }

  // Applied corrections vs GT: a record is "correct" when its verified value's
  // digits match a GT key that was NOT correct before.
  let appliedCorrect = 0;
  const gtByCanon = new Map<string, { key: string; label: string }>();
  for (const f of fields) {
    const c = canonical(f.key);
    if (!gtByCanon.has(c)) gtByCanon.set(c, f);
  }
  for (const r of appliedRecs) {
    const c = canonical(r.verifiedValue ?? "");
    const gt = gtByCanon.get(c);
    const wasWrong = !(gt && foundIn(beforeText, gt.key));
    if (gt && wasWrong) appliedCorrect++;
  }

  const wallBefore2Ms = b2.ms;

  const r: FixtureResult = {
    id: item.id,
    label: item.label,
    numericGT: fields,
    beforeText,
    afterText,
    before2Text,
    noise,
    correctBefore,
    correctAfter,
    incorrectBefore: fields.length - correctBefore,
    incorrectAfter: fields.length - correctAfter,
    changedCorrectly: changedCorrectly.length,
    changedIncorrectly: changedIncorrectly.length,
    regressions: changedIncorrectly,
    correctedKeys,
    ambiguous: ambiguousRecs.length,
    triggered: records.length,
    rejectedReplacement: readRecs.length,
    applied: appliedRecs.length,
    appliedCorrect,
    records,
    wallBeforeMs: b0.ms,
    wallAfterMs: a.ms,
    wallBefore2Ms,
  };
  results.push(r);

  console.log(
    `  numeric correct: ${r.correctBefore}/${fields.length} -> ${r.correctAfter}/${fields.length}` +
      `  triggered=${r.triggered} applied=${r.applied} (correct ${r.appliedCorrect}) ambiguous=${r.ambiguous} rejected=${r.rejectedReplacement}` +
      `  OCR=${r.wallBefore2Ms}ms +verify=${r.triggered > 0 ? Math.max(0, r.wallAfterMs - r.wallBefore2Ms) : 0}ms`
  );
  if (noise) {
    console.log(`  [OCR-NOISE] before=${b0.ms}ms before2=${b2.ms}ms — text differs between identical baseline passes`);
  }
  for (const rec of records) {
    console.log(
      `    kind=${rec.kind} ${rec.decision} (${rec.reason}) primary="${rec.primaryValue}" conf=${rec.primaryConfidence?.toFixed(2) ?? "n/a"}` +
        ` verified="${rec.verifiedValue ?? "n/a"}" conf=${rec.verifiedConfidence?.toFixed(2) ?? "n/a"}`
    );
  }
  if (r.regressions.length > 0) {
    console.log(`    REGRESSION candidates: ${r.regressions.map((x) => `${x.label}=${x.key}`).join(", ")}`);
  }
}

// ─── Summary ───────────────────────────────────────────────────────────────

const totalKeys = results.reduce((s, r) => s + r.numericGT.length, 0);
const totalCorrectBefore = results.reduce((s, r) => s + r.correctBefore, 0);
const totalCorrectAfter = results.reduce((s, r) => s + r.correctAfter, 0);
const totalApplied = results.reduce((s, r) => s + r.applied, 0);
const totalAppliedCorrect = results.reduce((s, r) => s + r.appliedCorrect, 0);
const totalTriggeredDocs = results.filter((r) => r.triggered > 0).length;
// Added latency: the verifier's re-reads are the only measurable cost. On
// docs with no re-read the pass is pure JS detection (<1ms), so the honest
// per-doc value is the wall delta on triggered docs only (before2 pass is
// warm-cache-equivalent to the after pass).
const latencyValues: number[] = results.map((r) =>
  r.triggered > 0 ? Math.max(0, r.wallAfterMs - r.wallBefore2Ms) : 0
);
const sorted = [...latencyValues].sort((x, y) => x - y);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const avgLatency = sorted.reduce((s, n) => s + n, 0) / sorted.length;
const p95Latency = pct(0.95);
const maxLatency = sorted[sorted.length - 1] ?? 0;

const allRegressions: Array<{ id: string; key: string; label: string }> = [];
for (const r of results) {
  for (const reg of r.regressions) allRegressions.push({ id: r.id, ...reg });
}

console.log("\n════════════════════════════════════════════════");
console.log("PER-FIXTURE TABLE");
console.log("════════════════════════════════════════════════");
console.log(
  "Fixture          | GT  | Correct B->A | Corrected | Wrong corr. | Ambiguous | OCR(ms) | +Verify(ms)"
);
for (const r of results) {
  const ocrMs = r.wallBefore2Ms;
  const added = r.triggered > 0 ? Math.max(0, r.wallAfterMs - r.wallBefore2Ms) : 0;
  const noiseTag = r.noise ? " [NOISE]" : "";
  console.log(
    `${r.id.padEnd(17)}| ${String(r.numericGT.length).padEnd(3)} | ${String(r.correctBefore).padEnd(2)} -> ${String(r.correctAfter).padEnd(2)} | ${String(r.changedCorrectly).padEnd(9)} | ${String(r.changedIncorrectly).padEnd(10)} | ${String(r.ambiguous).padEnd(9)} | ${String(ocrMs).padEnd(7)} | ${added}${noiseTag}`
  );
}

console.log("\n════════════════════════════════════════════════");
console.log("SUMMARY");
console.log("════════════════════════════════════════════════");
console.log(`numeric accuracy before : ${(totalCorrectBefore / totalKeys).toFixed(3)} (${totalCorrectBefore}/${totalKeys})`);
console.log(`numeric accuracy after  : ${(totalCorrectAfter / totalKeys).toFixed(3)} (${totalCorrectAfter}/${totalKeys})`);
console.log(`correction precision    : ${totalApplied > 0 ? (totalAppliedCorrect / totalApplied).toFixed(3) : "n/a (no corrections applied)"} (${totalAppliedCorrect}/${totalApplied})`);
const incorrectBefore = totalKeys - totalCorrectBefore;
console.log(`correction recall       : ${incorrectBefore > 0 ? (totalAppliedCorrect / incorrectBefore).toFixed(3) : "n/a (nothing was wrong)"} (${totalAppliedCorrect}/${incorrectBefore})`);
console.log(`false correction count  : ${totalApplied - totalAppliedCorrect}`);
console.log(`unchanged-correct count : ${results.reduce((s, r) => s + (r.numericGT.length - (r.incorrectBefore + r.changedCorrectly)), 0)}`);
console.log(`verifier trigger rate   : ${totalTriggeredDocs}/${results.length} docs`);
console.log(`average added latency   : ${avgLatency.toFixed(1)}ms`);
console.log(`p95 added latency       : ${p95Latency}ms`);
console.log(`max added latency       : ${maxLatency}ms`);

console.log("\n════════════════════════════════════════════════");
console.log("CRITICAL SAFETY CHECK (REGRESSIONS)");
console.log("════════════════════════════════════════════════");
if (allRegressions.length === 0) {
  console.log("none — no GT-correct value became wrong after the verifier");
} else {
  for (const reg of allRegressions) {
    console.log(`REGRESSION ${reg.id}: ${reg.label} = "${reg.key}"`);
  }
}
const noiseDocs = results.filter((r) => r.noise);
if (noiseDocs.length > 0) {
  console.log(`\n════════════════════════════════════════════════`);
  console.log("OCR NONDETERMINISM CHECK (before vs before2)");
  console.log(`════════════════════════════════════════════════`);
  for (const r of noiseDocs) {
    console.log(`  ${r.id}: before2Text differs from beforeText`);
    const bLines = r.beforeText.split("\n").filter((l) => /\d/.test(l));
    const b2Lines = r.before2Text.split("\n").filter((l) => /\d/.test(l));
    console.log(`    baseline numeric lines (${bLines.length}):`);
    for (const l of bLines) console.log(`      "${l}"`);
    console.log(`    before2 numeric lines (${b2Lines.length}):`);
    for (const l of b2Lines) console.log(`      "${l}"`);
  }
} else {
  console.log("\nOCR nondeterminism: none — before ≡ before2 on all fixtures");
}

mkdirSync("benchmarks/results", { recursive: true });
writeFileSync(
  "benchmarks/results/numeric-verify.json",
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      results: results.map((r) => ({
        ...r,
        addedLatencyMs: r.triggered > 0 ? Math.max(0, r.wallAfterMs - r.wallBefore2Ms) : 0,
      })),
    },
    null,
    2
  )
);
console.log("\nWrote benchmarks/results/numeric-verify.json");
