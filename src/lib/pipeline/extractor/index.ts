import type {
  AIClient,
  ExtractionProfile,
  ExtractionResult,
  FieldsMap,
  NormalizedField,
  OcrDocument,
  RawExtraction,
} from "../types";
import { extractJSON } from "./json-repair";
import { extractWithAI } from "./ai-client";
import { buildExtractionPrompt } from "./prompt-builder";
import { normalizeFields } from "./normalizer";
import { groundExtraction } from "./grounding";

export interface ExtractDocumentInput {
  profile: ExtractionProfile;
  sourceText: string;
  ocr?: OcrDocument;
  model?: string;
}

export interface ExtractDocumentOptions {
  /**
   * When false, returns raw AI *candidates* (normalized values, ungrounded,
   * model confidence). The pipeline's "ground" stage commits them. Defaults
   * to true for direct callers (tests/tools) that want a finished extraction.
   */
  grounded?: boolean;
}

/**
 * Extraction Engine facade — composes the pipeline pieces:
 * PromptBuilder → AI Client → JSON Repair → Normalizer → Grounding.
 * `ai` is injectable for tests; defaults to the real AIClient adapter.
 */
export async function extractDocument(
  input: ExtractDocumentInput,
  ai?: AIClient,
  opts: ExtractDocumentOptions = {}
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
  const normalizedMap = normalizeFields(input.profile, raw);

  const candidates: ExtractionResult = {
    profileType: input.profile.id as ExtractionResult["profileType"],
    profileVersion: input.profile.version,
    fields: candidateFields(input.profile, normalizedMap),
    fieldsMap: normalizedMap,
    cleanFields: candidateCleanFields(normalizedMap),
    droppedFields: {},
    model: aiCall.model,
    provider: aiCall.provider,
  };

  if (opts.grounded === false) return candidates;

  return groundExtraction(
    input.profile,
    candidates,
    input.sourceText,
    input.ocr
  );
}

function candidateFields(
  profile: ExtractionProfile,
  map: FieldsMap
): NormalizedField[] {
  const fields: NormalizedField[] = [];
  for (const field of profile.schema.fields) {
    if (map[field.key]) fields.push({ field, value: map[field.key] });
  }
  return fields;
}

function candidateCleanFields(map: FieldsMap): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, fv] of Object.entries(map)) {
    if (!isEmptyValue(fv.value)) clean[key] = fv.value;
  }
  return clean;
}

function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  );
}

/** Parse raw model content into a RawExtraction via the JSON repair step. */
export function parseRaw(content: string): RawExtraction {
  const parsed = extractJSON(content);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Model output is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // Models may echo the profile schema shape (`{version, fields}`), wrap
  // fields under `data`, or return a flat object. Unwrap the first of
  // `data` / `fields` that holds the extracted values, falling back to the
  // root object.
  const data =
    (obj.data as Record<string, unknown>) ??
    (obj.fields as Record<string, unknown>) ??
    obj;

  return {
    data,
    confidence:
      (obj.confidence as Record<string, number>) ??
      (obj.confidences as Record<string, number>) ??
      {},
    modelConfidence:
      typeof obj.modelConfidence === "number" ? obj.modelConfidence : undefined,
  };
}
