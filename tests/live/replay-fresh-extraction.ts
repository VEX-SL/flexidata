/**
 * READ-ONLY diagnostic: replay the EXACT production extraction sequence on the
 * receipt the user re-tested, fed entirely with the REPAIRED OCR the current
 * code produces (benchmarks/real/*.jpg is byte-identical to the uploaded file —
 * 253665 bytes each). Nothing is written to the database.
 *
 * Dumps:
 *  1. per-line RAW → repair changes → FINAL trace (every transformation step)
 *  2. word-level dump of the header line (why "60 SuperPay eX" is untouched)
 *  3. the exact classifier prompt (the document text the LLM actually sees)
 *  4. the exact extraction response, grounded fields, dropped fields,
 *     validation and confidence
 *
 * Run: node --experimental-strip-types --experimental-transform-types
 *   --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs
 *   tests/live/replay-fresh-extraction.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFileBufferDetailed } from "@/lib/file-parser";
import { postProcessOcr } from "@/lib/ocr/arabic";
import { runPipeline } from "@/lib/pipeline/defaults";
import { getProviderManager } from "@/lib/ai/manager";
import type { AIClient } from "@/lib/pipeline/types";
import type { AIRequest, AIResponse } from "@/types";

const envPath = new URL("../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const section = (t: string) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);
const report: Record<string, unknown> = {};
const save = (key: string, value: unknown) => {
  report[key] = value;
  console.log("\n--- " + key + " ---");
  console.log(JSON.stringify(value, null, 2));
};

const IMAGE = resolve("benchmarks/real/3268eb8f-d800-4b20-8a71-527d910e3dc2.jpg");

// ── 1. Fresh (repaired) OCR + per-line transformation trace ──────────────
section("STEP 1 — FRESH OCR + PER-LINE TRANSFORMATION TRACE (repaired text)");
const buffer = readFileSync(IMAGE);
const parsed = await parseFileBufferDetailed(buffer, "image/jpeg", "photo.jpg");
const freshText: string = parsed.text;
const ocrDoc = parsed.ocr!;
save("fresh_ocr_text", freshText);

const rawLines = ocrDoc.lines.map((l) => l.originalText ?? l.text);
const { report: repairReport } = postProcessOcr(ocrDoc);
const traceLines = ocrDoc.lines.map((l, i) => ({
  index: i,
  raw: l.originalText ?? l.text,
  final: l.text,
  changed: l.repaired ?? false,
  sourceLine: l.sourceLine,
  quality: l.quality
    ? {
        noiseScore: l.quality.noiseScore,
        arabicRatio: l.quality.arabicRatio,
        latinRatio: l.quality.latinRatio,
        scriptConsistency: l.quality.scriptConsistency,
        printableRatio: l.quality.printableRatio,
        ocrConfidence: l.quality.ocrConfidence ?? null,
        reasons: l.quality.reasons,
      }
    : null,
}));
save("transformation_trace", {
  rawLineCount: rawLines.length,
  repairedLineCount: traceLines.length,
  linesChanged: repairReport.linesChanged,
  changeEvents: repairReport.changes,
  lines: traceLines,
});

// Header line word dump: why "60 SuperPay eX" is untouched by the repair layer.
const header = ocrDoc.lines.find((l) => (l.originalText ?? l.text).includes("SuperPay"));
save("header_line_word_dump", header
  ? {
      line: header.text,
      words: header.words.map((w) => ({
        text: w.text,
        confidence: w.confidence ?? null,
        bbox: w.bbox ?? null,
      })),
    }
  : null);

// ── 2. Instrumented pipeline run on the REPAIRED text (production path) ──
section("STEP 2 — PIPELINE RUN CONSUMING THE REPAIRED OCR (fresh sourceText + fresh ocr)");
interface CapturedCall {
  stage: string;
  request: AIRequest;
  response: AIResponse;
}
const calls: CapturedCall[] = [];
const wrapped: AIClient = {
  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    const response = await getProviderManager().chatCompletion(request);
    calls.push({ stage: "?", request, response });
    return response;
  },
};

const out = await runPipeline(
  { sourceText: freshText, ocr: ocrDoc, fileName: "photo.jpg", mimeType: "image/jpeg" },
  { ai: wrapped }
);

for (const c of calls) {
  const userMsg = c.request.messages.find((m) => m.role === "user")?.content ?? "";
  c.stage = userMsg.includes("Classify this document into exactly one type")
    ? "classify"
    : userMsg.includes("STRICT OUTPUT FORMAT")
      ? "extract"
      : "other";
}

const classifyCall = calls.find((c) => c.stage === "classify");
const extractCall = calls.find((c) => c.stage === "extract");
const classifyUser = classifyCall?.request.messages.find((m) => m.role === "user")?.content ?? "";
const docSeenByLlm = classifyUser.slice(classifyUser.indexOf("Document (first"));

save("document_text_llm_received", docSeenByLlm);
save("classify_response", classifyCall?.response.content ?? null);
save("extract_raw_response", extractCall?.response.content ?? null);

save("grounded_final_fields", out.job!.extraction.fields.map((f) => ({
  key: f.field.key,
  value: f.value.value,
  raw: f.value.rawValue,
  confidence: f.value.confidence,
  status: f.value.status,
  evidence: f.value.evidence,
})));
save("dropped_fields", out.job!.extraction.droppedFields);
save("validation", out.job!.validation);
save("confidence", out.job!.confidence);

const outPath = resolve("C:/Users/dell/AppData/Local/Temp/opencode/replay-fresh-extraction.json");
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log(`\n[done] report written to ${outPath}`);
