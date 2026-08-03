import type {
  AIClient,
  ExtractionProfile,
  ExtractionResult,
  NormalizedField,
  PipelineStage,
} from "../types";
import { buildOcrDocument } from "../ocr";
import { recoverMissingFields, type RecoverResult } from "../extractor/recovery";
import { candidatesFromAICall } from "../extractor";
import { buildExtractionPrompt } from "../extractor/prompt-builder";
import { extractWithAIRetry } from "../extractor/ai-client";
import { groundExtraction } from "../extractor/grounding";
import { isEmptyValue } from "../extractor/post-processor";

/**
 * Stage: recover. Fills required fields that the model left null and strict
 * grounding could not confirm, WITHOUT inventing anything:
 *
 * 1. Deterministic, label-driven evidence search (profile metadata only):
 *    single grounded candidate → source "ocr" / status "flagged" (low
 *    confidence); several candidates → status "ambiguous" with alternatives;
 *    none → keep null.
 * 2. Cross-provider retry — only for required fields where the model returned
 *    null AND deterministic recovery found no candidate. The extraction prompt
 *    is re-issued on a different provider (skipping the one already used), and
 *    only grounded values are committed.
 *
 * Never rewrites OCR values or "corrects" them (e.g. a misread year): flagged
 * and ambiguous results expose uncertainty to the human reviewer instead.
 */
export function recoverStage(opts: { ai?: AIClient } = {}): PipelineStage {
  return {
    id: "recover",
    async run(ctx) {
      const profile = ctx.profile;
      const extraction = ctx.extraction;
      if (!profile || !extraction) {
        throw new Error("recover stage requires a completed extraction and profile");
      }
      const ocrDoc = ctx.ocr ?? buildOcrDocument(ctx.sourceText);
      const ai = opts.ai;

      const recovered = recoverMissingFields(
        profile,
        extraction,
        ctx.sourceText,
        ocrDoc
      );
      const eligible = retryEligibleRequiredFields(profile, extraction, recovered);

      ctx.extraction = applyRecovery(profile, extraction, recovered);

      if (eligible.length > 0 && ai?.retryProviders) {
        const skipProviders =
          typeof extraction.provider === "string" && extraction.provider.length > 0
            ? [extraction.provider]
            : [];
        if (skipProviders.length > 0) {
          try {
            const prompt = buildExtractionPrompt(profile, ctx.sourceText);
            const aiCall = await extractWithAIRetry({ prompt }, ai, skipProviders);
            const retryCandidates = candidatesFromAICall(profile, aiCall);
            const groundedRetry = groundExtraction(
              profile,
              retryCandidates,
              ctx.sourceText,
              ocrDoc
            );
            ctx.extraction = mergeRetry(
              profile,
              ctx.extraction,
              groundedRetry,
              eligible
            );
          } catch (err) {
            console.error("[Pipeline] cross-provider retry failed:", err);
          }
        }
      }
    },
  };
}

/**
 * Fields eligible for the cross-provider retry: required, still without a
 * grounded value, the model returned null (drop reason "not found in
 * document" or "empty value" — never a value grounding dropped), and
 * deterministic recovery produced no candidate.
 */
function retryEligibleRequiredFields(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  recovered: RecoverResult
): string[] {
  const eligible: string[] = [];
  for (const field of profile.schema.fields) {
    if (!field.required) continue;
    const fv = extraction.fieldsMap[field.key];
    if (fv && !isEmptyValue(fv.value)) continue;
    const reason = extraction.droppedFields[field.key];
    if (reason !== "not found in document" && reason !== "empty value") continue;
    if ((recovered.candidates.get(field.key) ?? []).length > 0) continue;
    eligible.push(field.key);
  }
  return eligible;
}

/** Commit flagged (and expose ambiguous) recovery results. */
function applyRecovery(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  recovered: RecoverResult
): ExtractionResult {
  const map = { ...extraction.fieldsMap };
  const drops = { ...extraction.droppedFields };
  const clean = { ...extraction.cleanFields };
  const recoveredKeys = new Set<string>();

  for (const [key, fv] of recovered.flagged) {
    map[key] = fv;
    clean[key] = fv.value;
    delete drops[key];
    recoveredKeys.add(key);
  }
  for (const [key, fv] of recovered.ambiguous) {
    map[key] = fv;
    drops[key] = "ambiguous — multiple grounded candidates";
    recoveredKeys.add(key);
  }

  if (recoveredKeys.size === 0) return extraction;

  return {
    ...extraction,
    fields: reorderFields(profile, extraction.fields, map, recoveredKeys),
    fieldsMap: map,
    cleanFields: clean,
    droppedFields: drops,
  };
}

/** Commit retry-provided grounded values for still-unresolved required fields. */
function mergeRetry(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  retry: ExtractionResult,
  eligibleKeys: string[]
): ExtractionResult {
  const map = { ...extraction.fieldsMap };
  const drops = { ...extraction.droppedFields };
  const clean = { ...extraction.cleanFields };
  const committedKeys = new Set<string>();

  for (const key of eligibleKeys) {
    const rv = retry.fieldsMap[key];
    if (!rv || isEmptyValue(rv.value)) continue;
    map[key] = rv;
    clean[key] = rv.value;
    delete drops[key];
    committedKeys.add(key);
  }

  if (committedKeys.size === 0) return extraction;

  return {
    ...extraction,
    fields: reorderFields(profile, extraction.fields, map, committedKeys),
    fieldsMap: map,
    cleanFields: clean,
    droppedFields: drops,
    model: retry.model ?? extraction.model,
    provider: retry.provider ?? extraction.provider,
  };
}

/** Deterministic field order: schema order, recovered entries merged in. */
function reorderFields(
  profile: ExtractionProfile,
  original: NormalizedField[],
  map: ExtractionResult["fieldsMap"],
  extraKeys: Set<string>
): NormalizedField[] {
  const order = new Map(profile.schema.fields.map((f, i) => [f.key, i]));
  const byKey = new Map(original.map((f) => [f.field.key, f] as const));
  for (const key of extraKeys) {
    const field = profile.schema.fields.find((f) => f.key === key);
    const fv = map[key];
    if (field && fv) byKey.set(key, { field, value: fv });
  }
  return Array.from(byKey.values()).sort(
    (a, b) => (order.get(a.field.key) ?? 0) - (order.get(b.field.key) ?? 0)
  );
}
