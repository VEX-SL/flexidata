/**
 * Paddle-rescue benchmark: additive gated rescue over the full corpus.
 *
 * Runs the production pipeline twice per fixture — before (recall recovery
 * only) and after (recall recovery + gated Paddle rescue) — and measures:
 *   - rescue trigger rate (per fixture, by gate)
 *   - region requests issued, accepted vs rejected rescues
 *   - GT hit deltas and added latency
 *
 * Mode:
 *   - Mock (default): creates a local mock server returning scripted readings.
 *   - Real service: set PADDLE_OCR_URL externally to skip mock creation.
 *
 * Run (from repo root):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/benchmark/run-paddle-rescue.ts
 *   FIXTURE=scan-blur node ... (single fixture)
 *   PADDLE_OCR_URL=http://127.0.0.1:8000 node ... (real service)
 */
import { createServer, type Server } from "node:http";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { buildCorpus, scoreText } from "./corpus";
import type { CorpusItem } from "./corpus";
import type { PaddleRescueRecord } from "@/lib/ocr/paddle-rescue";

interface PaddleTextItem {
  text: string;
  confidence: number;
  bbox?: { x: number; y: number; width: number; height: number };
}

function line(text: string, i: number, confidence = 0.99): PaddleTextItem {
  return { text, confidence, bbox: { x: 24, y: 26 + 34 * i, width: 420, height: 24 } };
}

/** Real PP-OCRv6_medium (en, onnxruntime) reading of the blurred-scan receipt. */
const EN_RECEIPT_SCRIPT: PaddleTextItem[] = [
  line("AL RABIH SUPERMARKET", 0, 1.0),
  line("Riyadh, KSA Tel: 011-555-1212", 1, 0.984),
  line("Date: 2025-01-15 15:42", 2, 0.988),
  line("Sugar 1kg", 3, 1.0),
  line("6.50", 4, 1.0),
  line("Milk 1L", 5, 0.998),
  line("7.00", 6, 1.0),
  line("Rice 5kg", 7, 1.0),
  line("24.90", 8, 1.0),
  line("TOTAL", 9, 1.0),
  line("38.40", 10, 1.0),
  line("Cash", 11, 1.0),
  line("50.00", 12, 0.999),
  line("Change", 13, 1.0),
  line("11.60", 14, 1.0),
  line("Thank you for shopping", 15, 0.96),
];

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
  recallDetected: boolean;
  triggered: boolean;
  skippedReason?: string;
  regions: PaddleRescueRecord["regions"];
  attempts: PaddleRescueRecord["attempts"];
  accepted: number;
  requests: number;
  addedLatencyMs: number;
  ocrMs: number;
}

function paddleRecord(doc: Awaited<ReturnType<typeof recognizeMainThread>>): PaddleRescueRecord | undefined {
  return doc.meta?.paddleRescue as PaddleRescueRecord | undefined;
}

async function runOnce(
  buffer: Buffer,
  rescue: boolean
): Promise<{ doc: Awaited<ReturnType<typeof recognizeMainThread>>; ms: number }> {
  const t0 = performance.now();
  const doc = await recognizeMainThread(
    buffer,
    "ara+eng",
    rescue
      ? { recoverRecall: true, recoveryBudgetMs: 20_000, rescuePaddle: true }
      : { recoverRecall: true, recoveryBudgetMs: 20_000 }
  );
  return { doc, ms: Math.round(performance.now() - t0) };
}

const corpus = await buildCorpus();

const realServiceUrl = process.env.PADDLE_OCR_URL;
const useRealService = !!realServiceUrl && !realServiceUrl.includes(":0");
let mockServer: Server | null = null;

if (useRealService) {
  console.log(`\n[MODE] Real PaddleOCR service: ${realServiceUrl}`);
} else {
  mockServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ texts: EN_RECEIPT_SCRIPT }));
    });
  });
  await new Promise<void>((resolve) => mockServer!.listen(0, "127.0.0.1", resolve));
  const port = (mockServer.address() as { port: number }).port;
  process.env.PADDLE_OCR_URL = `http://127.0.0.1:${port}/v1/paddle`;
  console.log(`\n[MODE] Mock PaddleOCR service: ${process.env.PADDLE_OCR_URL}`);
}

