import type {
  FieldsMap,
  NormalizedField,
  ExtractionProfile,
} from "../types";

/** Fields below this confidence are dropped into droppedFields. */
const MIN_CONFIDENCE = 0.3;

/** Empty values (including empty arrays/objects) are dropped, never exported. */
export function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
  );
}

export interface PostProcessResult {
  fields: NormalizedField[];
  cleanFields: Record<string, unknown>;
  droppedFields: Record<string, string>;
}

/**
 * Post Processor — final gate over normalized fields:
 * drops null/empty values and low-confidence fields, records reasons.
 */
export function postProcessFields(
  profile: ExtractionProfile,
  fieldsMap: FieldsMap
): PostProcessResult {
  const fields: NormalizedField[] = [];
  const cleanFields: Record<string, unknown> = {};
  const droppedFields: Record<string, string> = {};

  for (const field of profile.schema.fields) {
    const fv = fieldsMap[field.key];
    if (!fv) {
      droppedFields[field.key] = "not found in document";
      continue;
    }
    if (isEmptyValue(fv.value)) {
      droppedFields[field.key] = "empty value";
      continue;
    }
    if (fv.confidence < MIN_CONFIDENCE) {
      droppedFields[field.key] = `confidence below threshold (${fv.confidence.toFixed(2)})`;
      continue;
    }
    fields.push({ field, value: fv });
    cleanFields[field.key] = fv.value;
  }

  return { fields, cleanFields, droppedFields };
}
