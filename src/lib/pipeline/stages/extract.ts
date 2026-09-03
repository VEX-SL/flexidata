import type { AIClient, ExtractionResult, FieldSchema, FieldsMap, NormalizedField, PipelineStage } from "../types";
import { extractDocument } from "../extractor";
import { getProfileManager } from "../profiles/registry";
import { layoutReaderFor } from "@/lib/extraction/layout-aware-evidence";
import type { ReceiptExtraction } from "@/lib/ocr/vision-service";

/**
 * Stage: extract. Resolves the profile from the classification (this is the
 * only place that maps a type to a profile package) and runs the AI extraction
 * as *candidates* only — grounding is a separate stage, so extraction never
 * commits unverified values.
 *
 * When a Gemini Vision extraction is available (from image uploads), the
 * structured fields are used DIRECTLY — the Mistral text-extraction call is
 * skipped entirely, eliminating the hallucination risk of a secondary LLM
 * re-processing the OCR text.
 */
export function extractStage(opts: { ai?: AIClient } = {}): PipelineStage {
  return {
    id: "extract",
    async run(ctx) {
      const type = ctx.classification?.profileType ?? "unknown";
      const profile = getProfileManager().getOrFallback(type);
      ctx.profile = profile;

      // ── Gemini Vision fast-path: use structured extraction directly ──
      if (ctx.visionExtraction && hasVisionData(ctx.visionExtraction)) {
        ctx.extraction = buildExtractionFromVision(
          profile.schema.fields,
          ctx.visionExtraction,
          type
        );
        return;
      }

      // ── Fallback: Tesseract OCR → Mistral text extraction ──
      const documentText =
        ctx.ocr === undefined
          ? ctx.sourceText
          : layoutReaderFor(ctx.ocr).documentText(ctx.sourceText);
      ctx.extraction = await extractDocument(
        {
          profile,
          sourceText: documentText,
          ocr: ctx.ocr,
          extractionMode: ctx.input?.extractionMode,
        },
        opts.ai,
        { grounded: false }
      );
    },
  };
}

/** True when the vision extraction contains at least one non-empty field. */
function hasVisionData(ext: ReceiptExtraction): boolean {
  const fields: Array<string | undefined> = [
    ext.transaction_id,
    ext.reference_number,
    ext.customer_id,
    ext.mobile_number,
    ext.amount,
    ext.date,
    ext.status,
  ];
  return fields.some((v) => typeof v === "string" && v.trim().length > 0);
}

/**
 * Map a field key (snake_case) to the expected ReceiptExtraction property.
 * Returns undefined when the key doesn't correspond to a known receipt field.
 */
function visionField(
  key: string,
  ext: ReceiptExtraction
): string | undefined {
  switch (key) {
    case "transaction_id":
    case "payment_id":
    case "رقم_المعاملة":
    case "رقم العملية":
      return ext.transaction_id;
    case "reference_number":
    case "reference":
    case "رقم_المرجع":
    case "الرقم المرجعي":
      return ext.reference_number;
    case "customer_id":
    case "رقم_العميل":
      return ext.customer_id;
    case "mobile_number":
    case "phone":
    case "رقم_الموبايل":
    case "الهاتف":
      return ext.mobile_number;
    case "amount":
    case "total":
    case "المبلغ":
    case "المبلغ الإجمالي":
      return ext.amount;
    case "date":
    case "التاريخ":
    case "تاريخ المعاملة":
      return ext.date;
    case "status":
    case "الحالة":
    case "حالة العملية":
      return ext.status;
    default:
      // Check the extra array for arbitrary label/value pairs
      if (ext.extra) {
        const match = ext.extra.find(
          (e: { label: string; value: string }) =>
            e.label.toLowerCase().replace(/[\s_-]/g, "") ===
            key.toLowerCase().replace(/[\s_-]/g, "")
        );
        if (match) return match.value;
      }
      return undefined;
  }
}

/**
 * Build an ExtractionResult directly from Gemini Vision structured extraction.
 * Each field is sourced from the Vision model (not Mistral), with evidence
 * grounded later by the grounding stage.
 */
function buildExtractionFromVision(
  schemaFields: FieldSchema[],
  ext: ReceiptExtraction,
  profileType: string
): ExtractionResult {
  const fields: NormalizedField[] = [];
  const fieldsMap: FieldsMap = {};
  const cleanFields: Record<string, unknown> = {};

  for (const schema of schemaFields) {
    const raw = visionField(schema.key, ext);
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      continue;
    }
    const value = coerceToType(String(raw).trim(), schema.type);
    const normalized: NormalizedField = {
      field: schema,
      value: {
        value,
        rawValue: raw,
        confidence: 0.95,
        source: "ai",
        status: "extracted",
      },
    };
    fields.push(normalized);
    fieldsMap[schema.key] = normalized.value;
    if (value !== null && value !== undefined && value !== "") {
      cleanFields[schema.key] = value;
    }
  }

  return {
    profileType: profileType as ExtractionResult["profileType"],
    profileVersion: 1,
    extractionMode: "legacy",
    fields,
    fieldsMap,
    cleanFields,
    droppedFields: {},
    model: "gemini-1.5-flash",
    provider: "gemini",
  };
}

/** Light coercion to match the field schema type. */
function coerceToType(raw: string, type: FieldSchema["type"]): unknown {
  if (type === "number" || type === "currency") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === "boolean") {
    const s = raw.toLowerCase();
    if (["true", "1", "yes"].includes(s)) return true;
    if (["false", "0", "no"].includes(s)) return false;
    return raw;
  }
  return raw;
}
