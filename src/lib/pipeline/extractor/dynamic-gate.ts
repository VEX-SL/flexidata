import type { RawExtraction } from "../types";
import { normalizeText } from "../ocr";

/**
 * Dynamic safety gate — deterministic post-AI filter for schema-free
 * (dynamic) extraction.
 *
 * The AI prompt only steers discovery; this gate is the deterministic safety
 * boundary for one specific, provable class of false positives: a field that
 * is a verbatim 1:1 carve-out of a single OCR line of the shape "X : Y" —
 * the model simply transcribed one line into "key : value". Such a field is
 * ambiguous whenever the label/value assignment cannot be trusted:
 *
 *  - Case A: "Mobile Number : معلومات اضافيه" → key="Mobile Number",
 *    value="معلومات اضافيه". On an Arabic-containing (RTL) line the printed
 *    order is bidi-unreliable; in an Arabic context the Arabic segment is the
 *    label, so a Latin key is the inverted reading. The captured production
 *    raw response proves the model emits exactly this shape with high
 *    confidence, and the value is not plausibly compatible with the label.
 *
 * A mixed-script carve is rejected only when BOTH the line is balanced-or-
 * Arabic (arabicRatio >= 0.5) AND the document is Arabic-dominant — so a
 * clear LTR bilingual line such as "Customer Name : أحمد" is never rejected,
 * even inside an Arabic document.
 *  - Case B: "oe a : il" → key="il", value="oe a". On a pure-Latin line the
 *    reading is LTR, so the label is the leading segment; a trailing key is
 *    the bidi-garbled reading of a broken fragment.
 *
 * The gate is conservative: it only drops a field when the evidence line is
 * EXACTLY "key : value" (or "value : key") after normalization — i.e. the
 * model copied the line verbatim as a fake label/value pair — AND the script
 * direction makes the assignment unreliable. Fields with coined keys not
 * printed in the line, digit/amount values, Arabic keys, multi-line evidence,
 * and clear LTR same-script lines are all preserved. It uses only structural
 * properties (script composition, segment order) — no blacklists, no
 * corpus-specific rules, no semantic dictionaries.
 *
 * It runs on the RAW response keys before `safeFieldKey` normalization so the
 * original AI names are compared against the evidence verbatim.
 */

const ARABIC_LETTER = /[\u0600-\u06FF]/u;
const LATIN_LETTER = /[A-Za-z]/u;

/** Letters of the Arabic writing system (basic block). */
function arabicCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ARABIC_LETTER.test(ch)) n += 1;
  return n;
}

/** Letters of the Latin writing system. */
function latinCount(s: string): number {
  let n = 0;
  for (const ch of s) if (LATIN_LETTER.test(ch)) n += 1;
  return n;
}

/** 0..1 share of letters that belong to the Arabic writing system. */
function arabicRatioOf(s: string): number {
  const ar = arabicCount(s);
  const lat = latinCount(s);
  return ar + lat === 0 ? 0 : ar / (ar + lat);
}

/**
 * True when the field is a verbatim two-half carve-out of one evidence line
 * whose label/value assignment is unreliable (see module docs).
 */
function isAmbiguousCarve(
  name: string,
  entry: unknown,
  sourceText?: string
): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const obj = entry as Record<string, unknown>;
  const value =
    typeof obj.value === "string"
      ? obj.value
      : typeof obj.raw === "string"
        ? obj.raw
        : null;
  const evidence = typeof obj.evidence === "string" ? obj.evidence : null;
  if (value === null || evidence === null) return false;

  // The evidence must be EXACTLY two colon-separated halves. Extra colons
  // (e.g. "time : 10:30") or non-colon context mean it is not a carve-out.
  const parts = evidence.split(/[:：]/);
  if (parts.length !== 2) return false;
  const p1 = parts[0].trim();
  const p2 = parts[1].trim();
  if (p1.length === 0 || p2.length === 0) return false;

  const nk = normalizeText(name);
  const nv = normalizeText(value);
  const n1 = normalizeText(p1);
  const n2 = normalizeText(p2);
  const keyFirst = n1 === nk && n2 === nv;
  const valueFirst = n1 === nv && n2 === nk;
  if (!keyFirst && !valueFirst) return false;

  // Carve-out confirmed: key and value are exactly the two halves of one line.
  if (!ARABIC_LETTER.test(evidence)) {
    // Pure-Latin (or digit-only) line: the reading is LTR, so the label is
    // the leading segment. A trailing key is the bidi-garbled reading.
    return valueFirst;
  }

  // The line contains Arabic: the printed order may be RTL-rendered.
  const keySeg = keyFirst ? p1 : p2;
  if (arabicCount(keySeg) > latinCount(keySeg)) {
    // Both RTL and LTR readings agree: the Arabic segment is the label.
    return false;
  }

  // The key is the Latin segment of an Arabic-containing line. Reject only
  // when BOTH hold:
  //  - the line itself is balanced-or-Arabic (arabicRatio >= 0.5): only then
  //    is the printed order bidi-untrustworthy (the confirmed
  //    "Mobile Number : معلومات اضافيه" line is exactly 0.5);
  //  - the surrounding document is Arabic-dominant (or unknown): only then is
  //    the Arabic segment the label. A Latin-heavy line such as
  //    "Customer Name : أحمد" keeps its clear LTR label even inside an
  //    Arabic document.
  const hasDocContext =
    sourceText !== undefined && sourceText.trim().length > 0;
  const lineArabicContext = arabicRatioOf(evidence) >= 0.5;
  const docArabicContext = hasDocContext
    ? arabicRatioOf(sourceText) >= 0.5
    : true;
  return lineArabicContext && docArabicContext;
}

/**
 * Filter a raw dynamic extraction, dropping fields that are ambiguous
 * verbatim carve-outs of a single OCR line. Non-dynamic payloads pass
 * through unchanged. Returns the input untouched when nothing was dropped.
 */
export function applyDynamicSafetyGate(
  raw: RawExtraction,
  sourceText?: string
): RawExtraction {
  const data = raw.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return raw;
  }

  let dropped = false;
  const filtered: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(data)) {
    if (isAmbiguousCarve(name, entry, sourceText)) {
      dropped = true;
      continue;
    }
    filtered[name] = entry;
  }

  if (!dropped) return raw;
  return { ...raw, data: filtered };
}
