import type { AIRequest, AIResponse } from "@/types";
import { GroqProvider } from "./providers/groq";
import { OpenRouterProvider } from "./providers/openrouter";
import { GeminiProvider } from "./providers/gemini";
// import { CerebrasProvider } from "./providers/cerebras";
import { MistralProvider } from "./providers/mistral";
import { ProApiProvider } from "./providers/proapi";
// import { HuggingFaceProvider } from "./providers/huggingface";
import type { BaseAIProvider } from "./providers/base";

export class ProviderManager {
  private providers: BaseAIProvider[] = [];

  /**
   * Providers disabled for the lifetime of this instance. When a provider
   * hits a permanent, non-retryable error (402 / 404) it is parked here so we
   * stop hammering it on every request.
   */
  private disabledProviders = new Set<string>();

  /**
   * Soft-disabled providers. Used for providers that we don't want to fully
   * disable (they might recover), but we also don't want to hammer on every
   * request. ProApi is the canonical example — it's a low-quality fallback
   * we keep last, but if it starts failing we skip it for a while to avoid
   * wasting 1.5s per request.
   *
   * Key = provider name, Value = timestamp (ms) when it should be re-tried.
   */
  private softDisabledUntil = new Map<string, number>();

  constructor() {
    // ============================================================
    // ORDER MATTERS: providers are tried in this exact order.
    // ProApi is intentionally LAST — it's not real GPT, just a weak
    // model branded as GPT. Use it only if every other provider fails.
    // ============================================================
    if (process.env.GROQ_API_KEY) {
      this.providers.push(new GroqProvider(process.env.GROQ_API_KEY));
    }
    if (process.env.OPENROUTER_API_KEY) {
      this.providers.push(new OpenRouterProvider(process.env.OPENROUTER_API_KEY));
    }
    if (process.env.GEMINI_API_KEY) {
      this.providers.push(new GeminiProvider(process.env.GEMINI_API_KEY));
    }
    if (process.env.MISTRAL_API_KEY) {
      this.providers.push(new MistralProvider(process.env.MISTRAL_API_KEY));
    }
    if (process.env.PROAPI_BASE_URL && process.env.PROAPI_API_KEY) {
      this.providers.push(new ProApiProvider());
    }
    // Disabled providers (commented out):
    // if (process.env.CEREBRAS_API_KEY) {
    //   this.providers.push(new CerebrasProvider(process.env.CEREBRAS_API_KEY));
    // }
    // if (process.env.HF_API_KEY) {
    //   this.providers.push(new HuggingFaceProvider(process.env.HF_API_KEY));
    // }

    if (this.providers.length === 0) {
      throw new Error("No AI providers configured. Check your .env file.");
    }

    console.log(
      `[ProviderManager] Initialized ${this.providers.length} providers (in order):`,
      this.providers.map((p) => p.name).join(" → ")
    );
  }

  /**
   * Is the provider currently skipped due to soft-disable?
   * Soft-disable lasts 5 minutes, then we give it another chance.
   */
  private isSoftDisabled(name: string): boolean {
    const until = this.softDisabledUntil.get(name);
    if (!until) return false;
    if (Date.now() > until) {
      this.softDisabledUntil.delete(name);
      return false;
    }
    return true;
  }

  private softDisable(name: string, durationMs = 5 * 60 * 1000): void {
    this.softDisabledUntil.set(name, Date.now() + durationMs);
    console.warn(
      `[ProviderManager] ${name}: soft-disabled for ${durationMs / 1000}s (recent failures)`
    );
  }

