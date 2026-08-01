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
  if (!input.prompt || input.prompt.trim().length === 0) {
    throw new Error("Extraction prompt is empty");
  }

  const request: AIRequest = {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.prompt },
    ],
    maxTokens: 4096,
    temperature: 0,
  };

  const response = await ai.chatCompletion(request);

  return {
    model: input.model ?? response.model ?? "unknown",
    provider: response.provider,
    content: response.content ?? "",
  };
}
