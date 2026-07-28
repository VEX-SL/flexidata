import { BaseAIProvider } from "./base";
import type { AIRequest, AIResponse } from "@/types";

export class DeepSeekProvider extends BaseAIProvider {
  public name = "deepseek";

  constructor(apiKey: string) {
    super({ apiKey, model: "deepseek-chat" });
  }

  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    const response = await this.fetchWithTimeout(
      "https://api.deepseek.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          max_tokens: request.maxTokens ?? 4096,
          temperature: request.temperature ?? 0.7,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      model: data.model,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch("https://api.deepseek.com/v1/models", {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
