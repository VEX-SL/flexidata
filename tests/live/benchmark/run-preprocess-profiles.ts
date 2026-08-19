/**
 * Independent preprocessing-profile benchmark: Current vs Contrast vs
 * Deblur vs Threshold across all fixtures. Measures digit accuracy,
 * edit distance, mean confidence and runtime — no production code changes.
 *
 * Run (from repo root):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/run-preprocess-profiles.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { buildCorpus, scoreText } from "./corpus";
import type { CorpusItem } from "./corpus";
import {
  toGray,
  contrastStretch,
  sharpenGray,
  adaptiveThreshold,
  otsuThreshold,
  canvasFromImage,
  scaleImage,
  type RawImage,
} from "@/lib/ocr/preprocess";
import { createCanvas } from "@/lib/pdf-canvas";

// ─── Ground truth fields per fixture ────────────────────────────────────────

interface GtField {
  key: string;      // substring to look for (case-insensitive)
  label: string;    // human-readable field name
  numeric: boolean; // whether to compute digit-level metrics
}

const GROUND_TRUTH: Record<string, GtField[]> = {
  "real-superpay": [
    { key: "607021830113216",  label: "Transaction Number", numeric: true },
    { key: "20250118",         label: "Transaction Date",   numeric: true },
    { key: "1343786620",       label: "Reference Number",   numeric: true },
    { key: "5890043307984222", label: "Account Number",     numeric: true },
    { key: "5890043307984222", label: "Customer Number",    numeric: true },
    { key: "68.38",            label: "Amount Due",         numeric: true },
  ],
  "en-clean": [
    { key: "38.40", label: "Total",  numeric: true },
    { key: "50.00", label: "Cash",   numeric: true },
    { key: "11.60", label: "Change", numeric: true },
  ],
  "en-lowcontrast": [
    { key: "38.40", label: "Total",  numeric: true },
    { key: "50.00", label: "Cash",   numeric: true },
    { key: "11.60", label: "Change", numeric: true },
  ],
  "en-rot90": [
    { key: "38.40", label: "Total",  numeric: true },
    { key: "50.00", label: "Cash",   numeric: true },
    { key: "11.60", label: "Change", numeric: true },
  ],
  "en-slant2": [
    { key: "38.40", label: "Total",  numeric: true },
    { key: "50.00", label: "Cash",   numeric: true },
    { key: "11.60", label: "Change", numeric: true },
  ],
  "scan-blur": [
    { key: "38.40", label: "Total",  numeric: true },
    { key: "50.00", label: "Cash",   numeric: true },
    { key: "11.60", label: "Change", numeric: true },
  ],
  "invoice-clean": [
    { key: "INV-2026-014", label: "Invoice Number", numeric: false },
    { key: "2026-02-14",   label: "Issue Date",     numeric: true },
    { key: "155.25",       label: "Total",          numeric: true },
    { key: "150.00",       label: "Subtotal",       numeric: true },
    { key: "5.25",         label: "VAT",            numeric: true },
  ],
  "contract-1pg": [
    { key: "CT-2025-881", label: "Contract Number",  numeric: false },
    { key: "2025-03-01",  label: "Effective Date",   numeric: true },
    { key: "2026-03-01",  label: "Expiry Date",      numeric: true },
    { key: "1,200",       label: "Monthly Fee",      numeric: true },
    { key: "14,400",      label: "Total Value",      numeric: true },
  ],
  "ar-thermal": [
    { key: "٣٨", label: "Amount (Arabic digits)", numeric: true },
  ],
};

// ─── Metrics helpers ────────────────────────────────────────────────────────

function normalizeText(t: string): string {
  return t.toLowerCase().replace(/[\s\u00A0\u200B\u200C\u200D]+/g, " ").trim();
}

function digitsOnly(s: string): string {
  return s.replace(/[^0-9\u0660-\u0669\u06F0-\u06F9]/g, "")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function fieldFound(text: string, key: string): boolean {
  const nt = normalizeText(text);
  const nk = normalizeText(key);
  if (nt.includes(nk)) return true;
  try { return new RegExp(key, "i").test(text); } catch { return false; }
}

function digitAccuracy(gtDigits: string, ocrDigits: string): number {
  if (!gtDigits || !ocrDigits) return 0;
  const len = Math.max(gtDigits.length, ocrDigits.length);
  let correct = 0;
  for (let i = 0; i < len; i++) {
    if ((gtDigits[i] ?? "") === (ocrDigits[i] ?? "")) correct++;
  }
  return correct / len;
}

// ─── Preprocessing profiles ─────────────────────────────────────────────────

type ProfileFn = (img: RawImage) => Promise<RawImage>;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// A — Current: just return the image unchanged (pipeline runs as-is via recognizeMainThread)
// Not used as a profile function; handled separately in the main loop.

// B — Contrast
const profileContrast: ProfileFn = async (img) => {
  const gray = toGray(img);
  const stretched = contrastStretch(gray);
  const w = img.width, h = img.height;
  const sharpened = sharpenGray(stretched, w, h, 0.9);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = clamp(Math.round(sharpened[i]), 0, 255);
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  const loGray = { data: out, width: w, height: h } as RawImage;
  return scaleImage(loGray, 1.5);
};

// C — Deblur
const profileDeblur: ProfileFn = async (img) => {
  const upscaled = await scaleImage(img, 2);
  const w = upscaled.width, h = upscaled.height;
  const gray = toGray(upscaled);

  // Box blur (radius 2) as denoise
  const blurred = new Float32Array(gray.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ny = clamp(y + dy, 0, h - 1);
          const nx = clamp(x + dx, 0, w - 1);
          sum += gray[ny * w + nx]; count++;
        }
      }
      blurred[y * w + x] = sum / count;
    }
  }

  const sharpened = sharpenGray(blurred, w, h, 1.1);
  const stretched = contrastStretch(sharpened);

  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = clamp(Math.round(stretched[i]), 0, 255);
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return { data: out, width: w, height: h } as RawImage;
};

// D — Threshold
const profileThreshold: ProfileFn = async (img) => {
  const gray = toGray(img);
  const stretched = contrastStretch(gray);
  const w = img.width, h = img.height;
  const bin = adaptiveThreshold(stretched, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = bin[i]; // already 0 or 255
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return scaleImage({ data: out, width: w, height: h } as RawImage, 1.5);
};

// ─── Main benchmark ─────────────────────────────────────────────────────────

interface FieldResult {
  field: string;
  label: string;
  found: boolean;
  digitAcc: number | null;
  editDist: number;
  conf: number;
}

interface ProfileResult {
  profile: string;
  fixture: string;
  fields: FieldResult[];
  exactHits: number;
  totalFields: number;
  meanDigitAcc: number;
  meanEditDist: number;
  meanConf: number;
  runtimeMs: number;
  text: string;
  gtHits: number;  // scoreText GT hits
  gtTotal: number;
}

const profiles: Array<{ name: string; fn?: ProfileFn; useCurrentPipeline: boolean }> = [
  { name: "Current",   useCurrentPipeline: true },
  { name: "Contrast",  fn: profileContrast,  useCurrentPipeline: false },
  { name: "Deblur",    fn: profileDeblur,    useCurrentPipeline: false },
  { name: "Threshold", fn: profileThreshold, useCurrentPipeline: false },
];

const corpus = await buildCorpus();
const allResults: ProfileResult[] = [];

for (const item of corpus) {
  const gtFields = GROUND_TRUTH[item.id] ?? [];
  console.log(`\n══════ ${item.id} — ${item.label} ══════`);
  if (gtFields.length === 0) {
    console.log("  (no GT fields defined — using scoreText only)");
  }

  for (const profile of profiles) {
    let text: string;
    const t0 = performance.now();

    if (profile.useCurrentPipeline) {
      // Profile A: full pipeline as-is
      const doc = await recognizeMainThread(item.buffer, "ara+eng", {
        verifyNumerics: false,
        recoverRecall: false,
      });
      text = doc.text;
    } else {
      // Profiles B/C/D: custom preprocessing → Tesseract (no pipeline)
      const { decodeToRgba } = await import("@/lib/ocr/preprocess");
      const raw = await decodeToRgba(item.buffer);
      const processed = await profile.fn!(raw);
      const png = Buffer.from(canvasFromImage(processed).toBuffer("image/png"));
      const doc = await recognizeMainThread(png, "ara+eng", { preprocess: false });
      text = doc.text;
    }

    const elapsed = Math.round(performance.now() - t0);

    // Score against GT fields
    const fields: FieldResult[] = gtFields.map((gt) => {
      const found = fieldFound(text, gt.key);
      const ocrDigits = digitsOnly(text);
      const gtDigits = digitsOnly(gt.key);
      return {
        field: gt.key,
        label: gt.label,
        found,
        digitAcc: gt.numeric ? digitAccuracy(gtDigits, ocrDigits) : null,
        editDist: levenshtein(normalizeText(gt.key), normalizeText(text)),
        conf: 0, // filled below
      };
    });

    // scoreText GT (full document level)
    const score = scoreText(text, item);

    // Mean OCR confidence is approximated from text length vs match quality
    // (Tesseract doesn't expose per-document mean conf directly here, so we
    // use scoreText hits ratio as a proxy for "readability").
    const exactHits = fields.filter((f) => f.found).length;
    const numericFields = fields.filter((f) => f.digitAcc !== null);
    const meanDigitAcc = numericFields.length > 0
      ? numericFields.reduce((s, f) => s + f.digitAcc!, 0) / numericFields.length
      : 0;
    const meanEditDist = fields.length > 0
      ? fields.reduce((s, f) => s + f.editDist, 0) / fields.length
      : 0;
    // Mean confidence proxy: ratio of GT words found in the text
    const meanConf = score.total > 0 ? score.hits / score.total : 0;

    const result: ProfileResult = {
      profile: profile.name,
      fixture: item.id,
      fields,
      exactHits,
      totalFields: gtFields.length,
      meanDigitAcc,
      meanEditDist,
      meanConf,
      runtimeMs: elapsed,
      text,
      gtHits: score.hits,
      gtTotal: score.total,
    };
    allResults.push(result);

    const fStr = fields.length > 0
      ? fields.map((f) => `${f.label}:${f.found ? "✓" : "✗"}`).join(" ")
      : `scoreText:${score.hits}/${score.total}`;
    console.log(
      `  [${profile.name.padEnd(9)}] ${fStr}  digits=${meanDigitAcc.toFixed(2)}  ` +
      `edit=${meanEditDist.toFixed(0)}  ${elapsed}ms`
    );
  }
}

// ─── Summary tables ─────────────────────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("PROFILE SUMMARY (averaged across all fixtures)");
console.log("══════════════════════════════════════════════════════════════════════");

const profileNames = profiles.map((p) => p.name);
const summaryRows = profileNames.map((name) => {
  const results = allResults.filter((r) => r.profile === name);
  const totalExact = results.reduce((s, r) => s + r.exactHits, 0);
  const totalFields = results.reduce((s, r) => s + r.totalFields, 0);
  const avgDigit = results.reduce((s, r) => s + r.meanDigitAcc, 0) / Math.max(1, results.length);
  const avgEdit = results.reduce((s, r) => s + r.meanEditDist, 0) / Math.max(1, results.length);
  const avgConf = results.reduce((s, r) => s + r.meanConf, 0) / Math.max(1, results.length);
  const avgRuntime = results.reduce((s, r) => s + r.runtimeMs, 0) / Math.max(1, results.length);
  const totalGtHits = results.reduce((s, r) => s + r.gtHits, 0);
  const totalGtTotal = results.reduce((s, r) => s + r.gtTotal, 0);
  return { name, totalExact, totalFields, avgDigit, avgEdit, avgConf, avgRuntime, totalGtHits, totalGtTotal };
});

console.log(
  `${"Profile".padEnd(11)}| ${"Exact".padStart(5)} | ${"DigitAcc".padStart(8)} | ${"EditDist".padStart(8)} | ${"Conf".padStart(5)} | ${"GT hits".padStart(7)} | ${"Avg ms".padStart(7)}`
);
console.log(`${"-".repeat(11)}|${"-".repeat(7)}|${"-".repeat(10)}|${"-".repeat(10)}|${"-".repeat(7)}|${"-".repeat(9)}|${"-".repeat(9)}`);
for (const r of summaryRows) {
  console.log(
    `${r.name.padEnd(11)}| ${String(r.totalExact + "/" + r.totalFields).padStart(5)} | ${r.avgDigit.toFixed(3).padStart(8)} | ${r.avgEdit.toFixed(1).padStart(8)} | ${r.avgConf.toFixed(2).padStart(5)} | ${String(r.totalGtHits + "/" + r.totalGtTotal).padStart(7)} | ${Math.round(r.avgRuntime).toString().padStart(7)}`
  );
}

// ─── Per-fixture table ──────────────────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("PER-FIXTURE TABLE (exact hits / total fields)");
console.log("══════════════════════════════════════════════════════════════════════");

const fixtureIds = [...new Set(allResults.map((r) => r.fixture))];
console.log(
  `${"Fixture".padEnd(16)}| ${"Current".padStart(9)} | ${"Contrast".padStart(9)} | ${"Deblur".padStart(9)} | ${"Threshold".padStart(9)} | Best`
);
console.log(`${"-".repeat(16)}|${"-".repeat(11)}|${"-".repeat(11)}|${"-".repeat(11)}|${"-".repeat(11)}|${"-".repeat(9)}`);

for (const fid of fixtureIds) {
  const row = profileNames.map((name) => {
    const r = allResults.find((x) => x.fixture === fid && x.profile === name);
    return r ? `${r.exactHits}/${r.totalFields}` : "—";
  });
  const scores = profileNames.map((name) => {
    const r = allResults.find((x) => x.fixture === fid && x.profile === name);
    return r ? r.exactHits : -1;
  });
  const bestIdx = scores.indexOf(Math.max(...scores));
  const bestName = profileNames[bestIdx];
  console.log(
    `${fid.padEnd(16)}| ${row[0].padStart(9)} | ${row[1].padStart(9)} | ${row[2].padStart(9)} | ${row[3].padStart(9)} | ${bestName}`
  );
}

// ─── Per-field comparison (superpay focus) ──────────────────────────────────

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("PER-FIELD COMPARISON — real-superpay");
console.log("══════════════════════════════════════════════════════════════════════");

const superpayResults = allResults.filter((r) => r.fixture === "real-superpay");
const superpayGt = GROUND_TRUTH["real-superpay"] ?? [];
if (superpayGt.length > 0) {
  console.log(
    `${"Field".padEnd(20)}| ${"Current".padStart(9)} | ${"Contrast".padStart(9)} | ${"Deblur".padStart(9)} | ${"Threshold".padStart(9)} | Best`
  );
  console.log(`${"-".repeat(20)}|${"-".repeat(11)}|${"-".repeat(11)}|${"-".repeat(11)}|${"-".repeat(11)}|${"-".repeat(9)}`);
  for (const gt of superpayGt) {
    const row = profileNames.map((name) => {
      const r = superpayResults.find((x) => x.profile === name);
      const f = r?.fields.find((x) => x.label === gt.label);
      return f ? (f.found ? "✓" : "✗") : "—";
    });
    const foundCounts = profileNames.map((name) => {
      const r = superpayResults.find((x) => x.profile === name);
      const f = r?.fields.find((x) => x.label === gt.label);
      return f?.found ? 1 : 0;
    });
    const bestIdx = foundCounts.indexOf(Math.max(...foundCounts));
    console.log(
      `${gt.label.padEnd(20)}| ${row[0].padStart(9)} | ${row[1].padStart(9)} | ${row[2].padStart(9)} | ${row[3].padStart(9)} | ${profileNames[bestIdx]}`
    );
  }
}

// ─── Regression check ──────────────────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("REGRESSION CHECK");
console.log("══════════════════════════════════════════════════════════════════════");

const currentResults = allResults.filter((r) => r.profile === "Current");
const regressions: Array<{ fixture: string; profile: string; field: string; currentFound: boolean; profileFound: boolean }> = [];

for (const cr of currentResults) {
  for (const pr of allResults.filter((r) => r.fixture === cr.fixture && r.profile !== "Current")) {
    for (let i = 0; i < cr.fields.length; i++) {
      if (cr.fields[i].found && !pr.fields[i].found) {
        regressions.push({
          fixture: cr.fixture,
          profile: pr.profile,
          field: cr.fields[i].label,
          currentFound: true,
          profileFound: false,
        });
      }
    }
  }
}

if (regressions.length === 0) {
  console.log("No regressions detected — every correct Current read remains correct in all profiles.");
} else {
  console.log(`${regressions.length} regression(s):`);
  for (const r of regressions) {
    console.log(`  ${r.profile} on ${r.fixture}: "${r.field}" was correct in Current but missing`);
  }
}

// ─── Verdict ────────────────────────────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("VERDICT");
console.log("══════════════════════════════════════════════════════════════════════");

const currentExact = summaryRows.find((r) => r.name === "Current")!;
const bestNonCurrent = summaryRows
  .filter((r) => r.name !== "Current")
  .reduce((best, r) => r.avgDigit > best.avgDigit ? r : best, summaryRows[0]);

const improvedDigitAcc = bestNonCurrent.avgDigit > currentExact.avgDigit + 0.01; // 1% margin
const hasRegression = regressions.length > 0;
const acceptableLatency = bestNonCurrent.avgRuntime < 15000; // 15s average

if (!improvedDigitAcc) {
  console.log("Verdict: NO WINNER — no profile materially improves digit accuracy over Current.");
} else if (hasRegression) {
  console.log(`Verdict: NO WINNER — ${bestNonCurrent.name} improves digit accuracy but introduces ${regressions.length} regression(s).`);
} else if (!acceptableLatency) {
  console.log(`Verdict: NO WINNER — ${bestNonCurrent.name} improves accuracy but avg runtime ${Math.round(bestNonCurrent.avgRuntime)}ms exceeds acceptable threshold.`);
} else {
  const delta = ((bestNonCurrent.avgDigit - currentExact.avgDigit) * 100).toFixed(1);
  console.log(`Verdict: ${bestNonCurrent.name.toUpperCase()} WINS — digit accuracy +${delta}pp, no regressions, avg ${Math.round(bestNonCurrent.avgRuntime)}ms`);
}

console.log(`\nCurrent  exact=${currentExact.totalExact}/${currentExact.totalFields}  digit=${currentExact.avgDigit.toFixed(3)}  edit=${currentExact.avgEdit.toFixed(1)}  gt=${currentExact.totalGtHits}/${currentExact.totalGtTotal}`);
console.log(`Best alt exact=${bestNonCurrent.totalExact}/${bestNonCurrent.totalFields}  digit=${bestNonCurrent.avgDigit.toFixed(3)}  edit=${bestNonCurrent.avgEdit.toFixed(1)}  gt=${bestNonCurrent.totalGtHits}/${bestNonCurrent.totalGtTotal}  [${bestNonCurrent.name}]`);

// ─── Write results ──────────────────────────────────────────────────────────

mkdirSync("benchmarks/results", { recursive: true });
writeFileSync(
  "benchmarks/results/preprocess-profiles.json",
  JSON.stringify({ generated: new Date().toISOString(), results: allResults, summary: summaryRows, regressions }, null, 2)
);
console.log("\nWrote benchmarks/results/preprocess-profiles.json");