const filter = process.env.FIXTURE;
const items = filter ? corpus.filter((i) => i.id === filter) : corpus;
const results: FixtureResult[] = [];

for (const item of items) {
  console.log(`\n=== ${item.id} — ${item.label} ===`);

  const before = await runOnce(item.buffer, false);
  const after = await runOnce(item.buffer, true);

  const b = scoreText(before.doc.text, item);
  const a = scoreText(after.doc.text, item);
  const rec = paddleRecord(after.doc);

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
    recallDetected: after.doc.meta?.recallRecovery?.detected ?? false,
    triggered: rec?.triggered ?? false,
    skippedReason: rec?.skippedReason ?? (rec ? undefined : "gate:early"),
    regions: rec?.regions ?? [],
    attempts: rec?.attempts ?? [],
    accepted: rec?.accepted ?? 0,
    requests: rec?.attempts.length ?? 0,
    addedLatencyMs: Math.max(0, after.ms - before.ms),
    ocrMs: before.ms,
  };
  results.push(r);

  console.log(
    `  GT hits: ${r.beforeHits}/${r.total} -> ${r.afterHits}/${r.total}` +
      `  lines: ${r.linesBefore} -> ${r.linesAfter}` +
      `  OCR=${r.ocrMs}ms +rescue=${r.addedLatencyMs}ms`
  );
  console.log(
    `  rescue: recall=${r.recallDetected} triggered=${r.triggered}${r.skippedReason ? ` skipped=${r.skippedReason}` : ""}` +
      ` regions=${r.regions.length} requests=${r.requests} accepted=${r.accepted}`
  );
  for (const at of r.attempts) {
    const rej = at.rejected.map((x) => `${x.value}(${x.reason})`).join(", ") || "-";
    console.log(`    attempt ${at.region}: ${at.reason} texts=${at.paddleTexts} accepted=${at.accepted} rejected=[${rej}] ${at.latencyMs}ms${at.error ? ` error=${at.error}` : ""}`);
  }
}

console.log("\n════════════════════════════════════════════════");
console.log("PER-FIXTURE TABLE");
console.log("════════════════════════════════════════════════");
console.log("Fixture          | GT  | Hits B->A | Lines B->A | Recall | Rescue | Req | Acc | +Rescue(ms)");
for (const r of results) {
  console.log(
    `${r.id.padEnd(17)}| ${String(r.total).padEnd(3)} | ${String(r.beforeHits).padEnd(2)} -> ${String(r.afterHits).padEnd(2)} | ${String(r.linesBefore).padEnd(2)} -> ${String(r.linesAfter).padEnd(2)} | ${(r.recallDetected ? "YES" : "no").padEnd(6)} | ${(r.triggered ? "YES" : "no").padEnd(5)} | ${String(r.requests).padEnd(3)} | ${String(r.accepted).padEnd(3)} | ${r.addedLatencyMs}`
  );
}

const totalHitsBefore = results.reduce((s, r) => s + r.beforeHits, 0);
const totalHitsAfter = results.reduce((s, r) => s + r.afterHits, 0);
const totalKeys = results.reduce((s, r) => s + r.total, 0);
const triggered = results.filter((r) => r.triggered);
const regressions = results.filter((r) => r.afterHits < r.beforeHits);

console.log("\n════════════════════════════════════════════════");
console.log("SUMMARY");
console.log("════════════════════════════════════════════════");
console.log(`GT hits before : ${totalHitsBefore}/${totalKeys}`);
console.log(`GT hits after  : ${totalHitsAfter}/${totalKeys}`);
console.log(`rescue triggered on : ${triggered.length}/${results.length} docs`);
console.log(
  `requests issued : ${results.reduce((s, r) => s + r.requests, 0)}` +
    `  accepted rescues: ${results.reduce((s, r) => s + r.accepted, 0)}`
);
console.log(`regressions : ${regressions.length === 0 ? "none" : regressions.map((r) => r.id).join(", ")}`);

