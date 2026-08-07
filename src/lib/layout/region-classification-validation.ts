/**
 * Milestone 5 region classification validation — the M5 contract checks.
 *
 * Every validator is mutation-free and deterministic and returns the shared
 * frozen `ValidationResult`. The checks cover: a valid region-type vocabulary,
 * deterministic rebuilds, confidence bounds, deep-frozen output, complete
 * region coverage, adaptive threshold validity (no silent fixed thresholds)
 * and explanation consistency (every piece of evidence matches the feature
 * values and threshold sets it claims).
 */
import { validationResult } from "./validation";
import type { ValidationResult } from "./validation";
import { REGION_TYPES, isRegionType } from "./region-types";
import { NODE_LEVEL } from "./node-levels";
import type { LayoutHierarchy } from "./hierarchy";
import { CLASSIFICATION_EPSILON } from "./region-classifier";
import type {
  RegionClassificationOutcome,
} from "./region-classifier";
import type { RegionStatisticSample } from "./region-classifier";
import type { RegionThresholdSet } from "./region-classifier";
import { readRegionFeature } from "./region-features";

const VALID_METHODS = new Set([
  "median",
  "quantile",
  "max",
  "mad",
  "derived",
  "fallback",
]);

/**
 * Every classification carries a valid region type, a non-empty unique region
 * id, a confidence profile and its feature set; every candidate is a valid
 * type.
 */
export function validateRegionClassificationTypes(
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const classification of outcome.classifications) {
    if (classification.regionId.length === 0) {
      errors.push("classification has an empty region id");
    }
    if (seen.has(classification.regionId)) {
      errors.push(
        `region ${classification.regionId} is classified more than once`
      );
    }
    seen.add(classification.regionId);
    if (!isRegionType(classification.type)) {
      errors.push(
        `region ${classification.regionId} has unknown type ${String(
          classification.type
        )}`
      );
    }
    if (classification.confidence === undefined) {
      errors.push(`region ${classification.regionId} has no confidence profile`);
    }
    if (classification.features === undefined) {
      errors.push(`region ${classification.regionId} has no feature set`);
    }
    for (const candidate of classification.candidates) {
      if (!isRegionType(candidate.type)) {
        errors.push(
          `region ${classification.regionId} has a candidate with unknown type ${String(
            candidate.type
          )}`
        );
      }
    }
  }
  return validationResult(errors);
}

/** Two classifications of identical input reproduce identical output. */
export function validateDeterministicClassification(
  first: RegionClassificationOutcome,
  second: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  if (!deepEqual(first, second)) {
    errors.push("classification outcomes differ between identical builds");
  }
  return validationResult(errors);
}

/**
 * Every confidence profile distribution stays within [0, 1] — the geometric
 * and typological components that drive classification are normalized scores.
 */
export function validateClassificationConfidenceBounds(
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  for (const classification of outcome.classifications) {
    const profile = classification.confidence;
    const bounds: Array<{ name: string; min: number; max: number }> = [
      { name: "aggregate", min: profile.aggregate.min, max: profile.aggregate.max },
      { name: "geometric", min: profile.geometric.min, max: profile.geometric.max },
      { name: "typological", min: profile.typological.min, max: profile.typological.max },
      { name: "ocr", min: profile.ocr.min, max: profile.ocr.max },
      { name: "structural", min: profile.structural.min, max: profile.structural.max },
      { name: "boundary", min: profile.boundary.min, max: profile.boundary.max },
      { name: "order", min: profile.order.min, max: profile.order.max },
    ];
    for (const b of bounds) {
      if (
        !Number.isFinite(b.min) ||
        !Number.isFinite(b.max) ||
        b.min < 0 ||
        b.max > 1
      ) {
        errors.push(
          `region ${classification.regionId} confidence ${b.name} is out of [0, 1]: [${b.min}, ${b.max}]`
        );
      }
    }
    if (
      !Number.isFinite(classification.topScore) ||
      classification.topScore < 0 ||
      classification.topScore > 1
    ) {
      errors.push(
        `region ${classification.regionId} topScore ${classification.topScore} is out of [0, 1]`
      );
    }
  }
  return validationResult(errors);
}

/** The outcome and every owned structure are deep-frozen. */
export function validateClassificationImmutable(
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  const paths: string[] = [];
  collectNonFrozenPaths(outcome, "", new Set(), paths);
  for (const path of paths) {
    errors.push(`classification output is not deep-frozen at ${path}`);
  }
  return validationResult(errors);
}

