import { BaseAIProvider } from "./base";
import type { AIRequest, AIResponse } from "@/types";

export class HuggingFaceProvider extends BaseAIProvider {
  public name = "huggingface";

  constructor(apiKey: string) {
    super({ apiKey, model: "mistralai/Mistral-7B-Instruct-v0.2" });
  }

  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    const prompt = request.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n") + "\nassistant:";

    const response = await this.fetchWithTimeout(
      `https://api-inference.huggingface.co/models/${this.config.model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            max_new_tokens: request.maxTokens ?? 4096,
            temperature: request.temperature ?? 0.7,
            return_full_text: false,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(
        `HuggingFace API error: ${response.status} ${JSON.stringify(err)}`
      );
    }

    const data = await response.json();
    const generatedText = Array.isArray(data)
      ? data[0]?.generated_text
      : data.generated_text;

    return { content: generatedText || "", model: this.config.model! };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(
        `https://huggingface.co/api/models/${this.config.model}`
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}
