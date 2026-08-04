/**
 * OCR-level before/after benchmark.
 *
 * For every corpus item, runs the OLD engine (pre-milestone snapshot at
 * tests/live/_engines/old-tesseract.ts), the NEW engine without preprocessing,
 * and the NEW engine with the production preprocessing+fallback composite.
 * Records line/char volume, page + per-line confidence, ground-truth hit rate
 * and wall-clock time, then writes a JSON snapshot for the report generator.
 *
 * Run (from repo root):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/run-ocr-level.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { recognizeMainThread as oldRecognize } from "../_engines/old-tesseract";
import { recognizeMainThread as newRecognize } from "@/lib/tesseract-main";
import { buildCorpus, scoreText } from "./corpus";
import type { CorpusItem } from "./corpus";

interface Sample {
  lines: number;
  chars: number;
  pageConf: number | undefined;
  meanLineConf: number | undefined;
  distinctConfs: number;
  hits: number;
  total: number;
  detail: Array<{ key: string; label: string; found: boolean }>;
  ms: number;
  text: string;
}

async function runEngine(label: string, item: CorpusItem, fn: () => Promise<{ text: string; confidence?: number; lines: { text: string; confidence?: number }[] }>): Promise<Sample> {
  const t0 = performance.now();
  const doc = await fn();
  const ms = Math.round(performance.now() - t0);
  const confs = doc.lines.map((l) => l.confidence).filter((c): c is number => typeof c === "number");
  const meanLineConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined;
  const scored = scoreText(doc.text, item);
  const sample: Sample = {
    lines: doc.lines.length,
    chars: doc.text.replace(/\s+/g, "").length,
    pageConf: doc.confidence,
    meanLineConf,
    distinctConfs: new Set(confs.map((c) => c.toFixed(3))).size,
    hits: scored.hits,
    total: scored.total,
    detail: scored.detail,
    ms,
    text: doc.text,
  };
  console.log(`  [${label}] lines=${sample.lines} chars=${sample.chars} pageConf=${(sample.pageConf ?? 0).toFixed(3)} meanLine=${(sample.meanLineConf ?? 0).toFixed(3)} hits=${sample.hits}/${sample.total} ${sample.ms}ms`);
  return sample;
}

const corpus = await buildCorpus();
mkdirSync("benchmarks/results", { recursive: true });

const results: Record<string, Record<string, Sample>> = {};
for (const item of corpus) {
  console.log(`\n=== ${item.id} — ${item.label} ===`);
  results[item.id] = {
    old: await runEngine("old", item, () => oldRecognize(item.buffer, "eng+ara")),
    newRaw: await runEngine("newRaw", item, () => newRecognize(item.buffer, "eng+ara", { preprocess: false })),
    newPre: await runEngine("newPre", item, () => newRecognize(item.buffer, "eng+ara", { preprocess: true })),
  };
}

writeFileSync("benchmarks/results/ocr-level.json", JSON.stringify({ corpusMeta: corpus.map((c) => ({ id: c.id, label: c.label, groundTruth: c.groundTruth, groundTruthLabels: c.groundTruthLabels })), results }, null, 2));
console.log("\nWrote benchmarks/results/ocr-level.json");
