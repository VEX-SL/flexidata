/**
 * Agent re-evaluation: same questions against the OLD (raw-text) and NEW
 * (structured-extraction) document context, using real providers.
 *
 * Checks per the milestone:
 *   1. correct document identification,
 *   2. never claims to "see the image" / never refuses to answer,
 *   3. structured_content is used as the primary signal,
 *   4. natural answers with the actual totals/dates,
 *   5. uncertainty is explained when fields are flagged/low-confidence,
 *   6. does not parrot garbled OCR garbage.
 *
 * Run (from repo root):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/run-agent-eval.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { recognizeMainThread as oldRecognize } from "../_engines/old-tesseract";
import { recognizeMainThread as newRecognize } from "@/lib/tesseract-main";
import { buildAgentDocumentContext } from "@/lib/agent/document-context";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { getProviderManager } from "@/lib/ai/manager";
import type { StructuredDocument } from "@/lib/pipeline/structured-document";
import { buildCorpus } from "./corpus";
import type { CorpusItem } from "./corpus";

const envPath = new URL("../../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

type Sample = { classification: { profileType: string }; validation: { missing: string[] }; confidence: { overall: number }; fields: Array<{ key: string; value: unknown; raw: unknown; status: string; confidence: number; reasons?: string[]; evidence?: Array<{ quote: string; confidence?: number }> }> };

function structuredFromSample(sample: Sample, profileLabel: string): StructuredDocument {
  return {
    profileType: sample.classification.profileType,
    profileLabel,
    overallConfidence: sample.confidence.overall,
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

interface EvalEntry {
  item: string;
  engine: "old" | "new";
  q1: { question: string; answer: string; model: string; totalFound: boolean; dateFound: boolean; typeFound: boolean };
  q2: { question: string; answer: string; model: string; claimsImage: boolean; refuses: boolean };
}

const QUESTIONS = {
  q1: "What kind of document is this? What was the total amount and on what date?",
  q2: "Can you see the image of the document? Describe what it looks like and how confident you are in the extracted values.",
};

const EXPECTED: Record<string, { total: RegExp; date: RegExp; type: string }> = {
  "en-clean": { total: /38[.,]?40/, date: /2025-01-15/, type: "receipt" },
  "en-lowcontrast": { total: /38[.,]?40/, date: /2025-01-15/, type: "receipt" },
  "ar-thermal": { total: /45[.,]?50/, date: /2025-01-15/, type: "receipt" },
  "real-superpay": { total: /68[.,]?38/, date: /2026-07-02|02[-/]07[-/]2026/, type: "receipt" },
};

async function ask(systemPrompt: string, q: string): Promise<{ answer: string; model: string }> {
  const manager = getProviderManager();
  const r = await manager.chatCompletion({
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: q }],
    maxTokens: 500,
    temperature: 0,
  });
  return { answer: r.content ?? "", model: r.model ?? "unknown" };
}

const corpus = await buildCorpus();
const saved = JSON.parse(readFileSync("benchmarks/results/pipeline-level.json", "utf8"));
mkdirSync("benchmarks/results", { recursive: true });

const entries: EvalEntry[] = [];
const TARGETS = ["en-clean", "ar-thermal", "real-superpay"];

for (const item of corpus) {
  if (!TARGETS.includes(item.id)) continue;
  const exp = EXPECTED[item.id];
  const oldText = (await oldRecognize(item.buffer, "eng+ara")).text;
  const newDoc = await newRecognize(item.buffer, "eng+ara", { preprocess: true });
  const newSample: Sample = saved.results[item.id].new;
  const oldSample: Sample = saved.results[item.id].old;

  const oldRow = { title: `${item.id}.png`, parsed_content: oldText };
  const newRow = {
    title: `${item.id}.png`,
    parsed_content: newDoc.text,
    structured_content: structuredFromSample(newSample, "Receipt"),
  };

  const oldCtx = buildAgentDocumentContext([oldRow]);
  const newCtx = buildAgentDocumentContext([newRow]);
  console.log(`\n=== ${item.id}: context structured/raw = ${newCtx.structuredCount}/${newCtx.rawCount} vs old ${oldCtx.structuredCount}/${oldCtx.rawCount} ===`);

  for (const [engine, systemPrompt] of [
    ["old", buildSystemPrompt("agent") + `\n\n## Provided Context:\n${oldCtx.context}`],
    ["new", buildSystemPrompt("agent") + `\n\n## Provided Context:\n${newCtx.context}`],
  ] as const) {
    const a1 = await ask(systemPrompt, QUESTIONS.q1);
    const totalFound = exp.total.test(a1.answer);
    const dateFound = exp.date.test(a1.answer);
    const typeFound = /receipt|إيصال|invoice/i.test(a1.answer) && /receipt|إيصال/i.test(a1.answer);
    console.log(`\n[${engine}] Q1 (${a1.model}): ${a1.answer.slice(0, 300)}`);
    console.log(`   checks: total=${totalFound} date=${dateFound} type=${typeFound}`);

    const a2 = await ask(systemPrompt, QUESTIONS.q2);
    const claimsImage = /i can (see|view) the image|the image (shows|displays)|in the image/i.test(a2.answer);
    const refuses = /i (can|do not) (see|view) an image|cannot see the image|no image|i'm sorry/i.test(a2.answer) && !/based on|from the extracted|structured|ocr text/i.test(a2.answer);
    console.log(`[${engine}] Q2 (${a2.model}): ${a2.answer.slice(0, 300)}`);
    console.log(`   checks: claimsImage=${claimsImage} refuses=${refuses}`);

    entries.push({
      item: item.id,
      engine: engine as "old" | "new",
      q1: { question: QUESTIONS.q1, answer: a1.answer, model: a1.model, totalFound, dateFound, typeFound },
      q2: { question: QUESTIONS.q2, answer: a2.answer, model: a2.model, claimsImage, refuses },
    });
  }
}

writeFileSync("benchmarks/results/agent-eval.json", JSON.stringify(entries, null, 2));
console.log("\nWrote benchmarks/results/agent-eval.json");
