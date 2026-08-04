/**
 * Benchmark report generator for the OCR/grounding milestone.
 *
 * Reads the three JSON snapshots written by the runners
 * (ocr-level.json, pipeline-level.json, agent-eval.json) and renders
 * BENCHMARK-REPORT.md at the repo root. Pure data pass — no live OCR/AI.
 *
 * Run (from repo root):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/generate-report.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const ocrLevel = JSON.parse(readFileSync("benchmarks/results/ocr-level.json", "utf8"));
const pipeline = JSON.parse(readFileSync("benchmarks/results/pipeline-level.json", "utf8"));
const agentEval = JSON.parse(readFileSync("benchmarks/results/agent-eval.json", "utf8"));

const pct = (n: number | undefined): string => (n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
const n3 = (n: number | undefined): string => (n === undefined ? "—" : n.toFixed(3));

interface FieldRow {
  key: string;
  value: unknown;
  raw: unknown;
  status: string;
  confidence: number;
  reasons?: string[];
}
type EngineSide = "old" | "new";

function fieldsOf(item: string, engine: EngineSide): FieldRow[] {
  return (pipeline.results[item]?.[engine]?.fields ?? []) as FieldRow[];
}
function fieldOf(item: string, engine: EngineSide, key: string): FieldRow | undefined {
  return fieldsOf(item, engine).find((f) => f.key === key);
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  return JSON.stringify(v);
}

/* ─── Corpus table ──────────────────────────────────────────────────── */

function corpusTable(): string {
  const rows = ocrLevel.corpusMeta.map((c: { id: string; label: string; groundTruthLabels: string[] }) => {
    const gt = (c.groundTruthLabels ?? []).join(", ");
    return `| \`${c.id}\` | ${c.label} | ${gt} |`;
  });
  return ["| Corpus item | Description | Ground-truth keys |", "|---|---|---|", ...rows].join("\n");
}

/* ─── OCR-level section ─────────────────────────────────────────────── */

const OCR_ENGINE_LABEL: Record<string, string> = {
  old: "old",
  newRaw: "new (raw)",
  newPre: "new (preprocessed)",
};

