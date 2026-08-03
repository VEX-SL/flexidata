import type { AIRequest } from "@/types";
import type { AIClient } from "../types";
import { defaultAIClient } from "../ai";

const SYSTEM_PROMPT =
  "You are a data extraction engine. Reply with ONLY a single valid JSON object. " +
  "No markdown, no explanation, no commentary outside the JSON.";

export interface AiExtractionInput {
  prompt: string;
  model?: string;
}

export interface AiExtractionOutput {
  model: string;
  provider?: string;
  content: string;
}

/**
 * AI Client — the only place that calls the model for extraction.
 * Depends on the `AIClient` abstraction (injectable for tests), never on a
 * concrete provider.
 */
export async function extractWithAI(
  input: AiExtractionInput,
  ai: AIClient = defaultAIClient
): Promise<AiExtractionOutput> {
  const response = await ai.chatCompletion(buildRequest(input.prompt));
  return {
    model: input.model ?? response.model ?? "unknown",
    provider: response.provider,
    content: response.content ?? "",
  };
}

/**
 * Cross-provider retry — re-issues the extraction prompt skipping providers
 * already used for this document. Only wired when the AIClient implements
 * `retryProviders`; callers must already have exhausted deterministic recovery.
 */
export async function extractWithAIRetry(
  input: AiExtractionInput,
  ai: AIClient,
  skipProviders: string[]
): Promise<AiExtractionOutput> {
  if (!ai.retryProviders) {
    throw new Error("AIClient does not support provider rotation");
  }
  const response = await ai.retryProviders(
    buildRequest(input.prompt),
    skipProviders
  );
  return {
    model: input.model ?? response.model ?? "unknown",
    provider: response.provider,
    content: response.content ?? "",
  };
}

function buildRequest(prompt: string): AIRequest {
  if (!prompt || prompt.trim().length === 0) {
    throw new Error("Extraction prompt is empty");
  }
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    maxTokens: 4096,
    temperature: 0,
  };
}
