import type { ExtractionProfile } from "../types";

const MAX_DOCUMENT_CHARS = 60_000;

/**
 * Renders a profile's prompt template.
 * Supported placeholders: {{schema}}, {{document}}.
 */
export function buildExtractionPrompt(
  profile: ExtractionProfile,
  sourceText: string
): string {
  const schemaJson = JSON.stringify(profile.schema);
  const document = truncateMiddle(sourceText, MAX_DOCUMENT_CHARS);

  return profile.promptTemplate
    .replace(/\{\{schema\}\}/g, schemaJson)
    .replace(/\{\{document\}\}/g, document);
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