// ─── Graceful degradation tests ──────────────────────────────────────────

console.log("\n════════════════════════════════════════════════");
console.log("GRACEFUL DEGRADATION TESTS");
console.log("════════════════════════════════════════════════");

const scanBlurItem = corpus.find((i) => i.id === "scan-blur")!;
const degradationResults: Array<{ name: string; passed: boolean; detail: string }> = [];

// Test 1: Service unavailable (dead port)
{
  const saved = process.env.PADDLE_OCR_URL;
  process.env.PADDLE_OCR_URL = "http://127.0.0.1:19999/v1/ocr";
  try {
    const t0 = performance.now();
    const doc = await recognizeMainThread(scanBlurItem.buffer, "ara+eng", {
      recoverRecall: true, recoveryBudgetMs: 20_000, rescuePaddle: true,
    });
    const ms = Math.round(performance.now() - t0);
    const rec = doc.meta?.paddleRescue as PaddleRescueRecord | undefined;
    const ok = rec?.skippedReason === "paddle_unreachable" || rec?.attempts?.some((a) => a.error === "paddle_unreachable");
    degradationResults.push({ name: "service unavailable", passed: ok, detail: `reason=${rec?.skippedReason ?? "none"} error=${rec?.attempts?.[0]?.error ?? "none"} lines=${doc.lines.length} ms=${ms}` });
  } catch (e) {
    degradationResults.push({ name: "service unavailable", passed: false, detail: `CRASH: ${(e as Error).message}` });
  }
  process.env.PADDLE_OCR_URL = saved;
}

// Test 2: Malformed response (mock returns garbage)
{
  const saved = process.env.PADDLE_OCR_URL;
  const garbageServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("NOT JSON AT ALL");
    });
  });
  await new Promise<void>((resolve) => garbageServer.listen(0, "127.0.0.1", resolve));
  const gPort = (garbageServer.address() as { port: number }).port;
  process.env.PADDLE_OCR_URL = `http://127.0.0.1:${gPort}/v1/ocr`;
  try {
    const t0 = performance.now();
    const doc = await recognizeMainThread(scanBlurItem.buffer, "ara+eng", {
      recoverRecall: true, recoveryBudgetMs: 20_000, rescuePaddle: true,
    });
    const ms = Math.round(performance.now() - t0);
    const rec = doc.meta?.paddleRescue as PaddleRescueRecord | undefined;
    const ok = !doc.lines.some((l) => l.text.includes("CRASH")) && doc.lines.length > 0;
    degradationResults.push({ name: "malformed response", passed: ok, detail: `error=${rec?.attempts?.[0]?.error ?? "none"} lines=${doc.lines.length} ms=${ms}` });
  } catch (e) {
    degradationResults.push({ name: "malformed response", passed: false, detail: `CRASH: ${(e as Error).message}` });
  }
  garbageServer.close();
  process.env.PADDLE_OCR_URL = saved;
}

// Test 3: Empty response
{
  const saved = process.env.PADDLE_OCR_URL;
  const emptyServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ texts: [] }));
    });
  });
  await new Promise<void>((resolve) => emptyServer.listen(0, "127.0.0.1", resolve));
  const ePort = (emptyServer.address() as { port: number }).port;
  process.env.PADDLE_OCR_URL = `http://127.0.0.1:${ePort}/v1/ocr`;
  try {
    const t0 = performance.now();
    const doc = await recognizeMainThread(scanBlurItem.buffer, "ara+eng", {
      recoverRecall: true, recoveryBudgetMs: 20_000, rescuePaddle: true,
    });
    const ms = Math.round(performance.now() - t0);
    const rec = doc.meta?.paddleRescue as PaddleRescueRecord | undefined;
    const ok = rec?.triggered === false || rec?.attempts?.every((a) => a.accepted === 0);
    degradationResults.push({ name: "empty response", passed: ok, detail: `triggered=${rec?.triggered} lines=${doc.lines.length} ms=${ms}` });
  } catch (e) {
    degradationResults.push({ name: "empty response", passed: false, detail: `CRASH: ${(e as Error).message}` });
  }
  emptyServer.close();
  process.env.PADDLE_OCR_URL = saved;
}

