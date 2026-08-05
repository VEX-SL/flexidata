/**
 * LIVE diagnostic — B1 before/after on the real SuperPay receipt.
 *
 * Runs the FULL default pipeline once with a capturing AI client (real model).
 * The exact classify + extract model responses are captured, then replayed
 * verbatim through two sibling pipelines — one WITHOUT the clean stage (the
 * "before B1" output) and one WITH it ("after") — so the comparison is
 * apples-to-apples on identical model output. Read-only: nothing persisted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createDefaultPipeline } from "@/lib/pipeline/defaults";
import { classifyStage } from "@/lib/pipeline/stages/classify";
import { extractStage } from "@/lib/pipeline/stages/extract";
import { groundStage } from "@/lib/pipeline/stages/ground";
import { recoverStage } from "@/lib/pipeline/stages/recover";
import { validateStage } from "@/lib/pipeline/stages/validate";
import { confidenceStage } from "@/lib/pipeline/stages/confidence";
import type { AIClient, RunJobOutput } from "@/lib/pipeline/types";
import type { AIRequest } from "@/types";
import { SUPERYPAY_RECEIPT_OCR } from "../fixtures/receipt-ocr.ts";

const envPath = new URL("../../.env", import.meta.url);
for (const line of readEnv(envPath)) {
  if (!(line.key in process.env)) process.env[line.key] = line.value;
}

// ── 1. Capture the real model output once ──────────────────────────────────
const captured: Array<{ request: AIRequest; response: { content: string; model: string; provider: string } }> = [];
const capturing: AIClient = {
  async chatCompletion(request: AIRequest) {
    const { getProviderManager } = await import("@/lib/ai/manager");
    const response = await getProviderManager().chatCompletion(request);
    captured.push({ request, response });
    return response;
  },
};

const input = { sourceText: SUPERYPAY_RECEIPT_OCR };
const runWithClean = await createDefaultPipeline({ ai: capturing }).run(input);

const classifyRaw = captured.find((c) =>
  (c.request.messages.find((m) => m.role === "user")?.content ?? "").includes(
    "Classify this document into exactly one type"
  )
)?.response;
const extractRaw = captured.find((c) =>
  (c.request.messages.find((m) => m.role === "user")?.content ?? "").includes(
    "STRICT OUTPUT FORMAT"
  )
)?.response;
if (!classifyRaw || !extractRaw) throw new Error("failed to capture both LLM calls");

// ── 2. Replay the same model output through both pipelines ─────────────────
const replay: AIClient = {
  async chatCompletion(request: AIRequest) {
    const userMsg = request.messages.find((m) => m.role === "user")?.content ?? "";
    const raw = userMsg.includes("Classify this document into exactly one type")
      ? classifyRaw
      : extractRaw;
    if (!raw) throw new Error("unexpected replayed call");
    return raw;
  },
};

const withoutClean = await createDefaultPipeline({
  ai: replay,
  stages: [
    classifyStage({ ai: replay }),
    extractStage({ ai: replay }),
    groundStage(),
    recoverStage({ ai: replay }),
    validateStage(),
    confidenceStage(),
  ],
}).run(input);

const withCleanReplay = await createDefaultPipeline({ ai: replay }).run(input);

// ── 3. Render the comparison ───────────────────────────────────────────────
const order = [
  "receipt_number",
  "receipt_date",
  "merchant_name",
  "merchant_tax_id",
  "merchant_address",
  "customer_name",
  "currency",
  "subtotal",
  "tax_amount",
  "discount_amount",
  "total_amount",
  "payment_method",
  "cashier_name",
  "pos_number",
  "notes",
  "line_items",
];

function view(out: RunJobOutput) {
  if (out.status !== "complete" || !out.job) {
    return { status: out.status, error: out.error };
  }
  const fields: Record<string, unknown> = {};
  for (const key of order) {
    const fv = out.job!.extraction.fieldsMap[key];
    if (fv && fv.value !== null && fv.value !== undefined && fv.value !== "") {
      fields[key] = {
        value: fv.value,
        raw: fv.rawValue,
        reasons: fv.reasons ?? undefined,
        chosenReason: fv.chosenReason ?? undefined,
      };
    }
  }
  return {
    status: out.status,
    fields,
    dropped: out.job!.extraction.droppedFields,
    validationOk: out.job!.validation.ok,
    validationMissing: out.job!.validation.missing,
    overallConfidence: out.job!.confidence.overall,
    cleanStats: out.trace.find((t) => t.stage === "clean" && t.event === "finish")?.data ?? null,
    stageOrder: out.trace.map((t) => t.stage),
  };
}

const report = {
  modelResponses: { classifyRaw: classifyRaw.content, extractRaw: extractRaw.content },
  before: view(withoutClean),
  after: view(withCleanReplay),
  realRun: view(runWithClean),
};
const outPath = "C:/Users/dell/AppData/Local/Temp/opencode/b1-before-after.json";
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`\n[done] report written to ${outPath}`);

function readEnv(p: URL) {
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const out: Array<{ key: string; value: string }> = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out.push({ key: m[1], value: v });
  }
  return out;
}
