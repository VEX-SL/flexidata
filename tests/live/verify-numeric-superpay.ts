/**
 * Live before/after check for the secondary numeric verification on the real
 * SuperPay receipt photo:
 *   - OCR without verification (baseline behavior)
 *   - OCR with verifyNumerics (opt-in)
 *   - every verification decision from doc.meta.numericVerifications
 *   - numeric GT coverage before/after + runtime delta
 *
 * Run:
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/verify-numeric-superpay.ts
 */
import { readFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";

const IMAGE = "benchmarks/corpus/real-superpay.jpg";
const GT_NUMERIC = ["68.38", "391003452", "2013438351", "02-07-2026"];
const GT_LABELS = ["amount", "account", "ref", "date"];

function score(text: string): string {
  const norm = text.replace(/\s+/g, " ");
  return GT_NUMERIC.map((key, i) => {
    const found = norm.includes(key);
    return `${GT_LABELS[i]}=${found ? "hit" : "miss"}${found ? "" : ` (want "${key}")`}`;
  }).join("  ");
}

function numericLines(doc: { lines: Array<{ text: string; confidence?: number }> }): string {
  return doc.lines
    .map((l) => `${(l.confidence ?? 0).toFixed(2)} | ${l.text}`)
    .filter((row) => /[0-9]/.test(row))
    .join("\n");
}

const bytes = readFileSync(IMAGE);

const t0 = Date.now();
const before = await recognizeMainThread(bytes, "ara+eng", { verifyNumerics: false });
const t1 = Date.now();
const after = await recognizeMainThread(bytes, "ara+eng", { verifyNumerics: true });
const t2 = Date.now();

console.log("=== BEFORE (no verification) ===");
console.log(`runtime: ${t1 - t0}ms  pageConf: ${(before.confidence ?? 0).toFixed(3)}`);
console.log(score(before.text));
console.log("--- numeric lines ---");
console.log(numericLines(before));

console.log("\n=== AFTER (verifyNumerics) ===");
console.log(`runtime: ${t2 - t1}ms  pageConf: ${(after.confidence ?? 0).toFixed(3)}  delta: ${t2 - t1 - (t1 - t0)}ms`);
console.log(score(after.text));

const report = after.meta?.numericVerifications as
  | Array<{
      kind: string;
      bbox: unknown;
      primaryValue: string;
      primaryConfidence?: number;
      verifiedValue?: string;
      verifiedConfidence?: number;
      doubleReadAgreed?: boolean;
      decision: string;
      reason: string;
    }>
  | undefined;

console.log("\n=== VERIFICATION DECISIONS ===");
if (!report || report.length === 0) {
  console.log("(no candidates needed verification — all valid and confident, or none detected)");
} else {
  for (const v of report) {
    console.log(
      `kind=${v.kind} decision=${v.decision} reason=${v.reason}` +
        `\n  primary: "${v.primaryValue}" conf=${v.primaryConfidence?.toFixed(3) ?? "n/a"}` +
        `\n  verified: "${v.verifiedValue ?? "n/a"}" conf=${v.verifiedConfidence?.toFixed(3) ?? "n/a"}` +
        `  doubleReadAgreed=${String(v.doubleReadAgreed)}`
    );
  }
}

console.log("\n=== CHANGED TEXT LINES ===");
const beforeLines = before.lines.map((l) => l.text);
const afterLines = after.lines.map((l) => l.text);
let changed = 0;
for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
  if (beforeLines[i] !== afterLines[i]) {
    changed++;
    console.log(`  line ${i}: BEFORE="${beforeLines[i] ?? ""}"`);
    console.log(`           AFTER ="${afterLines[i] ?? ""}"`);
  }
}
if (changed === 0) console.log("(no line changed)");

console.log(`\nGT coverage: before ${score(before.text)}`);
console.log(`             after  ${score(after.text)}`);