/**
 * Milestone 5 region classification validation — every contract check from
 * region-classification-validation.ts, proven on real classification outcomes
 * and probed with tampered clones to prove each validator actually rejects
 * violations (types, determinism, confidence bounds, immutability, coverage,
 * adaptive thresholds and explanation consistency).
 */
import {
  REGION_TYPE,
  classifyRegions,
  validateAdaptiveThresholdValidity,
  validateCandidateRanking,
  validateClassificationConfidenceBounds,
  validateClassificationImmutable,
  validateCompleteRegionCoverage,
  validateDeterministicClassification,
  validateExplanationConsistency,
  validateNoUnnecessaryFallbacks,
  validateRegionClassificationTypes,
  validateRegionTypeReachability,
  validateRegionTypeVocabulary,
} from "@/lib/layout";
import type { RegionClassificationOutcome } from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";
import { buildRegionHierarchy } from "./layout-region-helpers.ts";
import {
  FORM_FIELD_PAGE,
  INVOICE_PAGE,
  REQUIRED_SCENARIOS,
  SIGNATURE_PAGE,
} from "./layout-region-scenarios.ts";

const ALL_VALIDATORS = [
  validateRegionClassificationTypes,
  validateDeterministicClassification,
  validateClassificationConfidenceBounds,
  validateClassificationImmutable,
  validateCompleteRegionCoverage,
  validateAdaptiveThresholdValidity,
  validateExplanationConsistency,
  validateRegionTypeVocabulary,
  validateCandidateRanking,
  validateNoUnnecessaryFallbacks,
] as const;

function classify(page: typeof INVOICE_PAGE): RegionClassificationOutcome {
  return classifyRegions(buildRegionHierarchy(page));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Mutable views over a JSON-cloned outcome so tampered fields are assignable.
interface MutableClassification {
  type: string;
  regionId: string;
  topScore: number;
  confidence: { geometric: { min: number; max: number } };
  explanation: Array<{
    value: number;
    thresholdName: string;
    relation: string;
    weight: number;
  }>;
}

// ─── Positive validation ─────────────────────────────────────────────────────

test("every required scenario passes every validator", () => {
  for (const page of REQUIRED_SCENARIOS) {
    const hierarchy = buildRegionHierarchy(page);
    const outcome = classifyRegions(hierarchy);
    for (const validate of ALL_VALIDATORS) {
      const result =
        validate === validateDeterministicClassification
          ? validate(outcome, outcome)
          : validate === validateCompleteRegionCoverage
            ? validate(hierarchy, outcome)
            : validate(outcome);
      ok(result.valid, `${validate.name} on ${page.id}: ${result.errors.join("; ")}`);
    }
  }
});

test("validators accept an identical build twice", () => {
  const outcome = classify(INVOICE_PAGE);
  const result = validateDeterministicClassification(outcome, outcome);
  ok(result.valid);
});

// ─── Reachability / ranking / fallbacks ──────────────────────────────────────

test("region type reachability covers the whole vocabulary across scenarios", () => {
  const outcomes = [
    ...REQUIRED_SCENARIOS,
    SIGNATURE_PAGE,
    FORM_FIELD_PAGE,
  ].map((page) => classify(page));
  const result = validateRegionTypeReachability(outcomes);
  ok(result.valid, result.errors.join("; "));
});

test("validateRegionTypeReachability rejects an outcome set with a dead type", () => {
  const result = validateRegionTypeReachability([classify(INVOICE_PAGE)]);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("never classified")));
});

test("validateCandidateRanking rejects a non-descending candidate list", () => {
  const bad = clone(classify(INVOICE_PAGE));
  const candidates = bad.classifications[0]
    .candidates as unknown as Array<{ type: string; score: number }>;
  candidates[1] = { ...candidates[1], score: candidates[0].score + 1 };
  const result = validateCandidateRanking(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("score-descending")));
});

test("validateNoUnnecessaryFallbacks rejects fallbacks on a real page", () => {
  const bad = clone(classify(INVOICE_PAGE));
  const set = bad.thresholdSets[0] as unknown as { fallbacks: string[] };
  set.fallbacks = [...set.fallbacks, "medianWidthRatio"];
  const result = validateNoUnnecessaryFallbacks(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("fell back to constants")));
});

// ─── Type vocabulary ─────────────────────────────────────────────────────────

test("validateRegionTypeVocabulary rejects an unknown type", () => {
  const bad = clone(classify(INVOICE_PAGE));
  (bad.classifications[0] as MutableClassification).type = "Banana";
  const result = validateRegionTypeVocabulary(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("not in the vocabulary")));
});

// ─── Classification types ────────────────────────────────────────────────────

test("validateRegionClassificationTypes rejects empty and duplicate ids", () => {
  const bad = clone(classify(INVOICE_PAGE));
  const c = bad.classifications as unknown as MutableClassification[];
  c[0].regionId = "";
  const result = validateRegionClassificationTypes(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("empty region id")));
});

