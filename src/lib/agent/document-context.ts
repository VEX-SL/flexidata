import type { StructuredDocument } from "@/lib/pipeline/structured-document";

/**
 * Agent chat context — the single place that turns stored documents into
 * prompt context. Structured Documents (from the extraction engine) are the
 * PRIMARY context: verified fields, their evidence, and what could NOT be
 * confirmed. Raw OCR text is only supporting evidence, and is clearly labeled
 * as such so the model reasons over the grounded fields instead of
 * re-extracting values from raw text.
 */

/** Raw slice budget per document for supporting evidence. */
const RAW_CHARS_PER_DOC = 30_000;
/** Longest displayed value / quote before truncation. */
const MAX_VALUE_CHARS = 120;
const MAX_QUOTE_CHARS = 200;

export interface AgentDocumentRow {
  title: string;
  parsed_content?: string | null;
  structured_content?: StructuredDocument | null;
}

/**
 * Build the full file context for an agent chat. Structured blocks come first;
 * documents without structured content keep their raw text so pre-extraction
 * uploads still work.
 */
export function buildAgentDocumentContext(
  docs: AgentDocumentRow[]
): { context: string; structuredCount: number; rawCount: number } {
  const blocks: string[] = [];
  let structuredCount = 0;
  let rawCount = 0;

  for (const doc of docs) {
    if (doc.structured_content && doc.structured_content.fields) {
      blocks.push(
        `${renderStructuredDocument(doc.title, doc.structured_content)}\n\n` +
          renderRawEvidence(doc.parsed_content)
      );
      structuredCount++;
    } else {
      blocks.push(renderRawDocument(doc.title, doc.parsed_content));
      rawCount++;
    }
  }

  return {
    context: blocks.join("\n\n---\n\n"),
    structuredCount,
    rawCount,
  };
}

/** Render one document with a Structured Document into a context block. */
export function renderStructuredDocument(
  title: string,
  doc: StructuredDocument
): string {
  const lines: string[] = [];
  lines.push(`### Document: ${title}`);
  lines.push(
    `**Document type:** ${doc.profileLabel} · **Overall extraction confidence:** ${formatConfidence(
      doc.overallConfidence
    )}`
  );

  lines.push("");
  lines.push(
    "**Verified fields (authoritative — grounded by the extraction engine):**"
  );
  if (doc.fields.length === 0) {
    lines.push("- (none)");
  } else {
    for (const f of doc.fields) {
      lines.push(`- ${bulletField(f)}`);
    }
  }

  if (doc.dropped.length > 0) {
    lines.push("");
    lines.push(
      "**Could not be confirmed (absent from this document — do NOT invent these):**"
    );
    for (const d of doc.dropped) {
      lines.push(`- \`${d.key}\` — ${d.reason}`);
    }
  }

  return lines.join("\n");
}

/** Render one document without a Structured Document (raw-only fallback). */
export function renderRawDocument(
  title: string,
  parsedContent?: string | null
): string {
  const body = (parsedContent ?? "").slice(0, RAW_CHARS_PER_DOC);
  const label = body
    ? "**Raw text only** (not yet processed by the extraction engine — may contain OCR misreads):"
    : "(empty document)";
  return `### Document: ${title}\n${label}${body ? `\n${body}` : ""}`;
}

/** The raw OCR appendix inside a structured block (supporting evidence). */
function renderRawEvidence(parsedContent?: string | null): string {
  const body = (parsedContent ?? "").slice(0, RAW_CHARS_PER_DOC);
  if (!body) return "**Supporting raw OCR text:** (empty)";
  return (
    "**Supporting raw OCR text (evidence only — may contain misreads; verified fields above are authoritative):**\n" +
    body
  );
}

function bulletField(f: {
  key: string;
  label: string;
  value: unknown;
  rawValue?: unknown;
  confidence: number;
  evidence?: Array<{ quote: string; role?: string }>;
}): string {
  const label = f.label && f.label !== f.key ? ` (${f.label})` : "";
  const renderedValue = renderValue(f.value);
  const rawNote =
    f.rawValue !== undefined &&
    f.rawValue !== null &&
    f.rawValue !== f.value
      ? ` (raw: \`${truncate(String(f.rawValue), MAX_VALUE_CHARS)}\`)`
      : "";
  const evidence = renderEvidence(f.evidence);

  return (
    `\`${f.key}\`${label} = \`${renderedValue}\`${rawNote}` +
    ` (confidence ${formatConfidence(f.confidence)})` +
    (evidence ? ` — ${evidence}` : "")
  );
}

function renderEvidence(
  evidence?: Array<{ quote: string; role?: string }>
): string {
  if (!evidence || evidence.length === 0) return "";
  const parts = evidence.map((e) => {
    const rolePrefix =
      e.role === "derived"
        ? "derived from"
        : e.role === "semantic"
          ? "from context"
          : "OCR";
    return `${rolePrefix} "${truncate(e.quote, MAX_QUOTE_CHARS)}"`;
  });
  return parts.join(" ; ");
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "object") {
    try {
      return truncate(JSON.stringify(value), MAX_VALUE_CHARS);
    } catch {
      return truncate(String(value), MAX_VALUE_CHARS);
    }
  }
  return truncate(String(value), MAX_VALUE_CHARS);
}

function formatConfidence(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "n/a";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
