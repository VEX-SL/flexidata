/* eslint-disable no-console */
/**
 * AI Providers Health Check
 * --------------------------
 * Tests every configured provider INDIVIDUALLY (not through ProviderManager's
 * fallback), so you can tell exactly which one is broken and why.
 *
 * NOTE: maxTokens is set to 200 (not 10) so reasoning models like Groq's
 * gpt-oss-120b have enough budget for reasoning + final answer.
 *
 * Run:
 *   npx tsx scripts/test-providers.ts
 *
 * Exit codes: 0 = all healthy, 2 = at least one failed, 1 = fatal
 */

import "dotenv/config";

import { ProApiProvider } from "@/lib/ai/providers/proapi";
import { OpenRouterProvider } from "@/lib/ai/providers/openrouter";
import { GroqProvider } from "@/lib/ai/providers/groq";
import { GeminiProvider } from "@/lib/ai/providers/gemini";
import { MistralProvider } from "@/lib/ai/providers/mistral";
import { HuggingFaceProvider } from "@/lib/ai/providers/huggingface";
import type { BaseAIProvider } from "@/lib/ai/providers/base";
import type { AIRequest } from "@/types";

interface Row {
  provider: string;
  envKey: string;
  health: "ok" | "fail" | "skip";
  healthMs?: number;
  chat: "ok" | "fail" | "skip";
  chatMs?: number;
  model?: string;
  snippet?: string;
  stream?: "ok" | "fail" | "skip";
  error?: string;
}

// 200 tokens: enough for reasoning models (gpt-oss-120b) to finish thinking
// and produce the actual answer. 10 was too small — reasoning models used
// all 10 tokens on "thinking" and never emitted the answer.
const SMALL_REQUEST: AIRequest = {
  messages: [{ role: "user", content: "Reply with the single word: OK" }],
  maxTokens: 200,
  temperature: 0,
};

function env(name: string): string | undefined {
  return process.env[name];
}

function buildProviders(): { instance: BaseAIProvider; envKey: string }[] {
  const list: { instance: BaseAIProvider; envKey: string }[] = [];
  if (env("GROQ_API_KEY"))
    list.push({ instance: new GroqProvider(env("GROQ_API_KEY")!), envKey: "GROQ_API_KEY" });
  if (env("MISTRAL_API_KEY"))
    list.push({ instance: new MistralProvider(env("MISTRAL_API_KEY")!), envKey: "MISTRAL_API_KEY" });
  if (env("GEMINI_API_KEY"))
    list.push({ instance: new GeminiProvider(env("GEMINI_API_KEY")!), envKey: "GEMINI_API_KEY" });
  if (env("PROAPI_BASE_URL") && env("PROAPI_API_KEY"))
    list.push({ instance: new ProApiProvider(), envKey: "PROAPI_*" });
  if (env("OPENROUTER_API_KEY"))
    list.push({ instance: new OpenRouterProvider(env("OPENROUTER_API_KEY")!), envKey: "OPENROUTER_API_KEY" });
  if (env("HF_API_KEY"))
    list.push({ instance: new HuggingFaceProvider(env("HF_API_KEY")!), envKey: "HF_API_KEY" });
  return list;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

function classifyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/401|unauthor/i.test(msg)) return "AUTH (401) — bad/expired API key";
  if (/402|payment|quota|billing/i.test(msg)) return "QUOTA (402) — out of credits / billing issue";
  if (/404|not found/i.test(msg)) return "MODEL (404) — model name wrong or unavailable";
  if (/429|rate limit|RESOURCE_EXHAUSTED/i.test(msg)) return "RATE LIMIT (429) — quota exhausted";
  if (/413|too large|payload/i.test(msg)) return "TOO LARGE (413)";
  if (/503|overloaded|high demand|temporarily/i.test(msg)) return "OVERLOADED (503) — try again later";
  if (/abort|timeout/i.test(msg)) return "TIMEOUT — request took too long (>20s)";
  if (/fetch|ECONN|network|dns|ENOTFOUND/i.test(msg)) return "NETWORK — connection failed";
  return `OTHER — ${msg.slice(0, 200)}`;
}

