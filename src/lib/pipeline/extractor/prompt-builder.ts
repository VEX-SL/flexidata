import type { ExtractionProfile } from "../types";

const MAX_DOCUMENT_CHARS = 60_000;

/**
 * Renders a profile's prompt template.
 * Supported placeholders: {{schema}}, {{document}}.
 * A strict output contract is appended so the model returns verbatim raw
 * values and evidence for every field (grounding input).
 */
export function buildExtractionPrompt(
  profile: ExtractionProfile,
  sourceText: string
): string {
  const schemaJson = JSON.stringify(profile.schema);
  const document = truncateMiddle(sourceText, MAX_DOCUMENT_CHARS);

  return (
    profile.promptTemplate
      .replace(/\{\{schema\}\}/g, schemaJson)
      .replace(/\{\{document\}\}/g, document) +
    "\n\n" +
    OUTPUT_CONTRACT
  );
}

/**
 * Universal output contract — applies to every profile. Requires the model to
 * transcribe verbatim (`raw`) and to anchor every field with an evidence quote,
 * so the grounding stage can verify values against the source text.
 */
const OUTPUT_CONTRACT = `STRICT OUTPUT FORMAT — this overrides any format hints above.
Return exactly one JSON object with a single key "data". The keys of "data" are the schema field keys.

Each field value MUST be an object with exactly:
{
  "raw": <the value EXACTLY as it appears in the document text — copy characters verbatim, never normalize, translate or "fix" them>,
  "value": <the normalized/typed value — numbers as numbers, dates as YYYY-MM-DD, enums as the allowed code, arrays for list fields>,
  "confidence": <number between 0 and 1>,
  "evidence": <exact short quote from the document that contains this value>
}

Rules:
- "raw" MUST be a verbatim substring of the provided document. If you cannot quote it verbatim from the document, set "raw": null.
- "evidence" MUST be a verbatim quote of the region (usually one line) containing the value.
- If a field is absent from the document: "raw": null, "value": null, "confidence": 0.
- Never infer or invent values the document does not state. In particular:
  - do NOT assign a currency code unless a currency is printed (SAR/ريال/USD/...).
  - do NOT fill a tax ID unless the document shows a tax/VAT/sales-tax label.
  - do NOT create line items from footers, totals, or OCR fragments.
- Never normalize away ambiguity: if characters are unclear, transcribe them as printed in "raw" and reflect uncertainty in "confidence".
- Never include text outside the JSON.`;

/**
 * Keep the head and tail of very long documents so critical
 * fields (header values, totals at the bottom) survive truncation.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.floor(maxChars / 2);
  return (
    text.slice(0, keep) +
    `\n\n[...] truncated, ${text.length - maxChars} characters omitted [...]\n\n` +
    text.slice(text.length - keep)
  );
}
