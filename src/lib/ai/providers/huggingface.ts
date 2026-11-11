import { BaseAIProvider } from "./base";
import type { AIRequest, AIResponse } from "@/types";

/**
 * HuggingFace provider — migrated to the new Inference Router.
 *
 * OLD endpoint (deprecated, returns NETWORK errors / 404):
 *   https://api-inference.huggingface.co/models/{model}
 *
 * NEW endpoint (current, 2024+):
 *   https://router.huggingface.co/hf-inference/models/{model}/v1/chat/completions
 *
 * The new endpoint speaks the OpenAI chat-completions protocol, which is
 * much cleaner than the old `inputs` text-generation API.
 *
 * Note: the new router requires the model to be hosted as a serverless
 * Inference endpoint. Not all models on the Hub are available. We use a
 * fallback list of known-available models.
 */
const HF_MODELS = [
  "meta-llama/Llama-3.2-3B-Instruct",
  "meta-llama/Meta-Llama-3-8B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.3",
  "Qwen/Qwen2.5-7B-Instruct",
];

export class HuggingFaceProvider extends BaseAIProvider {
  public name = "huggingface";

  constructor(apiKey: string) {
    super({ apiKey, model: HF_MODELS[0] });
  }

  private buildBody(request: AIRequest) {
    return {
      model: this.config.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };
  }

  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    let lastErr: Error | null = null;

    for (const model of HF_MODELS) {
      try {
        const response = await this.fetchWithTimeout(
          `https://router.huggingface.co/hf-inference/models/${model}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...this.buildBody(request), model }),
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          // 404 / 402 → model not available, try next
          if (response.status === 404 || response.status === 402) {
            lastErr = new Error(`HuggingFace ${response.status} for ${model}: ${errText}`);
            continue;
          }
          // 422 → model exists but doesn't support chat-completions API
          if (response.status === 422) {
            lastErr = new Error(`HuggingFace ${model} doesn't support chat API (422)`);
            continue;
          }
          throw new Error(`HuggingFace API error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        return {
          content: data.choices?.[0]?.message?.content || "",
          model,
        };
      } catch (err) {
        throw err;
      }
    }

    throw lastErr ?? new Error("HuggingFace: all model candidates failed");
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Use the whoami-v2 endpoint to verify the token
      const res = await fetch("https://huggingface.co/api/whoami-v2", {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
