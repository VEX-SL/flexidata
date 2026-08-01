import type {
  AIClient,
  ExtractionProfile,
  ExtractionResult,
  RawExtraction,
} from "../types";
import { extractJSON } from "./json-repair";
import { extractWithAI } from "./ai-client";
import { buildExtractionPrompt } from "./prompt-builder";
import { normalizeFields } from "./normalizer";
import { postProcessFields } from "./post-processor";

export interface ExtractDocumentInput {
  profile: ExtractionProfile;
  sourceText: string;
  model?: string;
}

/**
 * Extraction Engine facade — composes the five pipeline pieces:
 * PromptBuilder → AI Client → JSON Repair → Normalizer → Post Processor.
 * `ai` is injectable for tests; defaults to the real AIClient adapter.
 */
export async function extractDocument(
  input: ExtractDocumentInput,
  ai?: AIClient
): Promise<ExtractionResult> {
  const prompt = buildExtractionPrompt(input.profile, input.sourceText);

  const aiCall = await extractWithAI(
    {
      prompt,
      model: input.model,
    },
    ai
  );

  const raw: RawExtraction = parseRaw(aiCall.content);

  const fieldsMap = normalizeFields(input.profile, raw);
  const { fields, cleanFields, droppedFields } = postProcessFields(
    input.profile,
    fieldsMap
  );

  return {
    profileType: input.profile.id as ExtractionResult["profileType"],
    profileVersion: input.profile.version,
    fields,
    fieldsMap,
    cleanFields,
    droppedFields,
    model: aiCall.model,
    provider: aiCall.provider,
  };
}

/** Parse raw model content into a RawExtraction via the JSON repair step. */
export function parseRaw(content: string): RawExtraction {
  const parsed = extractJSON(content);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Model output is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  return {
    data: (obj.data as Record<string, unknown>) ?? obj,
    confidence:
      (obj.confidence as Record<string, number>) ??
      (obj.confidences as Record<string, number>) ??
      {},
    modelConfidence:
      typeof obj.modelConfidence === "number" ? obj.modelConfidence : undefined,
  };
}
