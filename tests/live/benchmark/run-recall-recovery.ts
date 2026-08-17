/**
 * Recall-recovery benchmark: current composite (primary + raw fallback) vs the
 * same composite PLUS the additive recall-recovery layer, across the full
 * corpus (9 fixtures). Records per-fixture GT hits, recovery decisions,
 * per-attempt candidate scores and added latency.
 *
 * Run (from repo root):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/run-recall-recovery.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { buildCorpus, scoreText } from "./corpus";
import type { CorpusItem } from "./corpus";
import type { RecallRecoveryRecord } from "@/lib/ocr/recall";

interface FixtureResult {
  id: string;
  label: string;
  beforeHits: number;
  afterHits: number;
  total: number;
  beforeText: string;
  afterText: string;
  linesBefore: number;
  linesAfter: number;
  detected: boolean;
  signals: string[];
  attempts: number;
  selected: string;
  winnerVariant?: string;
  primaryScore?: number;
  bestScore?: number;
  margin?: number;
  skippedReason?: string;
  attemptResults?: RecallRecoveryRecord["attemptResults"];
  addedLatencyMs: number;
  ocrMs: number;
}

function recoveryRecord(doc: Awaited<ReturnType<typeof recognizeMainThread>>): RecallRecoveryRecord | undefined {
  const m = doc.meta?.recallRecovery;
  return m as RecallRecoveryRecord | undefined;
}

async function runOnce(buffer: Buffer, recover: boolean): Promise<{ doc: Awaited<ReturnType<typeof recognizeMainThread>>; ms: number }> {
  const t0 = performance.now();
  const doc = await recognizeMainThread(buffer, "ara+eng", recover ? { recoverRecall: true, recoveryBudgetMs: 20_000 } : {});
  return { doc, ms: Math.round(performance.now() - t0) };
}

const corpus = await buildCorpus();
const filter = process.env.FIXTURE;
const items = filter ? corpus.filter((i) => i.id === filter) : corpus;
const results: FixtureResult[] = [];

for (const item of items) {
  console.log(`\n=== ${item.id} — ${item.label} ===`);

  const before = await runOnce(item.buffer, false);
  const after = await runOnce(item.buffer, true);

  const b = scoreText(before.doc.text, item);
  const a = scoreText(after.doc.text, item);
  const rec = recoveryRecord(after.doc);

  const r: FixtureResult = {
    id: item.id,
    label: item.label,
    beforeHits: b.hits,
    afterHits: a.hits,
    total: b.total,
    beforeText: before.doc.text,
    afterText: after.doc.text,
    linesBefore: before.doc.lines.length,
    linesAfter: after.doc.lines.length,
    detected: rec?.detected ?? false,
    signals: rec?.signals ?? [],
    attempts: rec?.attempts ?? 0,
    selected: rec?.selected ?? "primary",
    winnerVariant: rec?.winnerVariant,
    primaryScore: rec?.primaryScore,
    bestScore: rec?.bestScore,
    margin: rec?.margin,
    skippedReason: rec?.skippedReason,
    attemptResults: rec?.attemptResults,
    addedLatencyMs: Math.max(0, after.ms - before.ms),
    ocrMs: before.ms,
  };
  results.push(r);

  console.log(
    `  GT hits: ${r.beforeHits}/${r.total} -> ${r.afterHits}/${r.total}` +
      `  lines: ${r.linesBefore} -> ${r.linesAfter}` +
      `  OCR=${r.ocrMs}ms +recovery=${r.addedLatencyMs}ms`
  );
  console.log(
    `  recovery: detected=${r.detected} signals=[${r.signals.join(",")}]` +
      ` attempts=${r.attempts} selected=${r.selected}${r.winnerVariant ? ` (${r.winnerVariant})` : ""}` +
      (r.skippedReason ? ` skipped=${r.skippedReason}` : "")
  );
  if (r.detected && r.attemptResults) {
    console.log(
      `  primaryScore=${r.primaryScore?.toFixed(3)} bestScore=${r.bestScore?.toFixed(3)} margin=${r.margin?.toFixed(3)}`
    );
    for (const at of r.attemptResults) {
      console.log(`    attempt ${at.variant}: score=${at.score.toFixed(3)} margin=${at.margin.toFixed(3)}`);
    }
  }
}

console.log("\n════════════════════════════════════════════════");
console.log("PER-FIXTURE TABLE");
console.log("════════════════════════════════════════════════");
console.log("Fixture          | GT  | Hits B->A | Lines B->A | Detected | Attempts | +Recovery(ms)");
for (const r of results) {
  const detTag = r.detected ? "YES" : "no";
  const selTag = r.selected === "candidate" ? ` (${r.winnerVariant})` : "";
  console.log(
    `${r.id.padEnd(17)}| ${String(r.total).padEnd(3)} | ${String(r.beforeHits).padEnd(2)} -> ${String(r.afterHits).padEnd(2)} | ${String(r.linesBefore).padEnd(2)} -> ${String(r.linesAfter).padEnd(2)} | ${detTag.padEnd(7)} | ${String(r.attempts).padEnd(8)} | ${r.addedLatencyMs}${selTag}`
  );
}

const totalHitsBefore = results.reduce((s, r) => s + r.beforeHits, 0);
const totalHitsAfter = results.reduce((s, r) => s + r.afterHits, 0);
const totalKeys = results.reduce((s, r) => s + r.total, 0);
const regressions = results.filter((r) => r.afterHits < r.beforeHits);
const detectedDocs = results.filter((r) => r.detected);

console.log("\n════════════════════════════════════════════════");
console.log("SUMMARY");
console.log("════════════════════════════════════════════════");
console.log(`GT hits before : ${totalHitsBefore}/${totalKeys}`);
console.log(`GT hits after  : ${totalHitsAfter}/${totalKeys}`);
console.log(`recovery triggered on : ${detectedDocs.length}/${results.length} docs`);
console.log(`regressions : ${regressions.length === 0 ? "none" : regressions.map((r) => r.id).join(", ")}`);

mkdirSync("benchmarks/results", { recursive: true });
writeFileSync(
  "benchmarks/results/recall-recovery.json",
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      results,
    },
    null,
    2
  )
);
console.log("\nWrote benchmarks/results/recall-recovery.json");
