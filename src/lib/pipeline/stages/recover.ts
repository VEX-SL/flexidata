import type {
  AIClient,
  ExtractionProfile,
  ExtractionResult,
  FieldEvidence,
  FieldSchema,
  FieldValue,
  FieldsMap,
  NormalizedField,
  OcrDocument,
  PipelineStage,
} from "../types";
import { buildOcrDocument } from "../ocr";
import { recoverMissingFields, type RecoverResult } from "../extractor/recovery";
import { candidatesFromAICall } from "../extractor";
import { buildExtractionPrompt } from "../extractor/prompt-builder";
import { extractWithAIRetry } from "../extractor/ai-client";
import { groundExtraction } from "../extractor/grounding";
import { isEmptyValue } from "../extractor/post-processor";
import {
  createLayoutEvidenceProvider,
  layoutReaderFor,
} from "@/lib/extraction/layout-aware-evidence";

/**
 * Stage: recover. Fills required fields that the model left null and strict
 * grounding could not confirm, WITHOUT inventing anything:
 *
 * 1. Deterministic, label-driven evidence search (profile metadata only):
 *    single grounded candidate → source "ocr" / status "flagged" (low
 *    confidence); several candidates → status "ambiguous" with alternatives;
 *    none → keep null. Flagged candidates re-pass through the grounding ladder
 *    (relabel veto + universal semantic checks) before being committed.
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
      // Verdict pass: re-anchor flagged FIND candidates through the same
      // grounding ladder, so recovery can never commit a value strict grounding
      // would veto (relabel conflicts, tax/currency/noise checks).
      const flagged = groundFlaggedRecovery(
        profile,
        extraction,
        recovered,
        ctx.sourceText,
        ocrDoc,
        ctx.ocr === undefined
          ? undefined
          : createLayoutEvidenceProvider(layoutReaderFor(ctx.ocr))
      );
      const eligible = retryEligibleRequiredFields(profile, extraction, recovered);

      ctx.recovery = {
        flagged: [...flagged.keys()],
        ambiguous: [...recovered.ambiguous.keys()],
        retryAttempted: false,
        retryProviders: [],
      };

      ctx.extraction = applyRecovery(profile, extraction, {
        ...recovered,
        flagged,
      });

      if (eligible.length > 0 && ai?.retryProviders) {
        const skipProviders =
          typeof extraction.provider === "string" && extraction.provider.length > 0
            ? [extraction.provider]
            : [];
        if (skipProviders.length > 0) {
          ctx.recovery.retryAttempted = true;
          ctx.recovery.retryProviders = skipProviders;
          try {
            const documentText =
              ctx.ocr === undefined
                ? ctx.sourceText
                : layoutReaderFor(ctx.ocr).documentText(ctx.sourceText);
            const prompt = buildExtractionPrompt(
              profile,
              documentText,
              ctx.input?.extractionMode
            );
            const aiCall = await extractWithAIRetry({ prompt }, ai, skipProviders);
            const retryCandidates = candidatesFromAICall(
              profile,
              aiCall,
              ctx.input?.extractionMode
            );
            const groundedRetry = groundExtraction(
              profile,
              retryCandidates,
              ctx.sourceText,
              ocrDoc,
              ctx.ocr === undefined
                ? undefined
                : createLayoutEvidenceProvider(layoutReaderFor(ctx.ocr))
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
 * Verdict pass for flagged FIND candidates: re-anchor them through the shared
 * grounding ladder (Pass 1) so the relabel veto and the universal semantic
 * checks apply to recovery exactly as they do to grounding. The flagged status
 * and the low FIND confidence are preserved — only strict-grounding verdicts
 * gate what gets committed.
 */
function groundFlaggedRecovery(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  recovered: RecoverResult,
  sourceText: string,
  ocrDoc: OcrDocument,
  evidenceProvider?: (field: FieldSchema, fv: FieldValue) => readonly FieldEvidence[]
): Map<string, FieldValue> {
  if (recovered.flagged.size === 0) return recovered.flagged;

  const flaggedMap: FieldsMap = {};
  for (const [key, fv] of recovered.flagged) flaggedMap[key] = fv;

  const candidateExtraction: ExtractionResult = {
    ...extraction,
    fields: [],
    fieldsMap: flaggedMap,
    cleanFields: {},
    droppedFields: {},
  };
  const grounded = groundExtraction(
    profile,
    candidateExtraction,
    sourceText,
    ocrDoc,
    evidenceProvider
  );

  // Pass 1 deletes vetoed fields from the map (confidence recomposition in
  // Pass 2/3 does not); a survivor is a field still anchored after the ladder.
  const survivors = new Map<string, FieldValue>();
  for (const [key, fv] of recovered.flagged) {
    const surviving = grounded.fieldsMap[key];
    if (!surviving || isEmptyValue(surviving.value)) continue;
    survivors.set(key, fv);
  }
  return survivors;
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
