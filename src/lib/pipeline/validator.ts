import type {
  ExtractionResult,
  FieldValue,
  ValidationOutcome,
  ValidationResult,
  ValidationRule,
} from "./types";
import { getProfileManager } from "./profiles/registry";

const MAX_PATTERN_LENGTH = 200;
const MAX_TEST_INPUT_LENGTH = 10_000;
const compiledPatternCache = new Map<string, RegExp | null>();

function compileSafeRulePattern(pattern: string): RegExp | null {
  if (
    typeof pattern !== "string" ||
    pattern.length === 0 ||
    pattern.length > MAX_PATTERN_LENGTH
  ) {
    return null;
  }
  if (compiledPatternCache.has(pattern)) {
    return compiledPatternCache.get(pattern) ?? null;
  }
  try {
    const compiled = new RegExp(pattern); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    compiledPatternCache.set(pattern, compiled);
    return compiled;
  } catch {
    compiledPatternCache.set(pattern, null);
    return null;
  }
}

/**
 * Validator — evaluates each validation rule against the extracted fields.
 * Rules are declarative (string pattern, kind, required, range, enum).
 */
export function validateExtraction(
  extraction: ExtractionResult
): ValidationResult {
  // Dynamic extractions are not bound to the profile schema, so no profile
  // validation rule can apply: there are no required keys and no pattern/enum
  // contracts. Validation is neutral (ok) and confidence is driven by
  // grounding signals only. This is a deliberate divergence — the "schema" for
  // a dynamic extraction IS what the document produced.
  if (extraction.extractionMode === "dynamic") {
    return { ok: true, results: [], missing: [] };
  }

  const profile = getProfileManager().getOrFallback(extraction.profileType);
  const rules = profile.validationRules;
  const results: ValidationOutcome[] = [];
  const missing: string[] = [];

  // Thermal / payment-aggregator slips (receipt profile) are lenient: they
  // often print a value without a labeled number or date, so a missing field
  // is never a hard error. Required-field enforcement is skipped entirely —
  // pattern/enum checks still run for values that ARE present.
  const lenientSlip = profile.id === "receipt";

  const required = lenientSlip
    ? new Set<string>()
    : new Set(rules.filter((r) => r.required).map((r) => r.key));
  const defined = new Set(profile.schema.fields.map((f) => f.key));

  for (const key of required) {
    const fv = extraction.fieldsMap[key];
    if (!fv || isEmpty(fv)) {
      missing.push(key);
    }
  }

  // Also flag any schema-required field missing from the extraction entirely.
  if (!lenientSlip) {
    for (const field of profile.schema.fields) {
      if (field.required && !extraction.fieldsMap[field.key]) {
        if (!missing.includes(field.key)) missing.push(field.key);
      }
    }
  }

  for (const rule of rules) {
    const fv = extraction.fieldsMap[rule.key];
    const outcome = evaluate(rule, fv, extraction.fieldsMap, defined, lenientSlip);
    results.push(outcome);
  }

  const ok = results.every((r) => r.ok) && missing.length === 0;

  return { ok, results, missing };
}

function evaluate(
  rule: ValidationRule,
  fv: FieldValue | undefined,
  fieldsMap: Record<string, FieldValue>,
  defined: Set<string>,
  lenientSlip: boolean
): ValidationOutcome {
  const base = { key: rule.key, weight: rule.required && !lenientSlip ? 1 : 0.5 };

  if (rule.required && !lenientSlip && (!fv || isEmpty(fv))) {
    return { ...base, ok: false, message: "Required field is missing" };
  }
  if (!fv || isEmpty(fv)) {
    return { ...base, ok: true, message: "Field not required and empty" };
  }

  const value = fv.value;

  // Enum validation.
  if (rule.kind === "enum" && rule.allowed) {
    const raw = String(value ?? "").toUpperCase();
    const ok = rule.allowed.some((a) => a.toUpperCase() === raw);
    return {
      ...base,
      ok,
      message: ok ? "Value is one of the allowed options" : `'${value}' is not allowed`,
    };
  }

  // Regex pattern validation (applied to the string form).
  if (rule.pattern) {
    const re = compileSafeRulePattern(rule.pattern);
    if (re) {
      const sample = String(value ?? "").slice(0, MAX_TEST_INPUT_LENGTH);
      const ok = re.test(sample);
      return {
        ...base,
        ok,
        message: ok ? "Value matches expected pattern" : `Value '${value}' failed pattern`,
      };
    }
    // Malformed or overly long rule pattern — treat as pass.
  }

  // Date format validation.
  if (rule.kind === "date" && rule.format === "yyyy-mm-dd") {
    const ok = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    return {
      ...base,
      ok,
      message: ok ? "Date format is valid" : `Date '${String(value)}' is not YYYY-MM-DD`,
    };
  }

  // Numeric range validation.
  if (rule.kind === "number" || rule.kind === "currency") {
    const num = typeof value === "number" ? value : Number(String(value));
    if (!Number.isFinite(num)) {
      return { ...base, ok: false, message: `'${String(value)}' is not a number` };
    }
    if (rule.min !== undefined && num < rule.min) {
      return { ...base, ok: false, message: `Value ${num} below minimum ${rule.min}` };
    }
    if (rule.max !== undefined && num > rule.max) {
      return { ...base, ok: false, message: `Value ${num} above maximum ${rule.max}` };
    }
    return { ...base, ok: true, message: "Numeric value in range" };
  }

  // Cross-field consistency (referenced by field.crossCheck in schema).
  if (rule.key === "total_amount") {
    const subtotal = num(fieldsMap.subtotal);
    const tax = num(fieldsMap.tax_amount);
    const discount = num(fieldsMap.discount_amount);
    const total = num(fieldsMap.total_amount);
    if (total !== null && (subtotal !== null || tax !== null || discount !== null)) {
      const expected = (subtotal ?? 0) + (tax ?? 0) - (discount ?? 0);
      if (Math.abs(expected - total) / Math.max(Math.abs(total), 1) < 0.02) {
        return { ...base, ok: true, message: "Total reconciles with subtotal/tax/discount" };
      }
      return {
        ...base,
        ok: false,
        message: `Total ${total} does not reconcile with expected ${expected.toFixed(2)}`,
      };
    }
  }

  if (!defined.has(rule.key)) {
    return { ...base, ok: false, message: `Rule references unknown field '${rule.key}'` };
  }

  return { ...base, ok: true, message: "Field present" };
}

function num(fv: FieldValue | undefined): number | null {
  if (!fv) return null;
  const v = fv.value;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

function isEmpty(fv: FieldValue): boolean {
  return (
    fv.value === null ||
    fv.value === undefined ||
    fv.value === "" ||
    (Array.isArray(fv.value) && fv.value.length === 0)
  );
}