/**
 * Every REGION node of the hierarchy is classified exactly once, and no
 * classification references a region that is not a REGION node.
 */
export function validateCompleteRegionCoverage(
  hierarchy: LayoutHierarchy,
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  const regions = hierarchy.nodesAtLevel(NODE_LEVEL.REGION);
  const expected = new Set(regions.map((node) => node.id));
  const actual = new Set<string>();
  for (const classification of outcome.classifications) {
    if (!expected.has(classification.regionId)) {
      errors.push(
        `classification references unknown region ${classification.regionId}`
      );
      continue;
    }
    if (actual.has(classification.regionId)) {
      errors.push(
        `region ${classification.regionId} is classified more than once`
      );
    }
    actual.add(classification.regionId);
  }
  for (const id of [...expected].sort()) {
    if (!actual.has(id)) {
      errors.push(`region ${id} is not classified`);
    }
  }
  return validationResult(errors);
}

/**
 * Adaptive threshold validity. Every named statistic is finite and non-negative
 * and either computed from the page's own region features (sampleCount > 0) or
 * is a recorded fallback used because statistics were impossible. Every
 * decision key exists in the statistics it derives from, and the fallback list
 * matches exactly the statistics that fell back.
 */
export function validateAdaptiveThresholdValidity(
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  for (const set of outcome.thresholdSets) {
    for (const [name, sample] of Object.entries(set.statistics.stats)) {
      validateSample(name, sample, set, errors);
    }
    for (const [name, value] of Object.entries(set.decisions)) {
      const sample = set.statistics.stats[name];
      if (sample === undefined) {
        errors.push(
          `page ${set.pageIndex} decision ${name} has no backing statistic`
        );
        continue;
      }
      if (!Number.isFinite(value) || value < 0) {
        errors.push(
          `page ${set.pageIndex} decision ${name} is invalid: ${value}`
        );
      }
      if (Math.abs(sample.value - value) > CLASSIFICATION_EPSILON) {
        errors.push(
          `page ${set.pageIndex} decision ${name} (${value}) does not match its statistic (${sample.value})`
        );
      }
    }
    for (const fallback of set.fallbacks) {
      if (set.statistics.stats[fallback]?.sampleCount !== 0) {
        errors.push(
          `page ${set.pageIndex} lists ${fallback} as a fallback but it has samples`
        );
      }
    }
  }
  return validationResult(errors);
}

/**
 * Explanation consistency. Every piece of evidence cites a numeric feature
 * whose value matches the region's feature set, a threshold name that exists in
 * the page's statistics with a matching value, a valid relation and a valid
 * supporting region type.
 */
export function validateExplanationConsistency(
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  for (const classification of outcome.classifications) {
    const set = outcome.thresholdSets.find(
      (s) => s.pageIndex === classification.pageIndex
    );
    for (const evidence of classification.explanation) {
      if (!isRegionType(evidence.supports)) {
        errors.push(
          `region ${classification.regionId} evidence supports unknown type ${String(
            evidence.supports
          )}`
        );
      }
      if (
        evidence.relation !== "above" &&
        evidence.relation !== "below"
      ) {
        errors.push(
          `region ${classification.regionId} evidence has invalid relation ${String(
            evidence.relation
          )}`
        );
      }
      if (!Number.isFinite(evidence.weight) || evidence.weight < 0 || evidence.weight > 1) {
        errors.push(
          `region ${classification.regionId} evidence weight ${evidence.weight} is out of [0, 1]`
        );
      }
      const featureValue = readRegionFeature(
        classification.features,
        evidence.feature
      );
      if (Math.abs(featureValue - evidence.value) > CLASSIFICATION_EPSILON) {
        errors.push(
          `region ${classification.regionId} evidence feature ${evidence.feature} value ${evidence.value} does not match its feature set (${featureValue})`
        );
      }
      if (set === undefined) {
        errors.push(
          `region ${classification.regionId} has no threshold set for page ${classification.pageIndex}`
        );
        continue;
      }
      const sample = set.statistics.stats[evidence.thresholdName];
      if (sample === undefined) {
        errors.push(
          `region ${classification.regionId} evidence cites unknown threshold ${evidence.thresholdName}`
        );
        continue;
      }
      if (Math.abs(sample.value - evidence.threshold) > CLASSIFICATION_EPSILON) {
        errors.push(
          `region ${classification.regionId} evidence threshold ${evidence.thresholdName} value ${evidence.threshold} does not match its statistic (${sample.value})`
        );
      }
    }
  }
  return validationResult(errors);
}