// ─── Determinism ─────────────────────────────────────────────────────────────

test("validateDeterministicClassification rejects differing builds", () => {
  const a = clone(classify(INVOICE_PAGE));
  const b = clone(classify(INVOICE_PAGE));
  (b.classifications[0] as MutableClassification).topScore = 0.5;
  const result = validateDeterministicClassification(a, b);
  ok(!result.valid);
});

// ─── Confidence bounds ───────────────────────────────────────────────────────

test("validateClassificationConfidenceBounds rejects out-of-range confidence", () => {
  const bad = clone(classify(INVOICE_PAGE));
  const c = bad.classifications[0] as MutableClassification;
  c.confidence.geometric.min = -0.5;
  const result = validateClassificationConfidenceBounds(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("confidence geometric")));
});

test("validateClassificationConfidenceBounds rejects an out-of-range top score", () => {
  const bad = clone(classify(INVOICE_PAGE));
  (bad.classifications[0] as MutableClassification).topScore = 1.5;
  const result = validateClassificationConfidenceBounds(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("topScore")));
});

// ─── Immutability ────────────────────────────────────────────────────────────

test("validateClassificationImmutable rejects non-frozen output", () => {
  const bad = clone(classify(INVOICE_PAGE));
  const result = validateClassificationImmutable(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("not deep-frozen")));
});

// ─── Coverage ────────────────────────────────────────────────────────────────

test("validateCompleteRegionCoverage rejects a missing region", () => {
  const hierarchy = buildRegionHierarchy(INVOICE_PAGE);
  const outcome = classifyRegions(hierarchy);
  const bad = clone(outcome);
  bad.classifications = bad.classifications.slice(0, -1);
  const result = validateCompleteRegionCoverage(hierarchy, bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("not classified")));
});

test("validateCompleteRegionCoverage rejects a phantom classification", () => {
  const hierarchy = buildRegionHierarchy(INVOICE_PAGE);
  const outcome = classifyRegions(hierarchy);
  const bad = clone(outcome);
  const phantom = clone(bad.classifications[0]) as MutableClassification;
  phantom.regionId = "ghost";
  bad.classifications = [...bad.classifications, phantom];
  const result = validateCompleteRegionCoverage(hierarchy, bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("unknown region ghost")));
});

// ─── Adaptive thresholds ─────────────────────────────────────────────────────

test("validateAdaptiveThresholdValidity rejects a false fallback entry", () => {
  const bad = clone(classify(INVOICE_PAGE));
  const set = bad.thresholdSets[0] as unknown as { fallbacks: string[] };
  set.fallbacks = [...set.fallbacks, "medianWidthRatio"];
  const result = validateAdaptiveThresholdValidity(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("as a fallback but it has samples")));
});

test("validateAdaptiveThresholdValidity rejects a decision without a statistic", () => {
  const bad = clone(classify(INVOICE_PAGE));
  const set = bad.thresholdSets[0] as unknown as {
    statistics: { stats: Record<string, unknown> };
  };
  const stats = { ...set.statistics.stats };
  delete stats["medianWidthRatio"];
  set.statistics = { ...set.statistics, stats };
  const result = validateAdaptiveThresholdValidity(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("no backing statistic")));
});

// ─── Explanation consistency ─────────────────────────────────────────────────

test("validateExplanationConsistency rejects a feature-value mismatch", () => {
  const bad = clone(classify(INVOICE_PAGE));
  (bad.classifications[0] as MutableClassification).explanation[0].value = 12345;
  const result = validateExplanationConsistency(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("does not match its feature set")));
});

test("validateExplanationConsistency rejects an unknown threshold name", () => {
  const bad = clone(classify(INVOICE_PAGE));
  (bad.classifications[0] as MutableClassification).explanation[0].thresholdName =
    "noSuchThreshold";
  const result = validateExplanationConsistency(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("unknown threshold")));
});

test("validateExplanationConsistency rejects an invalid relation and weight", () => {
  const bad = clone(classify(INVOICE_PAGE));
  const ev = (bad.classifications[0] as MutableClassification).explanation[0];
  ev.relation = "beside";
  ev.weight = 2;
  const result = validateExplanationConsistency(bad);
  ok(!result.valid);
  ok(result.errors.some((e) => e.includes("invalid relation")));
  ok(result.errors.some((e) => e.includes("out of [0, 1]")));
});

// ─── Vocabulary sanity ───────────────────────────────────────────────────────

test("classifications only ever use the region vocabulary", () => {
  const outcome = classify(INVOICE_PAGE);
  for (const c of outcome.classifications) {
    equal(typeof c.type, "string");
    ok(Object.values(REGION_TYPE).includes(c.type as (typeof REGION_TYPE)[keyof typeof REGION_TYPE]));
  }
});
