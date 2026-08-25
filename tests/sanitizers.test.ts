/**
 * Egyptian mobile sanitizer + receipt schema post-processing locks.
 *
 * Covers the two production defects on Fawry/SuperPay/Aman thermal receipts:
 *  - OCR noise around mobile numbers (debris, Arabic-Indic digits,
 *    country-code forms, separators) is cleaned deterministically;
 *  - a single misread glyph in the "01X" prefix zone ("06" instead of "01")
 *    is soft-fixed ONLY when the remaining digits strictly satisfy the
 *    national pattern — never fabricated elsewhere;
 *  - unrelated short numbers (the "15468" hotline) pass through untouched so
 *    grounding/validation — not a sanitizer — decide their fate.
 */
import { test, equal, ok } from "./harness.ts";
import {
  EGYPTIAN_MOBILE_PATTERN,
  isMobileField,
  sanitizeMobileNumber,
} from "../src/lib/pipeline/extractor/sanitizers.ts";
import { normalizeFields } from "../src/lib/pipeline/extractor/normalizer.ts";
import type { RawExtraction } from "../src/lib/pipeline/types";

// ─── sanitizeMobileNumber ───────────────────────────────────────────────────

test("strict Egyptian mobiles pass through unchanged", () => {
  equal(sanitizeMobileNumber("01012345678"), "01012345678");
  equal(sanitizeMobileNumber("01123456789"), "01123456789");
  equal(sanitizeMobileNumber("01234567890"), "01234567890");
  equal(sanitizeMobileNumber("01555555555"), "01555555555");
});

test("Arabic-Indic digits are unified to ASCII", () => {
  equal(sanitizeMobileNumber("٠١٠١٢٣٤٥٦٧٨٩".slice(0, 11)), "01012345678");
});

test("thermal debris and separators are stripped (real fixture shape)", () => {
  equal(
    sanitizeMobileNumber("(0123456789); Hostinger;Description"),
    "0123456789",
    "parenthesized number glued to footer text"
  );
  equal(sanitizeMobileNumber("0123-456-789"), "0123456789", "dashes join");
  equal(sanitizeMobileNumber("+20 1012345678"), "01012345678", "country code without trunk zero");
  equal(sanitizeMobileNumber("2001012345678"), "01012345678", "country code keeping trunk zero");
});

test("a single prefix typo is soft-fixed only under strict structural confidence", () => {
  // "06" instead of "01": position 2 of the prefix misread (1→6).
  equal(sanitizeMobileNumber("06012345678"), "01012345678");
  // Operator digit misread at position 3 (1→7).
  equal(sanitizeMobileNumber("01712345678"), "01112345678");
});

test("no repair when the damage is outside the prefix zone", () => {
  // A 12-digit reading (one extra subscriber digit) is never truncated or
  // rewritten — only the guarded prefix zone may ever change.
  equal(sanitizeMobileNumber("010123456789"), "010123456789");
  ok(!EGYPTIAN_MOBILE_PATTERN.test("010123456789"));
});

test("unrelated short numbers pass through untouched (hotline never promoted)", () => {
  equal(sanitizeMobileNumber("15468"), "15468");
});

test("values without any digits pass through trimmed", () => {
  equal(sanitizeMobileNumber(""), "");
  equal(sanitizeMobileNumber("N/A"), "N/A");
});

// ─── Field eligibility + normalizer wiring ──────────────────────────────────

function schemaOf(key: string, labelGroup?: string) {
  return {
    key,
    type: "string" as const,
    ...(labelGroup !== undefined ? { labelGroup } : {}),
  };
}

test("isMobileField follows the label-group/key conventions", () => {
  ok(isMobileField(schemaOf("mobile_number") as never), "mobile_ prefix");
  ok(isMobileField(schemaOf("whatsapp_phone") as never), "phone infix");
  ok(isMobileField(schemaOf("contact", "phone") as never), "explicit phone group");
  ok(!isMobileField(schemaOf("merchant_name") as never), "names are not phones");
  ok(!isMobileField(schemaOf("reference_number") as never), "references are not phones");
});

test("normalizeFields sanitizes mobile values while preserving verbatim rawValue", () => {
  const profile = {
    id: "receipt-test",
    label: "Receipt test",
    docTypes: ["receipt"],
    version: 1,
    promptTemplate: "",
    exportConfig: { formats: ["json" as const], filename: "receipt" },
    schema: {
      version: 1,
      fields: [
        schemaOf("mobile_number") as never,
        schemaOf("receipt_number") as never,
      ],
    },
    validationRules: [],
  };

  const raw = {
    data: {
      mobile_number: "(06012345678); Hostinger;Description",
      receipt_number: "(06012345678); Hostinger;Description",
    },
  } as unknown as RawExtraction;

  const map = normalizeFields(profile as never, raw);

  equal(map.mobile_number.value, "01012345678", "mobile field sanitized");
  equal(
    map.mobile_number.rawValue,
    "(06012345678); Hostinger;Description",
    "rawValue stays verbatim for grounding"
  );
  equal(
    map.receipt_number.value,
    "(06012345678); Hostinger;Description",
    "non-mobile fields untouched"
  );
});
