import { BaseAIProvider } from "./base";
import type { AIRequest, AIResponse } from "@/types";

/**
 * OpenRouter model fallback list. `:free` models on OpenRouter are flaky —
 * they get rate-limited hard, get retired, or return 404 for accounts that
 * don't have credits. Try the requested free model first, then fall back
 * to other free + cheap paid models.
 *
 * NOTE: OpenRouter requires `HTTP-Referer` and `X-Title` headers. Without
 * them some models return 404. We set them now.
 */
const OPENROUTER_MODELS = [
  "meta-llama/llama-3.1-8b-instruct:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "mistralai/mistral-7b-instruct:free",
  "openai/gpt-4o-mini",
  "meta-llama/llama-3.1-8b-instruct",
];

export class OpenRouterProvider extends BaseAIProvider {
  public name = "openrouter";

  constructor(apiKey: string) {
    super({ apiKey, model: OPENROUTER_MODELS[0] });
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      // Required by OpenRouter — without these, some models 404.
      "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_TITLE ?? "FlexiData",
    };
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

  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    let lastErr: Error | null = null;

    for (const model of OPENROUTER_MODELS) {
      try {
        const response = await this.fetchWithTimeout(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: this.buildHeaders(),
            body: JSON.stringify(this.buildBody(model, request)),
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          // 404 → wrong model name, try next.
          // 402 → free tier limit hit on this model, try next (paid fallback).
          if (response.status === 404 || response.status === 402) {
            lastErr = new Error(`OpenRouter ${response.status} for ${model}: ${errText}`);
            continue;
          }
          throw new Error(`OpenRouter error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        return {
          content: data.choices[0].message.content,
          model: data.model ?? model,
        };
      } catch (err) {
        throw err;
      }
    }

    throw lastErr ?? new Error("OpenRouter: all model candidates failed");
  }

  supportsStreaming(): boolean {
    return true;
  }

  async *streamCompletion(request: AIRequest): AsyncGenerator<string, void, unknown> {
    let lastErr: Error | null = null;

    for (const model of OPENROUTER_MODELS) {
      try {
        const response = await this.fetchWithTimeout(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: this.buildHeaders(),
            body: JSON.stringify(this.buildBody(model, request, true)),
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 404 || response.status === 402) {
            lastErr = new Error(`OpenRouter ${response.status} for ${model}`);
            continue;
          }
          throw new Error(`OpenRouter error: ${response.status} ${errText}`);
        }

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
        return;
      } catch (err) {
        throw err;
      }
    }

    throw lastErr ?? new Error("OpenRouter: all model candidates failed for stream");
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: this.buildHeaders(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