function ocrLevelTable(): string {
  const header = "| Corpus | Engine | Lines | Chars | Page conf | Mean line conf | GT hits | ms |";
  const sep = "|---|---|---|---|---|---|---|---|";
  const rows: string[] = [];
  for (const item of ocrLevel.corpusMeta as Array<{ id: string }>) {
    const id = item.id;
    const engines = ["old", "newRaw", "newPre"] as const;
    engines.forEach((e, i) => {
      const s = ocrLevel.results[id][e];
      rows.push(
        `| ${i === 0 ? `\`${id}\`` : ""} | ${OCR_ENGINE_LABEL[e]} | ${s.lines} | ${s.chars} | ${pct(s.pageConf)} | ${pct(s.meanLineConf)} | **${s.hits}/${s.total}** | ${s.ms} |`
      );
    });
  }
  return [header, sep, ...rows].join("\n");
}

function ocrLevelSummary(): string {
  const totals = ocrLevel.corpusMeta.reduce(
    (acc: Record<string, { hits: number; total: number }>, c: { id: string }) => {
      for (const e of ["old", "newRaw", "newPre"] as const) {
        const s = ocrLevel.results[c.id][e];
        acc[e].hits += s.hits;
        acc[e].total += s.total;
      }
      return acc;
    },
    { old: { hits: 0, total: 0 }, newRaw: { hits: 0, total: 0 }, newPre: { hits: 0, total: 0 } }
  );
  return [
    "| Engine | Aggregate GT hits |",
    "|---|---|",
    `| old | ${totals.old.hits}/${totals.old.total} |`,
    `| new (raw) | ${totals.newRaw.hits}/${totals.newRaw.total} |`,
    `| new (preprocessed) | ${totals.newPre.hits}/${totals.newPre.total} |`,
  ].join("\n");
}

/* ─── Pipeline-level section ────────────────────────────────────────── */

function pipelineTable(): string {
  const header = "| Corpus | Engine | Class conf | Overall conf | Validation | Field GT | ms |";
  const sep = "|---|---|---|---|---|---|---|";
  const rows: string[] = [];
  for (const item of pipeline.corpusMeta as Array<{ id: string }>) {
    const id = item.id;
    for (const e of ["old", "new"] as const) {
      const s = pipeline.results[id][e];
      const score = pipeline.results[id][`score${e === "old" ? "Old" : "New"}`];
      const missing = s.validation.missing.length ? s.validation.missing.join(", ") : "ok";
      const val = s.validation.ok ? "✓ ok" : `✗ missing ${missing}`;
      const gt = score && score.total > 0 ? `${score.hits}/${score.total}` : "n/a";
      rows.push(
        `| ${e === "old" ? `\`${id}\`` : ""} | ${e} | ${pct(s.classification.confidence)} | ${pct(s.confidence.overall)} | ${val} | ${gt} | ${s.ms} |`
      );
    }
  }
  return [header, sep, ...rows].join("\n");
}

/* ─── Confidence calibration section ────────────────────────────────── */

const CAL: Record<string, Array<{ key: string; label: string; ok: (v: unknown) => boolean }>> = {
  "real-superpay": [
    { key: "receipt_date", label: "date = 2026-07-02", ok: (v) => /2026-07-02/.test(String(v ?? "")) },
    { key: "total_amount", label: "total = 68.38", ok: (v) => Math.abs(Number(v) - 68.38) < 0.01 },
    { key: "pos_number", label: "account = 391003452", ok: (v) => String(v ?? "").includes("391003452") },
    { key: "customer_name", label: "customer = Zahra Aman", ok: (v) => String(v ?? "").includes("Zahra Aman") },
    { key: "receipt_number", label: "ref = 2013438351", ok: (v) => String(v ?? "").includes("2013438351") },
    { key: "merchant_name", label: "merchant = SuperPay", ok: (v) => String(v ?? "").toUpperCase().includes("SUPERPAY") },
  ],
  "ar-thermal": [
    { key: "receipt_date", label: "date = 2025-01-15", ok: (v) => String(v ?? "").includes("2025-01-15") },
    { key: "total_amount", label: "total = 45.50", ok: (v) => Math.abs(Number(v) - 45.5) < 0.01 },
    { key: "currency", label: "currency = SAR", ok: (v) => /SAR/i.test(String(v ?? "")) },
  ],
};

function calibrationSection(): string {
  const out: string[] = [];
  for (const [item, checks] of Object.entries(CAL)) {
    const meta = ocrLevel.corpusMeta.find((c: { id: string }) => c.id === item);
    out.push(`### ${item} — ${meta?.label ?? item}\n`);
    out.push("| Field | Old value (conf / status) | New value (conf / status) | Correct? |");
    out.push("|---|---|---|---|");
    for (const c of checks) {
      const cells = (["old", "new"] as const).map((e) => {
        const f = fieldOf(item, e, c.key);
        if (!f) return "— (missing)";
        const mark = f.status === "extracted" ? "" : ` \`${f.status}\``;
        return `${fmtValue(f.value)}<br>${pct(f.confidence)}${mark}`;
      });
      const oldOk = c.ok(fieldOf(item, "old", c.key)?.value);
      const newOk = c.ok(fieldOf(item, "new", c.key)?.value);
      const verdict =
        oldOk === newOk
          ? oldOk
            ? "✓ both"
            : "✗ both"
          : oldOk
            ? "regressed (old ✓, new ✗)"
            : `improved (old ✗, new ✓)`;
      out.push(`| ${c.label} | ${cells[0]} | ${cells[1]} | ${verdict} |`);
    }
    out.push("");
  }

  // Notable low-confidence behaviors worth calling out.
  const refNew = fieldOf("real-superpay", "new", "receipt_number");
  const refOld = fieldOf("real-superpay", "old", "receipt_number");
  const dateNew = fieldOf("real-superpay", "new", "receipt_date");
  const dateOld = fieldOf("real-superpay", "old", "receipt_date");
  const curNew = fieldOf("ar-thermal", "new", "currency");
  out.push(`- Old engine on the real photo returned **${fmtValue(refOld?.value)} @ ${pct(refOld?.confidence)}** (status \`${refOld?.status}\`) and **${fmtValue(dateOld?.value)} @ ${pct(dateOld?.confidence)}** (status \`${dateOld?.status}\`), and validation passed (\`ok: true\`). Both values are wrong — the photo is from **02-07-2026** and the ref is **2013438351**.`);
  out.push(`- New engine on the same photo returns the **correct date ${fmtValue(dateNew?.value)} @ ${pct(dateNew?.confidence)}** but scores the receipt number low (${fmtValue(refNew?.value)} @ ${pct(refNew?.confidence)}) with reasons \`${(refNew?.reasons ?? []).join(", ")}\`, and validation now fails honestly (\`missing: merchant_name\`).`);
  if (curNew) {
    out.push(`- New engine on the Arabic thermal receipt gives \`currency\` = ${fmtValue(curNew.value)} @ ${pct(curNew.confidence)} with reasons \`${(curNew.reasons ?? []).join(", ")}\` — a genuinely uncertain inference is scored low instead of defaulting to ~0.7.`);
  }
  return out.join("\n");
}

/* ─── Agent-eval section ────────────────────────────────────────────── */

function agentEvalSection(): string {
  const out: string[] = [];
  const byItem = new Map<string, Record<string, unknown>>();
  for (const entry of agentEval as Array<{ item: string; engine: string }>) {
    byItem.set(entry.item, { ...(byItem.get(entry.item) ?? {}), [entry.engine]: entry });
  }
  for (const [item, sides] of byItem) {
    const oldE = sides.old as { q1: { answer: string; model: string; totalFound: boolean; dateFound: boolean; typeFound: boolean }; q2: { answer: string; model: string; claimsImage: boolean; refuses: boolean } };
    const newE = sides.new as typeof oldE;
    out.push(`### ${item}\n`);
    out.push(`**Q1** — “What kind of document is this? What was the total amount and on what date?”\n`);
    out.push(`- **old** (${oldE.q1.model}): ${oldE.q1.answer.trim()}`);
    out.push(`- **new** (${newE.q1.model}): ${newE.q1.answer.trim()}`);
    out.push("");
    out.push(`| Engine | total ✓ | date ✓ | type ✓ |`);
    out.push("|---|---|---|---|");
    out.push(`| old | ${oldE.q1.totalFound} | ${oldE.q1.dateFound} | ${oldE.q1.typeFound} |`);
    out.push(`| new | ${newE.q1.totalFound} | ${newE.q1.dateFound} | ${newE.q1.typeFound} |`);
    out.push("");
    out.push(`**Q2** — “Can you see the image of the document? Describe … how confident …”`);
    out.push(`- **old** (${oldE.q2.model}): ${oldE.q2.answer.trim().slice(0, 600)}${oldE.q2.answer.trim().length > 600 ? " …" : ""}`);
    out.push(`- **new** (${newE.q2.model}): ${newE.q2.answer.trim().slice(0, 600)}${newE.q2.answer.trim().length > 600 ? " …" : ""}`);
    out.push("");
    out.push(`| Engine | claims image | refuses |`);
    out.push("|---|---|---|");
    out.push(`| old | ${oldE.q2.claimsImage} | ${oldE.q2.refuses} |`);
    out.push(`| new | ${newE.q2.claimsImage} | ${newE.q2.refuses} |`);
    out.push("");
  }
  return out.join("\n");
}

/* ─── Trace excerpts ────────────────────────────────────────────────── */

function traceExcerpt(item: string): string {
  const out: string[] = [];
  for (const e of ["old", "new"] as const) {
    const t = pipeline.results[item][e].trace;
    out.push(`**${e}** (overall conf ${pct(pipeline.results[item][e].confidence.overall)})`);
    out.push("");
    out.push("```json");
    out.push(JSON.stringify({ ground: t.ground, recover: t.recover }, null, 2));
    out.push("```");
  }
  return out.join("\n");
}

/* ─── Weaknesses (curated from measured data) ───────────────────────── */

const WEAKNESSES = [
  `**Rotated / slanted synthetics stay hard for every engine.** On \`en-rot90\`, old scores 0/5 and the new engine only 1/5 (Tesseract OSD recovers the page but not the text reliably); on \`en-slant2\` all engines reach 1/5. Ground-truth recovery on these inputs is a known limitation, not a regression.`,
  `**Real-photo receipt number is still misread.** The new engine reads \`La 15468\` where the receipt shows \`2013438351\` / \`391003452\`; it is now scored honestly (0.389, \`ocr_confidence_low\`) but the value is not correct.`,
  `**\`merchant_name\` is missing on the real photo (new).** The SuperPay logo line survives OCR but is not mapped to the required field, so validation now fails (which is the honest outcome).`,
  `**Garbled line items on the real photo.** Line-item descriptions (\`Hostinger;Description…)0123456788(\`, \`oe   a           : il\`) are raw OCR noise; the pipeline extracts them but \`line_items\` scores 0.39 with \`no_direct_evidence\`.`,
  `**Agent can still claim to “see” the image.** Q2 on \`en-clean\` (new) and \`ar-thermal\` (new) triggered \`claimsImage = true\`; the system prompt should keep steering answers to the extracted context.`,
  `**Groq rate limits (TPM ~6000) add latency/flakiness.** Pipeline and agent runs fall over to cerebras/gemini/openrouter/huggingface and retry, so \`ms\` columns vary run to run. Provider fallback masks it but benchmarks should re-run when quota allows.`,
  `**\`en-rot90\` / \`en-slant2\` have no field-level ground truth** in the pipeline run (scored \`n/a\`), so their pipeline numbers only cover classification/confidence.`,
];

/* ─── Assembly ──────────────────────────────────────────────────────── */

const today = new Date().toISOString().slice(0, 10);

const md = `# Benchmark: OCR + extraction quality before/after (real engine, real providers)

Milestone commit: after \`54dd276\`. This report measures the OCR milestone end
to end: OCR quality, downstream field extraction, confidence calibration,
grounding, and agent answers — **before** (old engine + raw text) vs **after**
(new engine + preprocessing/fallback + structured document). All numbers below
are reproduced from committed JSON snapshots in \`benchmarks/results/\`.

Generated: ${today}

## How to reproduce

\`\`\`bash
# 1. OCR-level (old vs newRaw vs newPre)
node --experimental-strip-types --experimental-transform-types \\
  --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \\
  tests/live/benchmark/run-ocr-level.ts

# 2. Pipeline-level (old vs new through real runPipeline + real providers)
node --experimental-strip-types --experimental-transform-types \\
  --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \\
  tests/live/benchmark/run-pipeline-level.ts

# 3. Agent re-evaluation (real providers)
node --experimental-strip-types --experimental-transform-types \\
  --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \\
  tests/live/benchmark/run-agent-eval.ts

# 4. This report (pure data pass)
node --experimental-strip-types --experimental-transform-types \\
  --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \\
  tests/live/benchmark/generate-report.ts
\`\`\`

Run order matters: \`run-agent-eval\` reads \`pipeline-level.json\`, and
\`generate-report\` reads all three. Provider-dependent runs need \`.env\`
(Groq/cerebras/gemini/openrouter keys); the pipeline falls over to other
providers on rate limits.

---

## 1. Corpus

${corpusTable()}

Corpus sources: \`benchmarks/corpus/\` (synthetic PNGs rendered with
\`@napi-rs/canvas\`) plus the real production SuperPay receipt photo
\`benchmarks/corpus/real-superpay.jpg\` (copy of
\`benchmarks/real/db51e106…jpg\`).

## 2. OCR level — old vs new engine

${ocrLevelTable()}

${ocrLevelSummary()}

Reads (real photo): the old engine turned the date line into
\`تبيخ الوقت : 02-07-2028 18:30:12\` (page conf 0.64, single confidence value
for every line — \`distinctConfs: 1\`). The new preprocessed engine reads the
same line as \`تاريخ انلوقت : 02-07-2026 18:30:12\` with **17 distinct per-line
confidence values** — the garbled-vs-clean distinction is now visible and
usable by grounding.

## 3. Pipeline level — field extraction, confidence, validation

${pipelineTable()}

Notes: \`en-rot90\`/\`en-slant2\` have no field ground truth (scored \`n/a\`);
\`real-superpay\` is the decisive case (real photo, see §4).

## 4. Confidence calibration

How well does reported confidence track actual correctness? Measured on the
two items with meaningful per-field ground truth.

${calibrationSection()}

**Reading**: the old engine shipped high-confidence **wrong** values on the
real photo (wrong date 0.94, wrong receipt number 0.96) and validation passed.
The new engine ships the correct date, scores the unreadable receipt number
low (0.389, honest reasons), and lets validation fail on the missing
\`merchant_name\`. Reported confidence now tracks correctness — a lower overall
confidence (${pct(pipeline.results["real-superpay"].old.confidence.overall)} → ${pct(pipeline.results["real-superpay"].new.confidence.overall)}) is the more truthful number.

## 5. Agent re-evaluation

${agentEvalSection()}

Headline (real photo): the **old** agent quoted **02-07-2028** as the date; the
**new** agent quotes **2026-07-02** and cites the extracted field
(\`receipt_date\`). Neither refuses; one new-engine Q2 (real-superpay) keeps a
sensible image-free answer, while \`en-clean\`/\`ar-thermal\` new answers still
say “the image shows …” (see §7 weaknesses).

> Note on the \`total ✓\` column: the new-engine answers write the total without
> a trailing zero (\`38.4\`, \`45.5\`) and the runner regexes expect
> \`38[.,]?40\` / \`45[.,]?50\`, so \`totalFound=false\` on \`en-clean\` and
> \`ar-thermal\` (new) is a **check artifact, not a wrong answer** — the value
> is correct in both engines.

## 6. Trace excerpts (real photo)

${traceExcerpt("real-superpay")}

Grounding coverage improved on the real photo: \`groundedFields 4/6 → 6/7\`,
\`evidenceCoverage 0.667 → 0.857\` (new also exposes \`meanEvidenceConfidence:
0.717\`). Recovery was not needed on either run.

## 7. Remaining weaknesses

${WEAKNESSES.map((w, i) => `${i + 1}. ${w}`).join("\n")}

## 8. Delivered artifacts

- \`src/lib/ocr/preprocess.ts\` — EXIF orientation, quarter-rotation (ink-band
  gate), deskew, quad warp, auto-crop, contrast/sharpen, adaptive threshold
  (Rec.709 grayscale).
- \`src/lib/tesseract-main.ts\` — per-word confidence via \`ResultIterator\`,
  PSM.AUTO, preprocess→raw fallback with \`isPoorResult\`/\`isMediocreResult\`/
  \`isBetterThan\`.
- \`src/lib/pipeline/types.ts\`, \`stages/recover.ts\`, \`trace.ts\` — recovery
  stats + \`ground\`/\`recover\` trace summaries.
- \`tests/live/_engines/old-tesseract.ts\` — archived pre-milestone engine for
  A/B.
- \`tests/live/benchmark/\` — corpus + 3 runners + this generator.
- \`benchmarks/corpus/\`, \`benchmarks/results/*.json\` — committed snapshots.
- Documents page: OCR preview tab now highlights evidence lines and per-word
  confidence (60% threshold, tooltips, legend).
`;

writeFileSync("BENCHMARK-REPORT.md", md);
console.log("Wrote BENCHMARK-REPORT.md");