  async chatCompletion(
    request: AIRequest,
    retryAttempts = 2,
    opts: { skipProviders?: string[] } = {}
  ): Promise<AIResponse> {
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      if (opts.skipProviders?.includes(provider.name)) {
        console.log(`[ProviderManager] Skipping ${provider.name} (already used)`);
        continue;
      }
      if (this.disabledProviders.has(provider.name)) {
        console.log(`[ProviderManager] Skipping ${provider.name} (permanent disable)`);
        continue;
      }
      if (this.isSoftDisabled(provider.name)) {
        console.log(`[ProviderManager] Skipping ${provider.name} (soft-disabled)`);
        continue;
      }

      // Truncate context if provider has known token limits
      const truncatedRequest = this.truncateForProvider(provider.name, request);

      // ProApi is weak — only retry once, not the full retryAttempts.
      // Saves ~1.5s per request when it's flaky.
      const effectiveRetry = provider.name === "proapi" ? 0 : retryAttempts;

      for (let attempt = 0; attempt <= effectiveRetry; attempt++) {
        try {
          console.log(
            `[ProviderManager] Trying ${provider.name} (attempt ${attempt + 1})`
          );
          const response = await provider.chatCompletion(truncatedRequest);
          console.log(`[ProviderManager] ${provider.name} succeeded`);
          return { ...response, provider: provider.name };
        } catch (err: any) {
          const isAbort = err?.name === "AbortError";
          console.error(
            `[ProviderManager] ${provider.name} failed (attempt ${attempt + 1}${isAbort ? ", timeout" : ""}):`,
            err.message
          );
          lastError = err;

          // Non-retryable HTTP errors
          const isNonRetryable = err?.message?.match(/\b(413|402|401|404)\b/);
          if (isNonRetryable) {
            const permanent = err?.message?.match(/\b(402|404)\b/);
            if (permanent) {
              this.disabledProviders.add(provider.name);
              console.warn(
                `[ProviderManager] ${provider.name}: permanent error (${permanent[0]}), hard-disabled for this run`
              );
            } else {
              console.log(`[ProviderManager] ${provider.name}: non-retryable (413/401), skipping`);
            }
            break;
          }

          // Quota exhausted (Gemini-specific format)
          const isQuotaExhausted =
            err?.message?.includes("RESOURCE_EXHAUSTED") &&
            err?.message?.includes("limit: 0");
          if (isQuotaExhausted) {
            console.log(`[ProviderManager] ${provider.name}: quota exhausted, skipping`);
            break;
          }

          // 429 rate limit — try next provider instead of waiting
          const isRateLimit =
            err?.message?.includes("429") ||
            err?.message?.includes("rate limit");
          if (isRateLimit) {
            console.log(
              `[ProviderManager] ${provider.name}: rate limited, trying next provider`
            );
            break;
          }

          // ProApi: soft-disable after any failure (it's last anyway, no point
          // in retrying on next request)
          if (provider.name === "proapi") {
            this.softDisable(provider.name, 10 * 60 * 1000); // 10 min
            break;
          }

          // Mistral: soft-disable on persistent 429 (we know it's quota)
          if (
            provider.name === "mistral" &&
            err?.message?.includes("429")
          ) {
            this.softDisable(provider.name, 30 * 60 * 1000); // 30 min
            break;
          }

          // Wait + retry for transient errors
          if (attempt < effectiveRetry) {
            const delay = 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    }

    throw new Error(`All providers failed. Last error: ${lastError?.message}`);
  }

  async *streamChatCompletion(
    request: AIRequest,
    retryAttempts = 1
  ): AsyncGenerator<string, { provider: string }, unknown> {
    for (const provider of this.providers) {
      if (!provider.supportsStreaming()) continue;
      if (this.disabledProviders.has(provider.name)) continue;
      if (this.isSoftDisabled(provider.name)) continue;

      const truncatedRequest = this.truncateForProvider(provider.name, request);
      const effectiveRetry = provider.name === "proapi" ? 0 : retryAttempts;

      for (let attempt = 0; attempt <= effectiveRetry; attempt++) {
        try {
          console.log(
            `[ProviderManager] Streaming ${provider.name} (attempt ${attempt + 1})`
          );
          yield* provider.streamCompletion(truncatedRequest);
          console.log(`[ProviderManager] ${provider.name} stream completed`);
          return { provider: provider.name };
        } catch (err: any) {
          const isAbort = err?.name === "AbortError";
          console.error(
            `[ProviderManager] ${provider.name} stream failed (attempt ${attempt + 1}${isAbort ? ", timeout" : ""}):`,
            err.message
          );

          const isNonRetryable = err?.message?.match(/\b(413|402|401|404)\b/);
          if (isNonRetryable) {
            if (err?.message?.match(/\b(402|404)\b/)) {
              this.disabledProviders.add(provider.name);
              console.warn(
                `[ProviderManager] ${provider.name}: permanent stream error, hard-disabled`
              );
            }
            break;
          }

          const isQuotaExhausted =
            err?.message?.includes("RESOURCE_EXHAUSTED") &&
            err?.message?.includes("limit: 0");
          if (isQuotaExhausted) break;

          const isRateLimit =
            err?.message?.includes("429") ||
            err?.message?.includes("rate limit");
          if (isRateLimit) break;

          if (provider.name === "proapi") {
            this.softDisable(provider.name, 10 * 60 * 1000);
            break;
          }

          if (attempt < effectiveRetry) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
      }
    }

    // Fallback: non-streaming
    console.log("[ProviderManager] No stream succeeded, falling back to non-streaming");
    const response = await this.chatCompletion(request, 1);
    yield response.content;
    return { provider: response.provider || "fallback" };
  }

  private truncateForProvider(providerName: string, request: AIRequest): AIRequest {
    // Providers with strict token limits on free tier
    const limits: Record<string, number> = {
      groq: 20000,
    };

    const maxChars = limits[providerName];
    if (!maxChars) return request;

    const totalChars = request.messages.reduce(
      (sum, m) => sum + (m.content?.length || 0),
      0
    );
    if (totalChars <= maxChars) return request;

    // Truncate the context/system message (usually the longest)
    const messages = [...request.messages];
    const overBy = totalChars - maxChars;

    for (let i = messages.length - 1; i >= 0 && overBy > 0; i--) {
      if (messages[i].role === "system" || messages[i].role === "user") {
        const content = messages[i].content || "";
        if (content.length > 1000) {
          const trimAmount = Math.min(content.length - 500, overBy);
          messages[i] = { ...messages[i], content: content.slice(trimAmount) };
        }
      }
    }

    return { ...request, messages };
  }
}

let instance: ProviderManager | null = null;

export function getProviderManager(): ProviderManager {
  if (!instance) {
    instance = new ProviderManager();
  }
  return instance;
}