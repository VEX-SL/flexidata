import type { AIRequest, AIResponse } from "@/types";

export interface AIProviderConfig {
  apiKey: string;
  model?: string;
}

/**
 * Default request timeout. Gemini's first request can take 25-35s due to
 * cold start + reasoning, so we bumped this from 20s → 30s.
 *
 * Individual providers can override this by passing a custom timeoutMs to
 * fetchWithTimeout (see GeminiProvider which uses 45s).
 */
const TIMEOUT_MS = 30_000;

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
