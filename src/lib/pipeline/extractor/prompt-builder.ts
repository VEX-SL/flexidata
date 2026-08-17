import type { ExtractionMode, ExtractionProfile } from "../types";

const MAX_DOCUMENT_CHARS = 60_000;

/**
 * Renders a profile's prompt template.
 * Supported placeholders: {{schema}}, {{document}}.
 * A strict output contract is appended so the model returns verbatim raw
 * values and evidence for every field (grounding input).
 *
 * In dynamic mode the profile schema is NOT injected: the model discovers
 * fields from the document content instead (no predefined field list).
 */
export function buildExtractionPrompt(
  profile: ExtractionProfile,
  sourceText: string,
  mode: ExtractionMode = "legacy"
): string {
  if (mode === "dynamic") return buildDynamicPrompt(sourceText);

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

// ─── Dynamic mode (schema-free field discovery) ────────────────────────────

/**
 * Dynamic-mode prompt: tells the model to discover meaningful fields itself.
 * There is NO predefined field list, no `{{schema}}`, and no profile template.
 * The instruction set covers the M22 discovery contract: understand the
 * document first, discover every meaningful factual entity, preserve the exact
 * source text, never invent, never force categories, never merge fragments,
 * and distinguish headings/branding from identifiers.
 *
 * AI instructions are NOT the safety boundary — universal grounding remains
 * authoritative. The prompt only steers the model toward faithful discovery.
 */
const DYNAMIC_PROMPT = `You are a document field discovery engine.
Discover every meaningful field present in the document and return them as structured data.

First, read the whole document and understand what kind of document it is and what information it conveys. Then discover the meaningful semantic entities it contains — identifiers, dates, amounts, names, codes, and any other factual information.

Rules:
- Discover the fields yourself from the document content. There is NO predefined field list and NO expected field names.
- Use the document's own terminology for field names and labels where possible (e.g. "account number", "opening balance", "رقم العميل").
- Only return values that are actually present in the document. Never invent, guess, or extrapolate a value.
- Never force a value into a category it does not belong to. If the document does not support a category, omit it.
- Distinguish headings and branding from identifiers: a document title, merchant brand, or decorative header is NOT an identifier such as a receipt number or reference. Do not turn a brand or header line into an ID.
- Preserve multiple identifiers separately. Never merge two unrelated OCR fragments into one value (e.g. never combine a receipt number with a merchant name, or two different codes).
- Copy the value EXACTLY as it appears in "raw" — never normalize, translate, combine, or "fix" it. Reflect unclear characters and uncertainty in "confidence".
- Omit any piece of information you cannot quote verbatim from the document.
- A field label must be a semantic category of the information (e.g. "receipt number", "total"), never an arbitrary printed fragment of the document text.
- On OCR lines that mix Arabic and English, the printed order may be unreliable (RTL bidi layout): never assume the segment before ":" is the label. In an Arabic document the Arabic segment of a mixed line is usually the label. If you cannot confidently determine which side is the label, do NOT create the field.
- Only create a field when the value is plausibly compatible with the meaning of the label (a "mobile number" label must hold a phone number, not another label or a foreign text fragment).
- Do not turn broken or garbled OCR snippets into fields: a line that reads as short fragments with no clear category is not a field — omit it.
- For each field include: a field name, the value, and a useful type.

Document:
{{document}}`;

/**
 * Dynamic output contract. Same grounding preconditions as legacy (verbatim
 * `raw` + `evidence` quote) plus discoverability metadata (`type`, `label`).
 * The response shape is stable: `{ "data": { <name>: { raw, value, type,
 * label, confidence, evidence } } }`. Bare primitives are also accepted.
 *
 * `evidence` is the grounding anchor: it MUST be a verbatim quote from the
 * document. A field whose value has no verbatim evidence must be OMITTED
 * entirely (never a fabricated quote).
 */
const DYNAMIC_OUTPUT_CONTRACT = `STRICT OUTPUT FORMAT — this overrides any format hints above.
Return exactly one JSON object with a single key "data". Each key of "data" is a field name you discovered.

Each field value SHOULD be an object with:
{
  "raw": <the value EXACTLY as it appears in the document text — copy characters verbatim, never normalize, translate, combine or "fix" them>,
  "value": <the value as typed data — numbers as numbers, arrays as arrays, objects as objects, otherwise the string as printed>,
  "type": <one of "string", "number", "currency", "date", "boolean", "enum", "object", "array", "text">,
  "label": <human-readable field name, using the document's terminology>,
  "confidence": <number between 0 and 1>,
  "evidence": <exact short quote from the document that contains this value>
}

Rules:
- "raw" MUST be a verbatim substring of the provided document. If you cannot quote it verbatim, set "raw": null.
- "evidence" MUST be a verbatim quote of the region (usually one line) containing the value.
- Never infer or invent values the document does not state.
- Never merge fragments: one field = one contiguous piece of the document. Do not stitch together pieces from different lines into a single value.
- Omit a field entirely when you cannot quote its value verbatim — do not keep it with an invented evidence string.
- Never normalize away ambiguity: if characters are unclear, transcribe them as printed in "raw" and reflect uncertainty in "confidence".
- Never include text outside the JSON.`;

/** Render the schema-free dynamic prompt (no profile template, no schema). */
export function buildDynamicPrompt(sourceText: string): string {
  const document = truncateMiddle(sourceText, MAX_DOCUMENT_CHARS);
  return (
    DYNAMIC_PROMPT.replace(/\{\{document\}\}/g, document) +
    "\n\n" +
    DYNAMIC_OUTPUT_CONTRACT
  );
}

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
