import type { AIRequest, AIResponse } from "@/types";

export interface AIProviderConfig {
  apiKey: string;
  model?: string;
}

const TIMEOUT_MS = 20_000;

export abstract class BaseAIProvider {
  protected config: AIProviderConfig;
  public abstract name: string;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = TIMEOUT_MS
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  abstract chatCompletion(request: AIRequest): Promise<AIResponse>;
  abstract healthCheck(): Promise<boolean>;

  supportsStreaming(): boolean {
    return false;
  }

  async *streamCompletion(
    _request: AIRequest
  ): AsyncGenerator<string, void, unknown> {
    const response = await this.chatCompletion(_request);
    yield response.content;
  }
}
