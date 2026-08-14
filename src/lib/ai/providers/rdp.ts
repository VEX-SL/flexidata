import type { AIRequest, AIResponse } from "@/types";
import { BaseAIProvider } from "./base";

export class RdpProvider extends BaseAIProvider {
  name = "rdp-deepseek";
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    super({ apiKey });
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  supportsStreaming(): boolean {
    return false;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ prompt: "ping" })
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    const lastMessage = request.messages[request.messages.length - 1]?.content || "";

    const response = await fetch(`${this.baseUrl}/v1/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ prompt: lastMessage })
    });

    if (!response.ok) {
      throw new Error(`RDP Provider HTTP error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(`RDP Provider API error: ${data.error || "Unknown error"}`);
    }

    return {
      content: data.response
    };
  }
}