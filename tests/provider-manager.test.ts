import { ProviderManager } from "../src/lib/ai/manager.ts";
import { test, ok, equal, assert } from "./harness.ts";

/**
 * Real ProviderManager (relative import — the @/lib/ai/manager alias is
 * stubbed to throw under FLEXIDATA_STUB_AI=1). Verifies the M25 RDP bootstrap
 * rules: opt-in, both-env-vars-required, fail-fast on partial config, and that
 * provider failover still works after the providers array is manipulated.
 */

const ENV_KEYS = [
  "RDP_API_URL",
  "RDP_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY",
  "GEMINI_API_KEY",
  "PROAPI_BASE_URL",
  "PROAPI_API_KEY",
  "OPENROUTER_API_KEY",
  "HF_API_KEY",
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const val = snap[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

async function withEnv(env: Record<string, string>, fn: () => void | Promise<void>): Promise<void> {
  const snap = snapshotEnv();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    restoreEnv(snap);
  }
}

function providerNames(m: ProviderManager): string[] {
  return (m as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
}

function captureThrows(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

test("RDP registers first when both RDP_API_URL and RDP_API_KEY are set", async () => {
  await withEnv(
    { RDP_API_URL: "http://127.0.0.1:9999", RDP_API_KEY: "rdp-key", GROQ_API_KEY: "groq-key" },
    () => {
      const m = new ProviderManager();
      const names = providerNames(m);
      equal(names[0], "rdp-deepseek", "RDP must be the first provider when configured");
      ok(names.includes("groq"), "other providers still register");
    }
  );
});

test("RDP is skipped when neither env var is set", async () => {
  await withEnv({ GROQ_API_KEY: "groq-key" }, () => {
    const m = new ProviderManager();
    const names = providerNames(m);
    assert(!names.includes("rdp-deepseek"), "RDP must not register without both env vars");
  });
});

test("RDP partial config (URL only) fails fast", async () => {
  await withEnv({ RDP_API_URL: "http://127.0.0.1:9999", GROQ_API_KEY: "groq-key" }, () => {
    const message = captureThrows(() => new ProviderManager());
    equal(
      message,
      "RDP_API_URL and RDP_API_KEY must both be set to enable the RDP provider"
    );
  });
});

test("RDP partial config (KEY only) fails fast", async () => {
  await withEnv({ RDP_API_KEY: "rdp-key", GROQ_API_KEY: "groq-key" }, () => {
    const message = captureThrows(() => new ProviderManager());
    equal(
      message,
      "RDP_API_URL and RDP_API_KEY must both be set to enable the RDP provider"
    );
  });
});

test("zero providers still throws loudly with the exact message", async () => {
  await withEnv({}, () => {
    const message = captureThrows(() => new ProviderManager());
    equal(message, "No AI providers configured. Check your .env file.");
  });
});

test("provider failover still works after M25 (non-retryable skip)", async () => {
  await withEnv({ GROQ_API_KEY: "groq-key" }, async () => {
    const m = new ProviderManager();
    (m as unknown as { providers: unknown[] }).providers = [
      {
        name: "bad-provider",
        supportsStreaming: () => false,
        async chatCompletion() {
          throw new Error("HTTP 413 payload too large");
        },
      },
      {
        name: "good-provider",
        supportsStreaming: () => false,
        async chatCompletion() {
          return { content: "hello" };
        },
      },
    ];
    const res = await m.chatCompletion({ messages: [{ role: "user", content: "hi" }] });
    equal(res.content, "hello");
    equal(res.provider, "good-provider");
  });
});