/** A region-type vocabulary sanity check: the outcome only emits the vocabulary. */
export function validateRegionTypeVocabulary(
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  for (const classification of outcome.classifications) {
    if (!REGION_TYPES.includes(classification.type)) {
      errors.push(
        `region ${classification.regionId} type ${classification.type} is not in the vocabulary`
      );
    }
  }
  return validationResult(errors);
}

/**
 * Reachability — no dead vocabulary. Across every outcome supplied, every
 * region type of the vocabulary (including UNKNOWN) must actually be assigned
 * to at least one region, so each type is practically reachable and not merely
 * an unused enum value.
 */
export function validateRegionTypeReachability(
  outcomes: readonly RegionClassificationOutcome[]
): ValidationResult {
  const errors: string[] = [];
  const reached = new Set<string>();
  for (const outcome of outcomes) {
    for (const classification of outcome.classifications) {
      reached.add(classification.type);
    }
  }
  for (const type of REGION_TYPES) {
    if (!reached.has(type)) {
      errors.push(`region type ${type} is never classified`);
    }
  }
  return validationResult(errors);
}

/**
 * Deterministic candidate ranking. Every candidate list is sorted score-
 * descending, and equal scores are broken lexicographically by type — the
 * same input always yields the same best-first order.
 */
export function validateCandidateRanking(
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  for (const classification of outcome.classifications) {
    const candidates = classification.candidates;
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1];
      const cur = candidates[i];
      if (cur.score > prev.score) {
        errors.push(
          `region ${classification.regionId} candidates are not score-descending at position ${i}`
        );
      } else if (
        cur.score === prev.score &&
        cur.type <= prev.type
      ) {
        errors.push(
          `region ${classification.regionId} candidates tie ${prev.type} and ${cur.type} without lexicographic order`
        );
      }
    }
  }
  return validationResult(errors);
}

/**
 * No unnecessary fallbacks. A page with regions (regionCount > 0) has a real
 * feature distribution to derive thresholds from, so it must never fall back
 * to constants; only genuinely empty pages may record fallbacks.
 */
export function validateNoUnnecessaryFallbacks(
  outcome: RegionClassificationOutcome
): ValidationResult {
  const errors: string[] = [];
  for (const set of outcome.thresholdSets) {
    if (set.regionCount > 0 && set.fallbacks.length > 0) {
      errors.push(
        `page ${set.pageIndex} fell back to constants (${set.fallbacks.join(", ")}) despite having ${set.regionCount} regions`
      );
    }
  }
  return validationResult(errors);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function validateSample(
  name: string,
  sample: RegionStatisticSample,
  set: RegionThresholdSet,
  errors: string[]
): void {
  if (!Number.isFinite(sample.value) || sample.value < 0) {
    errors.push(`page ${set.pageIndex} statistic ${name} is invalid: ${sample.value}`);
  }
  if (!VALID_METHODS.has(sample.method)) {
    errors.push(`page ${set.pageIndex} statistic ${name} has unknown method ${sample.method}`);
  }
  if (sample.sampleCount === 0 && sample.method !== "fallback") {
    errors.push(
      `page ${set.pageIndex} statistic ${name} has no samples but method ${sample.method}`
    );
  }
  if (sample.sampleCount > 0 && sample.method === "fallback") {
    errors.push(
      `page ${set.pageIndex} statistic ${name} fell back despite having samples`
    );
  }
  if (!Number.isInteger(sample.sampleCount) || sample.sampleCount < 0) {
    errors.push(`page ${set.pageIndex} statistic ${name} has invalid sample count`);
  }
}

function collectNonFrozenPaths(
  value: unknown,
  path: string,
  seen: Set<object>,
  out: string[]
): void {
  if (value === null || typeof value !== "object") return;
  const obj = value as object;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (!Object.isFrozen(obj)) {
    out.push(path.length === 0 ? "<root>" : path);
  }
  for (const key of Object.keys(obj)) {
    const nextPath = path.length === 0 ? key : `${path}.${key}`;
    collectNonFrozenPaths(
      (obj as Record<string, unknown>)[key],
      nextPath,
      seen,
      out
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (
        !deepEqual(
          (a as Record<string, unknown>)[aKeys[i]],
          (b as Record<string, unknown>)[bKeys[i]]
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return a === b;
}
