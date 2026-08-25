/**
 * Field-value sanitizers — deterministic OCR-noise repair applied at
 * normalization time (schema post-processing input shaping).
 *
 * Contract (mirrors the pipeline's grounding rules):
 *  - Sanitizers only ever touch the NORMALIZED value. The model's verbatim
 *    reading stays on `rawValue`, so grounding still anchors evidence against
 *    the printed text — a repaired value is never "ungrounded".
 *  - Repairs are conservative and reversible-by-inspection: digits are
 *    unified (Arabic-Indic → ASCII), separator debris is dropped, and the
 *    Egyptian-mobile soft fix touches AT MOST ONE leading-prefix character,
 *    and only when the remaining nine digits satisfy the strict national
 *    pattern (that structural strictness is the "high contextual confidence"
 *    gate — nothing else about the value may be broken).
 *  - Nothing is invented: when no rule applies the input passes through
 *    normalized-but-unchanged and the validator's pattern rules decide.
 */
import type { FieldSchema } from "../types";

// ─── Egyptian mobile numbers ────────────────────────────────────────────────

/**
 * Strict Egyptian mobile form: 11 digits — "01" + operator digit
 * (0=Vodafone/ORANGE… actually 0/1=Orange, 2=Vodafone, 5=e&) + 8 subscriber
 * digits. Examples: "01012345678", "01234567890", "01555555555".
 */
export const EGYPTIAN_MOBILE_PATTERN = /^01[0125]\d{8}$/;

/**
 * Country-coded form: "20" + national number, with or without the printed
 * trunk "0" ("+20 1012345678" → 201012345678, "0020010123456 78"-style
 * keep-the-zero variants also accepted). Capture group 1 is the national
 * subscriber part WITHOUT a guaranteed leading zero.
 */
const COUNTRY_CODE_PATTERN = /^20(0?1[0125]\d{8})$/;

/** Normalize a country-code capture into strict national form. */
function nationalFromCountryCode(m: RegExpMatchArray): string {
  const national = m[1];
  return national.startsWith("0") ? national : `0${national}`;
}

/**
 * Thermal-printer digit confusions OBSERVED → PRINTED, restricted to the
 * characters that can appear in the "01X" prefix zone. Thermal heads blur
 * thin glyphs into round ones: a printed "1" smears into "6"/"7"/"4", a
 * printed "5" into "3"/"9"/"6". Used ONLY for the one-character prefix soft
 * fix; never for the subscriber digits.
 */
const PREFIX_MISREAD_TO_PRINTED: Readonly<Record<string, readonly string[]>> = {
  "6": ["1", "5"],
  "7": ["1", "2"],
  "4": ["1"],
  "3": ["5"],
  "9": ["5", "1"],
};

/** Convert Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII. */
function toAsciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

/**
 * Digit runs after noise removal. Segments are maximal runs of digits and
 * INTRA-number separators (- . ( ) +); whitespace acts as a hard boundary so
 * two unrelated printed numbers ("15468 01012345678") are never merged into
 * one candidate. Letters and other debris terminate a segment.
 */
function digitRuns(val: string): string[] {
  const ascii = toAsciiDigits(val);
  const segments = ascii.match(/[\d\-+().]+/g) ?? [];
  return segments.map((seg) => seg.replace(/[\-+().]/g, "")).filter((d) => d.length > 0);
}

/**
 * One-character prefix soft fix (the "06 instead of 01" case). Applicable
 * only when the run has the exact 11-digit national LENGTH, starts with "0",
 * and its last 8 digits are intact — i.e. the only possible damage is a
 * single misread glyph in the "01X" zone. Each prefix position is repaired
 * independently (never both at once); the first candidate satisfying the
 * strict pattern wins, deterministic by table order.
 *
 * Known limitation: a glyph OCR read as a LETTER ("l", "|") was already
 * dropped by segmentation, shortening the run — such values fail the
 * length gate here and pass through unrepaired rather than being padded.
 */
function softFixPrefix(run: string): string | null {
  if (!/^\d{11}$/.test(run) || !run.startsWith("0")) return null;

  const repairsFor = (pos: 1 | 2): readonly string[] =>
    PREFIX_MISREAD_TO_PRINTED[run[pos]] ?? [];

  // Position 1: the printed operator-pair digit is almost always "1".
  for (const c of repairsFor(1)) {
    const candidate = `0${c}${run.slice(2)}`;
    if (EGYPTIAN_MOBILE_PATTERN.test(candidate)) return candidate;
  }
  // Position 2: the operator discriminator (0/1/2/5).
  for (const c of repairsFor(2)) {
    const candidate = `0${run[1]}${c}${run.slice(3)}`;
    if (EGYPTIAN_MOBILE_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

/** Longest digit run, used as the best-effort fallback. */
function longestRun(runs: string[]): string | null {
  return runs.reduce<string | null>(
    (best, r) => (best === null || r.length > best.length ? r : best),
    null
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Clean OCR noise out of an Egyptian mobile-number value.
 *
 * Order of operations (first match wins):
 *  1. unify Arabic-Indic/Persian digits to ASCII;
 *  2. a whole-value country-coded form ("+20 101 234 5678" → all non-digits
 *     collapse to 200101234567 8-shape) is stripped to its national part;
 *  3. an exact strict mobile inside any digit run is returned;
 *  4. a per-run country-coded form is stripped;
 *  5. a ONE-character prefix typo is soft-fixed when the rest of the run
 *     strictly satisfies the national pattern;
 *  6. otherwise the longest digit run (or the trimmed original when it
 *     contains no digits) passes through unchanged for validation to judge.
 *
 * Never throws; never fabricates digits beyond the guarded prefix repair.
 */
export function sanitizeMobileNumber(val: string): string {
  const original = String(val ?? "").trim();
  if (!original) return original;

  const runs = digitRuns(original);

  // 2. Whole-value country code ("+20 1012345678").
  const collapsed = runs.join("");
  const countryCode = collapsed.match(COUNTRY_CODE_PATTERN);
  if (countryCode) return nationalFromCountryCode(countryCode);

  // 3./4. Exact national form, then per-run country code.
  for (const run of runs) {
    if (EGYPTIAN_MOBILE_PATTERN.test(run)) return run;
    const cc = run.match(COUNTRY_CODE_PATTERN);
    if (cc) return nationalFromCountryCode(cc);
  }

  // 5. Single-glyph prefix repair under strict structural confidence.
  for (const run of runs) {
    const fixed = softFixPrefix(run);
    if (fixed !== null) return fixed;
  }

  // 6. Best effort — validator patterns flag whatever remains invalid.
  const longest = longestRun(runs);
  return longest ?? original;
}

/**
 * Metadata-driven eligibility (mirrors label-lexicon's key conventions):
 * a field is treated as a phone/mobile number when its semantic group is
 * "phone" or its key names a mobile/phone value.
 */
export function isMobileField(field: FieldSchema): boolean {
  return (
    field.labelGroup === "phone" ||
    field.key.startsWith("mobile") ||
    field.key.startsWith("phone") ||
    field.key.includes("phone")
  );
}
