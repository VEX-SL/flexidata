import type { ExtractionProfile, ProfilePlugin } from "../types";

/**
 * Fallback profile used when the classifier returns "unknown".
 * Extracts a minimal set of generic fields so the pipeline still produces
 * something reviewable instead of failing.
 */
const schema = {
  version: 1,
  fields: [
    { key: "document_title", type: "string" as const, label: "Document title", required: true },
    { key: "document_date", type: "date" as const, label: "Document date" },
    { key: "author_name", type: "string" as const, label: "Author / sender name" },
    { key: "recipient_name", type: "string" as const, label: "Recipient name" },
    { key: "key_numbers", type: "array" as const, itemsType: "string" as const, label: "Key numbers", description: "Prominent numbers (references, amounts, quantities)" },
    { key: "summary", type: "text" as const, label: "Summary", description: "2-4 sentence summary of the document" },
  ],
};

const promptTemplate = `You are a generic document data extraction engine.
The document type is not recognized. Extract a minimal generic set of fields.
Return ONLY valid JSON matching the given schema.

Rules:
- Normalize dates to YYYY-MM-DD.
- If a value is absent, use null or []. Do not invent values.
- For each field you may include a numeric "confidence" between 0 and 1 (optional).
- Never include explanation text outside the JSON.

Schema:
{{schema}}

Document:
{{document}}`;

const validationRules = [
  { key: "document_title", kind: "string" as const, required: true },
];

export const fallbackProfile: ExtractionProfile = {
  id: "unknown",
  label: "Unknown Document",
  docTypes: ["unknown"],
  schema,
  promptTemplate,
  validationRules,
  exportConfig: {
    formats: ["json", "csv", "xlsx", "pdf"],
    csvColumns: ["document_title", "document_date", "author_name", "recipient_name", "summary"],
    filename: "document",
  },
  version: 1,
};

export const fallbackPlugin: ProfilePlugin = {
  info: {
    id: "unknown",
    label: "Unknown Document",
    version: 1,
    docTypes: fallbackProfile.docTypes,
    enabled: true,
  },
  build: () => fallbackProfile,
};
