import { BaseAIProvider } from "./base";
import type { AIRequest, AIResponse } from "@/types";

/**
 * Groq models, tried in order.
 *
 * Updated 2026-11 per https://console.groq.com/docs/models:
 *
 * PRODUCTION (with Developer Plan rate limits — definitely work on free tier):
 *   • openai/gpt-oss-120b     — 250K TPM, 1K RPM
 *   • openai/gpt-oss-20b      — 250K TPM, 1K RPM
 *
 * PRODUCTION (Enterprise — "ContactSales", may not work on free tier):
 *   • llama-3.3-70b-versatile — 131K context
 *   • llama-3.1-8b-instant    — 131K context
 *
 * PREVIEW (might be unstable):
 *   • qwen/qwen3.8-27b        — 20MB file size limit
 *
 * DECOMMISSIONED (don't use):
 *   • llama-3.1-70b-versable  — retired
 *   • gemma2-9b-it            — retired
 *   • llama3-70b-8192          — retired
 *
 * IMPORTANT: Groq returns 400 (not 404) for decommissioned models with a
 * "decommissioned" message. We treat both 404 and 400-decommissioned as
 * "try next model"; everything else (auth/quota/rate limit) throws immediately.
 */
const GROQ_MODELS = [
  // Production — Developer Plan tier (most reliable on free accounts)
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  // Production — Enterprise (might be restricted on free tier)
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  // Preview
  "qwen/qwen3.8-27b",
];

export class GroqProvider extends BaseAIProvider {
  public name = "groq";

  constructor(apiKey: string) {
    super({ apiKey, model: GROQ_MODELS[0] });
  }

  private buildBody(model: string, request: AIRequest, stream = false) {
    return {
      model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      stream,
    };
  }

  /**
   * Should we try the next model?
   *   YES for: 404 (not found), 400 with decommissioned/deprecated message
   *   NO  for: 401 (auth), 402 (quota), 429 (rate limit), 413, network errors
   */
  private shouldTryNextModel(status: number, errorText: string): boolean {
    if (status === 404) return true;
    if (status === 400) {
      const msg = (errorText || "").toLowerCase();
      return (
        msg.includes("decommissioned") ||
        msg.includes("deprecated") ||
        msg.includes("not supported") ||
        msg.includes("does not exist") ||
        msg.includes("model is not available") ||
        msg.includes("model not found")
      );
    }
    return false;
  }

  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    let lastErr: Error | null = null;
    let lastTriedModel = "";

    for (const model of GROQ_MODELS) {
      lastTriedModel = model;
      try {
        const response = await this.fetchWithTimeout(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(this.buildBody(model, request)),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          if (this.shouldTryNextModel(response.status, errorText)) {
            console.warn(
              `[Groq] model "${model}" unavailable (${response.status}), trying next...`
            );
            lastErr = new Error(
              `Groq ${response.status} for ${model}: ${errorText.slice(0, 150)}`
            );
            continue;
          }
          // Non-retryable: throw immediately
          throw new Error(`Groq API error: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        if (model !== GROQ_MODELS[0]) {
          console.log(`[Groq] succeeded with fallback model: ${model}`);
        }
        return {
          content: data.choices[0].message.content,
          model: data.model,
          usage: {
            promptTokens: data.usage?.prompt_tokens,
            completionTokens: data.usage?.completion_tokens,
          },
        };
      } catch (err) {
        // network/timeout — no point trying next model
        throw err;
      }
    }

    throw (
      lastErr ??
      new Error(`Groq: all ${GROQ_MODELS.length} model candidates failed (last tried: ${lastTriedModel})`)
    );
  }

  supportsStreaming(): boolean {
    return true;
  }

  async *streamCompletion(request: AIRequest): AsyncGenerator<string, void, unknown> {
    let lastErr: Error | null = null;

    for (const model of GROQ_MODELS) {
      try {
        const response = await this.fetchWithTimeout(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(this.buildBody(model, request, true)),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          if (this.shouldTryNextModel(response.status, errorText)) {
            lastErr = new Error(`Groq ${response.status} for ${model}`);
            continue;
          }
          throw new Error(`Groq API error: ${response.status} ${errorText}`);
        }

        yield* this.parseSSEStream(response);
        return;
      } catch (err) {
        throw err;
      }
    }

    throw lastErr ?? new Error("Groq: all model candidates failed for stream");
  }

  protected async *parseSSEStream(response: Response): AsyncGenerator<string, void, unknown> {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
