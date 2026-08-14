import type { AIRequest, AIResponse } from "@/types";
import { ProApiProvider } from "./providers/proapi";
import { OpenRouterProvider } from "./providers/openrouter";
import { GroqProvider } from "./providers/groq";
import { GeminiProvider } from "./providers/gemini";
import { CerebrasProvider } from "./providers/cerebras";
import { MistralProvider } from "./providers/mistral";
import { RdpProvider } from "./providers/rdp";
import { HuggingFaceProvider } from "./providers/huggingface";
import type { BaseAIProvider } from "./providers/base";

export class ProviderManager {
  private providers: BaseAIProvider[] = [];

  constructor() {
    // 1. ضع سيرفر الـ RDP المؤقت في البداية للاختبار بأولوية قصوى
    // (يمكنك وضع الرابط مباشرة أو جذبه من الـ .env)
    const rdpUrl = process.env.RDP_API_URL || "https://september-lopez-humanities-joe.trycloudflare.com";
    const rdpKey = process.env.RDP_API_KEY || "VEX_SECRET_123";
    
    if (rdpUrl && rdpKey) {
      this.providers.push(new RdpProvider(rdpUrl, rdpKey));
    }

    // باقي الproviders العادية...
    if (process.env.GROQ_API_KEY) {
      this.providers.push(new GroqProvider(process.env.GROQ_API_KEY));
    }
    if (process.env.CEREBRAS_API_KEY) {
      this.providers.push(new CerebrasProvider(process.env.CEREBRAS_API_KEY));
    }
    if (process.env.MISTRAL_API_KEY) {
      this.providers.push(new MistralProvider(process.env.MISTRAL_API_KEY));
    }
    if (process.env.GEMINI_API_KEY) {
      this.providers.push(new GeminiProvider(process.env.GEMINI_API_KEY));
    }
    if (process.env.PROAPI_BASE_URL && process.env.PROAPI_API_KEY) {
      this.providers.push(new ProApiProvider());
    }
    if (process.env.OPENROUTER_API_KEY) {
      this.providers.push(new OpenRouterProvider(process.env.OPENROUTER_API_KEY));
    }
    if (process.env.HF_API_KEY) {
      this.providers.push(new HuggingFaceProvider(process.env.HF_API_KEY));
    }

    if (this.providers.length === 0) {
      throw new Error("No AI providers configured. Check your .env file.");
    }

    console.log(
      `[ProviderManager] Initialized with ${this.providers.length} providers:`,
      this.providers.map((p) => p.name).join(", ")
    );

    if (this.providers.length === 0) {
      throw new Error("No AI providers configured. Check your .env file.");
    }

    console.log(
      `[ProviderManager] Initialized with ${this.providers.length} providers:`,
      this.providers.map((p) => p.name).join(", ")
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

      // Truncate context if provider has known token limits
      const truncatedRequest = this.truncateForProvider(provider.name, request);

      for (let attempt = 0; attempt <= retryAttempts; attempt++) {
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

          // Don't retry on non-transient errors (413 too large, 402 payment, 401 auth, 404 not found)
          const isNonRetryable = err?.message?.match(/\b(413|402|401|404)\b/);
          if (isNonRetryable) {
            console.log(`[ProviderManager] ${provider.name}: non-retryable error, skipping`);
            break;
          }

          // Skip immediately on quota exhausted (limit: 0) — no point retrying
          const isQuotaExhausted = err?.message?.includes("RESOURCE_EXHAUSTED") &&
            err?.message?.includes("limit: 0");
          if (isQuotaExhausted) {
            console.log(`[ProviderManager] ${provider.name}: quota exhausted (limit: 0), skipping`);
            break;
          }

          if (attempt < retryAttempts) {
            const isRateLimit = err?.message?.includes("429") || err?.message?.includes("rate limit") || err?.message?.includes("RESOURCE_EXHAUSTED");
            const delay = isRateLimit ? 3000 : 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    }

    throw new Error(
      `All providers failed. Last error: ${lastError?.message}`
    );
  }

  async *streamChatCompletion(
    request: AIRequest,
    retryAttempts = 1
  ): AsyncGenerator<string, void, unknown> {
    for (const provider of this.providers) {
      if (!provider.supportsStreaming()) continue;

      const truncatedRequest = this.truncateForProvider(provider.name, request);

      for (let attempt = 0; attempt <= retryAttempts; attempt++) {
        try {
          console.log(
            `[ProviderManager] Streaming ${provider.name} (attempt ${attempt + 1})`
          );
          yield* provider.streamCompletion(truncatedRequest);
          console.log(`[ProviderManager] ${provider.name} stream completed`);
          return;
        } catch (err: any) {
          const isAbort = err?.name === "AbortError";
          console.error(
            `[ProviderManager] ${provider.name} stream failed (attempt ${attempt + 1}${isAbort ? ", timeout" : ""}):`,
            err.message
          );

          const isNonRetryable = err?.message?.match(/\b(413|402|401|404)\b/);
          if (isNonRetryable) break;

          const isQuotaExhausted = err?.message?.includes("RESOURCE_EXHAUSTED") &&
            err?.message?.includes("limit: 0");
          if (isQuotaExhausted) break;

          if (attempt < retryAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
      }
    }

    // Fallback: use non-streaming completion
    console.log("[ProviderManager] No streaming provider succeeded, falling back to non-streaming");
    const response = await this.chatCompletion(request, 1);
    yield response.content;
  }

  private truncateForProvider(providerName: string, request: AIRequest): AIRequest {
    // Providers with strict token limits on free tier
    const limits: Record<string, number> = {
      groq: 20000,
      cerebras: 20000,
      huggingface: 20000,
    };

    const maxChars = limits[providerName];
    if (!maxChars) return request;

    const totalChars = request.messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
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
