import { BaseAIProvider } from "./base";
import type { AIRequest, AIResponse } from "@/types";

/**
 * Gemini model fallback list.
 *
 * Verified working with the user's API key (per test-gemini.ts diagnostic):
 *   ✓ gemini-3.8-flash          → 200
 *   ✓ gemini-flash-latest       → 200 (alias, always points to latest)
 *   ✓ gemini-3.6-flash          → 200
 *   ✓ gemini-3.5-flash-lite     → 200
 *   ✓ gemini-3.1-flash-lite     → 200
 *   ✓ gemini-3-flash-preview    → 200
 *   ✗ gemini-3.1-pro-preview    → 429 (quota — skip)
 *   ✗ gemini-2.5-flash-lite     → 404 (not available to new users — skip)
 *
 * Timeout: Gemini's first request can take 25-35s (cold start + reasoning),
 * especially when called in parallel with other providers. We use 45s
 * instead of the default 20s in base.ts.
 */
const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
];

const GEMINI_TIMEOUT_MS = 45_000;

export class GeminiProvider extends BaseAIProvider {
  public name = "gemini";

  constructor(apiKey: string) {
    super({ apiKey, model: GEMINI_MODELS[0] });
  }

  private buildBody(request: AIRequest): Record<string, unknown> {
    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const systemInstruction = request.messages.find((m) => m.role === "system");

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = {
        parts: [{ text: systemInstruction.content }],
      };
    }

    return body;
  }

  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    let lastErr: Error | null = null;
    let lastTriedModel = "";

    for (const model of GEMINI_MODELS) {
      lastTriedModel = model;
      try {
        // Use 45s timeout — Gemini's cold starts can exceed the default 20s
        const response = await this.fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.config.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.buildBody(request)),
          },
          GEMINI_TIMEOUT_MS
        );

        if (!response.ok) {
          const errText = await response.text();

          // 404 — model not found, try next
          if (response.status === 404) {
            console.warn(
              `[Gemini] model "${model}" not available (404), trying next...`
            );
            lastErr = new Error(`Gemini 404 for ${model}: ${errText.slice(0, 150)}`);
            continue;
          }

          // 400 — might be "model is not supported" → try next
          if (response.status === 400) {
            const msg = errText.toLowerCase();
            if (
              msg.includes("not supported") ||
              msg.includes("not found") ||
              msg.includes("does not exist")
            ) {
              console.warn(
                `[Gemini] model "${model}" not supported (400), trying next...`
              );
              lastErr = new Error(`Gemini 400 for ${model}: ${errText.slice(0, 150)}`);
              continue;
            }
          }

          // 503 — temporarily overloaded → try next model (spikes are local)
          if (response.status === 503) {
            console.warn(
              `[Gemini] model "${model}" overloaded (503), trying next...`
            );
            lastErr = new Error(`Gemini 503 for ${model}: ${errText.slice(0, 150)}`);
            continue;
          }

          // 429 — quota exhausted for THIS model → try next (other models may
          // have separate quotas)
          if (response.status === 429) {
            console.warn(
              `[Gemini] model "${model}" quota exhausted (429), trying next...`
            );
            lastErr = new Error(`Gemini 429 for ${model}: ${errText.slice(0, 150)}`);
            continue;
          }

          // Non-retryable: throw immediately (auth/billing/too large)
          throw new Error(`Gemini API error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (model !== GEMINI_MODELS[0]) {
          console.log(`[Gemini] succeeded with fallback model: ${model}`);
        }
        return { content, model };
      } catch (err) {
        // Timeout / network — try the next model in the list. Gemini's
        // cold-start latency can hit one model but not another, so falling
        // through is the right call here (unlike auth errors where retry
        // is pointless).
        const isTimeout = (err as Error)?.name === "AbortError" ||
          /timeout|abort/i.test((err as Error)?.message || "");
        if (isTimeout) {
          console.warn(
            `[Gemini] model "${model}" timed out (>${GEMINI_TIMEOUT_MS / 1000}s), trying next...`
          );
          lastErr = err as Error;
          continue;
        }
        throw err;
      }
    }

    throw (
      lastErr ??
      new Error(`Gemini: all ${GEMINI_MODELS.length} model candidates failed (last tried: ${lastTriedModel})`)
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}
