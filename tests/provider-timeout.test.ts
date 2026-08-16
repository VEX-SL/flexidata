import http from "node:http";
import type { AIRequest, AIResponse } from "../src/types.ts";
import { BaseAIProvider } from "../src/lib/ai/providers/base.ts";
import { RdpProvider } from "../src/lib/ai/providers/rdp.ts";
import { test, ok, equal } from "./harness.ts";

/**
 * M25 timeout enforcement. Every provider goes through the shared
 * BaseAIProvider.fetchWithTimeout (AbortController + clearTimeout); RdpProvider
 * now threads an explicit per-request timeout through healthCheck and
 * chatCompletion so a dead/hung upstream can never hang the pipeline.
 */

function startHangingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer(() => {
      // Never respond — simulate a dead upstream.
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({
          port: addr.port,
          close: () =>
            new Promise<void>((res) => {
              for (const s of sockets) s.destroy();
              server.close(() => res());
            }),
        });
      } else {
        reject(new Error("failed to bind test server"));
      }
    });
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

test("RdpProvider.chatCompletion aborts a hanging upstream within timeoutMs", async () => {
  const { port, close } = await startHangingServer();
  try {
    const provider = new RdpProvider(`http://127.0.0.1:${port}`, "key", 150);
    let aborted = false;
    try {
      await provider.chatCompletion({ messages: [{ role: "user", content: "ping" }] });
    } catch (err) {
      aborted = isAbort(err);
    }
    ok(aborted, "chatCompletion must reject with AbortError on a hanging upstream");
  } finally {
    await close();
  }
});

test("RdpProvider.healthCheck is bounded and reports false on timeout", async () => {
  const { port, close } = await startHangingServer();
  try {
    const provider = new RdpProvider(`http://127.0.0.1:${port}`, "key", 150);
    const healthy = await provider.healthCheck();
    equal(healthy, false, "healthCheck must not hang; returns false on timeout");
  } finally {
    await close();
  }
});

class ProbeProvider extends BaseAIProvider {
  name = "probe";
  constructor() {
    super({ apiKey: "key" });
  }
  async chatCompletion(_request: AIRequest): Promise<AIResponse> {
    throw new Error("unused");
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  callWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.fetchWithTimeout(url, init, timeoutMs);
  }
}

test("shared fetchWithTimeout mechanism bounds every provider request", async () => {
  const { port, close } = await startHangingServer();
  try {
    const probe = new ProbeProvider();
    let aborted = false;
    try {
      await probe.callWithTimeout(`http://127.0.0.1:${port}/x`, { method: "GET" }, 150);
    } catch (err) {
      aborted = isAbort(err);
    }
    ok(aborted, "base fetchWithTimeout must abort a hanging request");
  } finally {
    await close();
  }
});