async function checkProvider(p: BaseAIProvider, envKey: string): Promise<Row> {
  const row: Row = {
    provider: p.name,
    envKey,
    health: "skip",
    chat: "skip",
    stream: "skip",
  };

  // 1) healthCheck
  try {
    const { ms } = await timed(() => p.healthCheck());
    row.health = "ok";
    row.healthMs = ms;
  } catch (err) {
    row.health = "fail";
    row.error = classifyError(err);
  }

  // 2) actual chat completion
  try {
    const { result, ms } = await timed(() => p.chatCompletion(SMALL_REQUEST));
    row.chat = "ok";
    row.chatMs = ms;
    row.model = result.model;
    row.snippet = (result.content || "").trim().slice(0, 40);
    // Detect empty-content response (reasoning models with low maxTokens)
    if (!row.snippet) {
      row.snippet = "(empty content — model may be reasoning-only with this maxTokens)";
    }
  } catch (err) {
    row.chat = "fail";
    row.error = row.error ? `${row.error} | chat: ${classifyError(err)}` : classifyError(err);
    return row;
  }

  // 3) streaming (only if provider supports it)
  if (p.supportsStreaming()) {
    try {
      let firstChunk = "";
      for await (const chunk of p.streamCompletion(SMALL_REQUEST)) {
        firstChunk = (firstChunk + chunk).slice(0, 20);
        if (firstChunk.length >= 5) break;
      }
      row.stream = firstChunk.length > 0 ? "ok" : "fail";
      if (row.stream === "fail")
        row.error = "STREAM — empty response (model may need higher maxTokens for reasoning)";
    } catch (err) {
      row.stream = "fail";
      row.error = `STREAM — ${classifyError(err)}`;
    }
  }

  return row;
}

function pad(s: string | undefined, n: number): string {
  const v = (s ?? "").toString();
  return v.length >= n ? v.slice(0, n) : v + " ".repeat(n - v.length);
}

function printEnvCheck() {
  console.log("\n" + "=".repeat(72));
  console.log("ENV VARS CHECK");
  console.log("=".repeat(72));
  const vars = [
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "GEMINI_API_KEY",
    "PROAPI_BASE_URL",
    "PROAPI_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_API_KEY",
  ];
  for (const v of vars) {
    const val = env(v);
    const status = val ? (val.length > 8 ? "SET" : "TOO SHORT") : "MISSING";
    const masked = val ? `${val.slice(0, 4)}...${val.slice(-4)} (${val.length} chars)` : "—";
    console.log(`  ${pad(v, 22)} ${pad(status, 12)} ${masked}`);
  }
  console.log("=".repeat(72));
}

function printReport(rows: Row[]) {
  console.log("\n" + "=".repeat(110));
  console.log("AI PROVIDERS HEALTH CHECK");
  console.log("=".repeat(110));
  console.log(
    pad("PROVIDER", 16) +
      pad("ENV KEY", 22) +
      pad("HEALTH", 8) +
      pad("ms", 7) +
      pad("CHAT", 8) +
      pad("ms", 7) +
      pad("STREAM", 8) +
      pad("MODEL", 28) +
      "SNIPPET / ERROR"
  );
  console.log("-".repeat(110));
  for (const r of rows) {
    console.log(
      pad(r.provider, 16) +
        pad(r.envKey, 22) +
        pad(r.health, 8) +
        pad(r.healthMs ? String(r.healthMs) : "-", 7) +
        pad(r.chat, 8) +
        pad(r.chatMs ? String(r.chatMs) : "-", 7) +
        pad(r.stream, 8) +
        pad(r.model ?? "-", 28) +
        (r.chat === "ok" ? (r.snippet ?? "") : (r.error ?? ""))
    );
  }
  console.log("=".repeat(110));
  const okCount = rows.filter((r) => r.chat === "ok").length;
  const failCount = rows.filter((r) => r.chat === "fail").length;
  console.log(`Summary: ${okCount} ok / ${failCount} failed / ${rows.length} total`);
  console.log("=".repeat(110) + "\n");

  if (failCount > 0) {
    console.log("FAILED PROVIDERS:\n");
    for (const r of rows.filter((r) => r.chat === "fail")) {
      console.log(`  • ${r.provider} (${r.envKey}): ${r.error}`);
    }
    console.log("");
  }
}

async function main() {
  printEnvCheck();

  const providers = buildProviders();
  if (providers.length === 0) {
    console.error("No providers configured. Check your .env file.");
    process.exit(1);
  }

  console.log(`Testing ${providers.length} provider(s) in parallel...\n`);
  const rows = await Promise.all(
    providers.map((p) => checkProvider(p.instance, p.envKey))
  );

  rows.sort((a, b) => {
    const order = (r: Row) => (r.chat === "ok" ? 0 : r.chat === "fail" ? 1 : 2);
    return order(a) - order(b);
  });

  printReport(rows);

  const allOk = rows.every((r) => r.chat === "ok");
  process.exit(allOk ? 0 : 2);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