// Test 4: No PADDLE_OCR_URL (graceful skip)
{
  const saved = process.env.PADDLE_OCR_URL;
  delete process.env.PADDLE_OCR_URL;
  try {
    const t0 = performance.now();
    const doc = await recognizeMainThread(scanBlurItem.buffer, "ara+eng", {
      recoverRecall: true, recoveryBudgetMs: 20_000, rescuePaddle: true,
    });
    const ms = Math.round(performance.now() - t0);
    const rec = doc.meta?.paddleRescue as PaddleRescueRecord | undefined;
    const ok = rec?.skippedReason === "paddle_unavailable";
    degradationResults.push({ name: "no URL set", passed: ok, detail: `reason=${rec?.skippedReason} lines=${doc.lines.length} ms=${ms}` });
  } catch (e) {
    degradationResults.push({ name: "no URL set", passed: false, detail: `CRASH: ${(e as Error).message}` });
  }
  process.env.PADDLE_OCR_URL = saved;
}

// Test 5: En-clean with real service (healthy fixture: 0 requests expected)
if (useRealService) {
  const enCleanItem = corpus.find((i) => i.id === "en-clean")!;
  try {
    const t0 = performance.now();
    const doc = await recognizeMainThread(enCleanItem.buffer, "ara+eng", {
      recoverRecall: true, recoveryBudgetMs: 20_000, rescuePaddle: true,
    });
    const ms = Math.round(performance.now() - t0);
    const rec = doc.meta?.paddleRescue as PaddleRescueRecord | undefined;
    const requests = rec?.attempts.length ?? 0;
    const ok = requests === 0 && rec?.skippedReason !== undefined;
    degradationResults.push({ name: "healthy fixture (en-clean): 0 requests", passed: ok, detail: `requests=${requests} reason=${rec?.skippedReason} lines=${doc.lines.length} ms=${ms}` });
  } catch (e) {
    degradationResults.push({ name: "healthy fixture (en-clean): 0 requests", passed: false, detail: `CRASH: ${(e as Error).message}` });
  }
}

for (const d of degradationResults) {
  console.log(`  ${d.passed ? "[PASS]" : "[FAIL]"} ${d.name} — ${d.detail}`);
}
const allDegradedPassed = degradationResults.every((d) => d.passed);
console.log(`\n  degradation: ${degradationResults.filter((d) => d.passed).length}/${degradationResults.length} passed`);

// ─── Service memory measurement ──────────────────────────────────────────

console.log("\n════════════════════════════════════════════════");
console.log("SERVICE MEMORY");
console.log("════════════════════════════════════════════════");

if (useRealService) {
  try {
    const ps = execSync("tasklist /FI \"IMAGENAME eq python.exe\" /FO CSV /NH", { encoding: "utf-8" });
    const lines = ps.trim().split("\n").filter((l) => l.includes("python.exe"));
    let totalRssKb = 0;
    for (const l of lines) {
      const match = l.match(/"(\d+)","Python.*?","(\d+) K"/);
      if (match) {
        const rssKb = parseInt(match[2], 10);
        totalRssKb += rssKb;
        console.log(`  PID ${match[1]}: RSS ${(rssKb / 1024).toFixed(1)} MB`);
      }
    }
    console.log(`  TOTAL Python RSS: ${(totalRssKb / 1024).toFixed(1)} MB`);
  } catch {
    console.log("  (could not measure — tasklist failed)");
  }
}

// ─── Write results ───────────────────────────────────────────────────────

mkdirSync("benchmarks/results", { recursive: true });
writeFileSync(
  "benchmarks/results/paddle-rescue.json",
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      mode: useRealService ? `real service: ${realServiceUrl}` : "mock (scripted PP-OCRv6 capture)",
      results,
      degradation: degradationResults,
    },
    null,
    2
  )
);
console.log("\nWrote benchmarks/results/paddle-rescue.json");

if (mockServer) mockServer.close();