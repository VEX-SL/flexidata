/**
 * LIVE diagnostic — Arabic OCR before/after on real images.
 *
 * Runs real Tesseract (main thread, ara+eng, preprocessing) over the committed
 * image corpus (benchmarks/corpus + benchmarks/real), reconstructs the RAW OCR
 * stream from each line's `originalText`, and compares it with the repaired
 * (post-processed) stream: lines repaired, canonical character preservation,
 * per-line quality (mean noise, garbage lines), and concrete repaired examples
 * per document. Outputs a JSON report to the temp dir and a console summary.
 *
 * Run (real OCR, no AI keys needed):
 *   node --experimental-strip-types --experimental-transform-types
 *        --experimental-loader ./tests/loader.mjs
 *        --import ./tests/set-require.mjs tests/live/ocr-arabic-before-after.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { normalizeArabicText } from "@/lib/ocr/arabic/normalize";
import {
  assessTextQuality,
  NOISE_THRESHOLD,
} from "@/lib/pipeline/text-quality";
import type { OcrDocument, OcrLine } from "@/lib/pipeline/types";

const CORPUS: Array<{ id: string; path: string }> = [
  { id: "ar-thermal", path: "benchmarks/corpus/ar-thermal.png" },
  { id: "contract-1pg", path: "benchmarks/corpus/contract-1pg.png" },
  { id: "invoice-clean", path: "benchmarks/corpus/invoice-clean.png" },
  { id: "real-superpay", path: "benchmarks/corpus/real-superpay.jpg" },
  { id: "real-superpay-dup", path: "benchmarks/real/3268eb8f-d800-4b20-8a71-527d910e3dc2.jpg" },
  { id: "en-clean", path: "benchmarks/corpus/en-clean.png" },
  { id: "en-lowcontrast", path: "benchmarks/corpus/en-lowcontrast.png" },
];

/** Reconstruct the original line stream from a post-processed document
 *  (postProcessOcr stamps every output line with the source line index; splits
 *  share one index, so the first output line per index is the original). */
function rawLinesOf(doc: OcrDocument): string[] {
  const out: string[] = [];
  let lastSource = -1;
  for (const line of doc.lines) {
    const source = line.sourceLine ?? -1;
    if (source !== lastSource) {
      out.push(line.originalText ?? line.text);
      lastSource = source;
    }
  }
  return out;
}

const chars = (s: string) =>
  [...normalizeArabicText(s)].filter((c) => !/\s/.test(c)).sort().join("");

function lineNoise(line: OcrLine): number {
  return assessTextQuality(line.originalText ?? line.text).noiseScore;
}

async function runOne(id: string, path: string) {
  const bytes = readFileSync(path);
  console.log(`[ocr] ${id} ...`);
  const doc = await recognizeMainThread(bytes, "ara+eng", { preprocess: true });
  const rawLines = rawLinesOf(doc);
  const rawText = rawLines.join("\n");
  const processedText = doc.text;

  const repaired = doc.lines.filter(
    (l) => l.repaired === true && l.originalText !== undefined
  );
  const changedOriginals = new Set(repaired.map((l) => l.originalText)).size;

  const rawNoise = rawLines.length
    ? rawLines.reduce((s, l) => s + assessTextQuality(l).noiseScore, 0) / rawLines.length
    : 0;
  const processedNoise = doc.lines.length
    ? doc.lines.reduce((s, l) => s + lineNoise(l), 0) / doc.lines.length
    : 0;
  const rawGarbage = rawLines.filter((l) => assessTextQuality(l).noiseScore > NOISE_THRESHOLD).length;
  const processedGarbage = doc.lines.filter((l) => lineNoise(l) > NOISE_THRESHOLD).length;

  return {
    id,
    rawLines: rawLines.length,
    processedLines: doc.lines.length,
    linesChanged: changedOriginals,
    charPreserved: chars(processedText) === chars(rawText),
    rawMeanNoise: round(rawNoise),
    processedMeanNoise: round(processedNoise),
    noiseDelta: round(processedNoise - rawNoise),
    rawGarbage,
    processedGarbage,
    repairedExamples: repaired.slice(0, 6).map((l) => ({
      original: l.originalText,
      repaired: l.text,
      noise: round(l.quality?.noiseScore ?? 0),
    })),
    rawText,
    processedText,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── run ────────────────────────────────────────────────────────────────────
const reports = [];
for (const { id, path } of CORPUS) {
  try {
    reports.push(await runOne(id, path));
  } catch (err) {
    console.error(`[ocr] ${id} FAILED: ${(err as Error)?.message ?? String(err)}`);
  }
}

const summary = reports.map((r) => ({
  id: r.id,
  rawLines: r.rawLines,
  changed: r.linesChanged,
  preserved: r.charPreserved,
  noise: `${r.rawMeanNoise} -> ${r.processedMeanNoise}`,
  garbage: `${r.rawGarbage} -> ${r.processedGarbage}`,
}));

const outPath = "C:/Users/dell/AppData/Local/Temp/opencode/ocr-arabic-before-after.json";
writeFileSync(outPath, JSON.stringify({ summary, reports }, null, 2), "utf8");
console.table(summary);
for (const r of reports) {
  if (r.linesChanged > 0) {
    console.log(`\n${r.id}: ${r.linesChanged} line(s) repaired — examples`);
    for (const e of r.repairedExamples) {
      console.log(`  RAW       ${JSON.stringify(e.original)}`);
      console.log(`  REPAIRED  ${JSON.stringify(e.repaired)}`);
    }
  }
}
console.log(`\n[done] report written to ${outPath}`);

