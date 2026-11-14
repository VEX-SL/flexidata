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

    if (this.providers.length === 0) {
      throw new Error("No AI providers configured. Check your .env file.");
    }

    console.log(
      `[ProviderManager] Initialized ${this.providers.length} providers (in order):`,
      this.providers.map((p) => p.name).join(" → ")
    );
  }

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

  /**
   * فحص ما إذا كان الطلب يحتوي على صور (Vision Request)
   */
  private hasImages(request: AIRequest): boolean {
    return request.messages.some((msg) => {
      if (Array.isArray(msg.content)) {
        return msg.content.some((part: any) => part.type === "image_url" || part.type === "image" || part.inline_data);
      }
      return false;
    });
  }

  /**
   * معالجة الصور باستخدام موديلات الرؤية المجانية مع نظام Fallback كامل بين:
   * 1. Google Gemini (gemini-1.5-flash)
   * 2. OpenRouter (nvidia/nemotron-3.5-super-vl:free أو meta-llama/llama-3.2-11b-vision-instruct:free)
   * 3. Groq (llama-3.2-11b-vision-preview)
   */
  async processVisionWithFallback(request: AIRequest): Promise<AIResponse> {
    const visionSteps = [
      {
        provider: "gemini",
        handler: async () => {
          const apiKey = process.env.GEMINI_API_KEY;
          if (!apiKey) throw new Error("Gemini API key not found");

          // استخراج النص والصورة من الطلب لتكييفه مع Gemini API
          let prompt = "صف هذه الصورة بالتفصيل";
          let imageInlineData: any = null;

          for (const msg of request.messages) {
            if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text") prompt = part.text;
                if (part.inline_data) imageInlineData = part.inline_data;
                if (part.image_url) {
                  // تحويل رابط الصورة أو الـ base64 إذا لزم الأمر
                  imageInlineData = { mime_type: "image/jpeg", data: part.image_url.url };
                }
              }
            } else if (typeof msg.content === "string") {
              prompt = msg.content;
            }
          }

          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  ...(imageInlineData ? [{ inline_data: imageInlineData }] : [])
                ]
              }]
            })
          });

          const data = await res.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) throw new Error("Gemini Vision returned empty response");
          return { content: text, provider: "gemini-vision" };
        }
      },
      {
        provider: "openrouter",
        handler: async () => {
          const apiKey = process.env.OPENROUTER_API_KEY;
          if (!apiKey) throw new Error("OpenRouter API key not found");

          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
              "X-Title": "AI Agent App"
            },
            body: JSON.stringify({
              model: "nvidia/nemotron-3.5-super-vl:free", // موديل مجاني ممتاز للرؤية من قائمة OpenRouter
              messages: request.messages
            })
          });

          const data = await res.json();
          const text = data.choices?.[0]?.message?.content;
          if (!text) throw new Error("OpenRouter Vision returned empty response");
          return { content: text, provider: "openrouter-nemotron-vl" };
        }
      },
      {
        provider: "groq",
        handler: async () => {
          const apiKey = process.env.GROQ_API_KEY;
          if (!apiKey) throw new Error("Groq API key not found");

          const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "llama-3.2-11b-vision-preview", // موديل الرؤية السريع على Groq
              messages: request.messages
            })
          });

          const data = await res.json();
          const text = data.choices?.[0]?.message?.content;
          if (!text) throw new Error("Groq Vision returned empty response");
          return { content: text, provider: "groq-vision" };
        }
      }
    ];

    let lastError: any = null;

    for (const step of visionSteps) {
      try {
        console.log(`[VisionManager] Trying free vision provider: ${step.provider}`);
        const response = await step.handler();
        console.log(`[VisionManager] Success with provider: ${step.provider}`);
        return response as AIResponse;
      } catch (err: any) {
        console.warn(`[VisionManager] Provider ${step.provider} failed:`, err?.message);
        lastError = err;
      }
    }

    throw new Error(`All free vision providers failed. Last error: ${lastError?.message}`);
  }

  async chatCompletion(
    request: AIRequest,
    retryAttempts = 2,
    opts: { skipProviders?: string[] } = {}
  ): Promise<AIResponse> {
    // إذا كان الطلب يحتوي على صور، يتم توجيهه تلقائياً لنظام الـ Vision المجاني المتعدد
    if (this.hasImages(request)) {
      console.log("[ProviderManager] Image(s) detected in request. Routing to Free Vision Fallback system...");
      return await this.processVisionWithFallback(request);
    }

    let lastError: Error | null = null;

    for (const provider of this.providers) {
      if (opts.skipProviders?.includes(provider.name)) continue;
      if (this.disabledProviders.has(provider.name)) continue;
      if (this.isSoftDisabled(provider.name)) continue;

      const truncatedRequest = this.truncateForProvider(provider.name, request);
      const effectiveRetry = provider.name === "proapi" ? 0 : retryAttempts;

      for (let attempt = 0; attempt <= effectiveRetry; attempt++) {
        try {
          console.log(`[ProviderManager] Trying ${provider.name} (attempt ${attempt + 1})`);
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

          const isNonRetryable = err?.message?.match(/\b(413|402|401|404)\b/);
          if (isNonRetryable) {
            const permanent = err?.message?.match(/\b(402|404)\b/);
            if (permanent) {
              this.disabledProviders.add(provider.name);
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
          if (isRateLimit) {
            this.softDisable(provider.name, 60 * 1000);
            break;
          }

          if (provider.name === "proapi") {
            this.softDisable(provider.name, 10 * 60 * 1000);
            break;
          }

          if (attempt < effectiveRetry) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
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
    // إذا كانت محادثة Vision، نقوم بتنفيذ الـ Vision وتدفق محتواها
    if (this.hasImages(request)) {
      const visionResult = await this.processVisionWithFallback(request);
      yield visionResult.content;
      return { provider: visionResult.provider || "vision-fallback" };
    }

    for (const provider of this.providers) {
      if (!provider.supportsStreaming()) continue;
      if (this.disabledProviders.has(provider.name)) continue;
      if (this.isSoftDisabled(provider.name)) continue;

      const truncatedRequest = this.truncateForProvider(provider.name, request);
      const effectiveRetry = provider.name === "proapi" ? 0 : retryAttempts;

      for (let attempt = 0; attempt <= effectiveRetry; attempt++) {
        try {
          console.log(`[ProviderManager] Streaming ${provider.name} (attempt ${attempt + 1})`);
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

    console.log("[ProviderManager] No stream succeeded, falling back to non-streaming");
    const response = await this.chatCompletion(request, 1);
    yield response.content;
    return { provider: response.provider || "fallback" };
  }

  private truncateForProvider(providerName: string, request: AIRequest): AIRequest {
    const limits: Record<string, number> = {
      groq: 20000,
    };

    const maxChars = limits[providerName];
    if (!maxChars) return request;

    const totalChars = request.messages.reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0
    );
    if (totalChars <= maxChars) return request;

    const messages = [...request.messages];
    const overBy = totalChars - maxChars;

    for (let i = messages.length - 1; i >= 0 && overBy > 0; i--) {
      if (messages[i].role === "system" || messages[i].role === "user") {
        const content = typeof messages[i].content === "string" ? messages[i].content : "";
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