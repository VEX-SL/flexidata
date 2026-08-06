/**
 * Confidence propagation structures.
 *
 * Milestone 2 introduces the six component confidence signals defined by the
 * architecture — OCR, geometric, structural, boundary, typological and order —
 * plus deterministic aggregation utilities. Everything here is pure, frozen
 * and deterministic: no ML, no calibration, no probabilistic inference.
 *
 * The component-aware model is composed with, never bolted onto, the Milestone 1
 * `ConfidenceDistribution`: each component is summarized as its own
 * `ConfidenceDistribution` (see `ConfidenceProfile`), and the overall signal is
 * the composite of the component scores under the active
 * `CompositeScorePolicy`. The policy is injectable and the shipped default is
 * explicitly temporary — the architecture's canonical algorithm swaps in later
 * without any public API change.
 */
import { createConfidenceDistribution } from "./models";
import type { ConfidenceDistribution } from "./types";

/** The six component confidence signals carried by a layout element. */
export interface ConfidenceComponents {
  /** Confidence from the OCR engine on the underlying tokens. */
  readonly ocr: number;
  /** Confidence from geometric placement/shape reasoning. */
  readonly geometric: number;
  /** Confidence from structural/hierarchical reasoning. */
  readonly structural: number;
  /** Confidence from boundary/edge reasoning. */
  readonly boundary: number;
  /** Confidence from role/typology reasoning. */
  readonly typological: number;
  /** Confidence from reading-order reasoning. */
  readonly order: number;
}

const ZERO_COMPONENTS: ConfidenceComponents = Object.freeze({
  ocr: 0,
  geometric: 0,
  structural: 0,
  boundary: 0,
  typological: 0,
  order: 0,
});

/** The six component keys in vocabulary order (deterministic iteration). */
export const COMPONENT_KEYS = [
  "ocr",
  "geometric",
  "structural",
  "boundary",
  "typological",
  "order",
] as const;

type ComponentKey = (typeof COMPONENT_KEYS)[number];

/**
 * Equal component weights for the composite score. Deterministic default that
 * treats every signal alike until the architecture defines its weights.
 */
export const DEFAULT_COMPONENT_WEIGHTS: ConfidenceComponents = Object.freeze({
  ocr: 1 / 6,
  geometric: 1 / 6,
  structural: 1 / 6,
  boundary: 1 / 6,
  typological: 1 / 6,
  order: 1 / 6,
});

function assertFinite(key: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${key} confidence must be finite, got ${value}`);
  }
}

function resolveComponentWeights(
  weights?: ConfidenceComponents
): ConfidenceComponents {
  const resolved =
    weights === undefined
      ? DEFAULT_COMPONENT_WEIGHTS
      : createConfidenceComponents(weights);
  let sum = 0;
  for (const key of COMPONENT_KEYS) {
    sum += resolved[key];
  }
  if (Math.abs(sum - 1) > 1e-9) {
    throw new RangeError(`confidence weights must sum to 1, got ${sum}`);
  }
  return resolved;
}

/**
 * Create an immutable component set. Omitted signals default to zero (neutral
 * until measured). Rejects non-finite values.
 */
export function createConfidenceComponents(
  values?: Partial<ConfidenceComponents>
): ConfidenceComponents {
  const out: Record<ComponentKey, number> = {
    ocr: ZERO_COMPONENTS.ocr,
    geometric: ZERO_COMPONENTS.geometric,
    structural: ZERO_COMPONENTS.structural,
    boundary: ZERO_COMPONENTS.boundary,
    typological: ZERO_COMPONENTS.typological,
    order: ZERO_COMPONENTS.order,
  };
  for (const key of COMPONENT_KEYS) {
    const value = values?.[key];
    if (value !== undefined) {
      assertFinite(key, value);
      out[key] = value;
    }
  }
  return Object.freeze(out as ConfidenceComponents);
}

/**
 * Policy that collapses one element's six component signals into a single
 * composite score. This is the seam for the eventual propagation algorithm:
 * the architecture has not yet fixed the canonical definition, so callers may
 * swap the policy at the aggregation point (`createConfidenceProfile`) without
 * changing any public API.
 */
export type CompositeScorePolicy = (
  components: ConfidenceComponents,
  weights?: ConfidenceComponents
) => number;

/**
 * Default composite policy: the weighted mean of the components with equal
 * weights, or caller-provided weights (partial weight sets fill omitted
 * signals with zero). TEMPORARY — a deterministic stand-in until the
 * architecture defines the canonical algorithm. Not authoritative.
 */
export const defaultCompositeScore: CompositeScorePolicy = function (
  components,
  weights
): number {
  const resolved = resolveComponentWeights(weights);
  let score = 0;
  for (const key of COMPONENT_KEYS) {
    assertFinite(key, components[key]);
    score += components[key] * resolved[key];
  }
  return score;
};

function resolveSampleWeights(
  weights: readonly number[] | undefined,
  sampleCount: number
): readonly number[] | undefined {
  if (weights === undefined) return undefined;
  if (weights.length !== sampleCount) {
    throw new RangeError(
      `sample weight count (${weights.length}) must match sample count (${sampleCount})`
    );
  }
  let sum = 0;
  for (const w of weights) {
    if (!Number.isFinite(w)) {
      throw new RangeError(`sample weight must be finite, got ${w}`);
    }
    sum += w;
  }
  if (Math.abs(sum - 1) > 1e-9) {
    throw new RangeError(`sample weights must sum to 1, got ${sum}`);
  }
  return weights;
}

/**
 * Deterministic child-to-parent propagation: per-component weighted mean over
 * a set of samples (e.g. the children of a node). Sample weights default to
 * equal; the output is an immutable component set. Empty samples yield a
 * neutral zero set, never NaN.
 */
export function aggregateConfidenceComponents(
  samples: readonly ConfidenceComponents[],
  weights?: readonly number[]
): ConfidenceComponents {
  const resolved = resolveSampleWeights(weights, samples.length);
  if (samples.length === 0) return createConfidenceComponents();
  const out: Record<ComponentKey, number> = {
    ocr: ZERO_COMPONENTS.ocr,
    geometric: ZERO_COMPONENTS.geometric,
    structural: ZERO_COMPONENTS.structural,
    boundary: ZERO_COMPONENTS.boundary,
    typological: ZERO_COMPONENTS.typological,
    order: ZERO_COMPONENTS.order,
  };
  for (const key of COMPONENT_KEYS) {
    let acc = 0;
    for (let i = 0; i < samples.length; i++) {
      assertFinite(key, samples[i][key]);
      acc += samples[i][key] * (resolved ? resolved[i] : 1 / samples.length);
    }
    out[key] = acc;
  }
  return Object.freeze(out as ConfidenceComponents);
}

/**
 * Per-component summary of a set of samples. Each component is summarized as a
 * Milestone 1 `ConfidenceDistribution`; `aggregate` is the distribution of the
 * active composite policy over the samples. Empty samples yield neutral zero
 * distributions.
 */
export interface ConfidenceProfile {
  readonly ocr: ConfidenceDistribution;
  readonly geometric: ConfidenceDistribution;
  readonly structural: ConfidenceDistribution;
  readonly boundary: ConfidenceDistribution;
  readonly typological: ConfidenceDistribution;
  readonly order: ConfidenceDistribution;
  /** Distribution of the composite policy over the samples. */
  readonly aggregate: ConfidenceDistribution;
}

/**
 * Build an immutable confidence profile over a set of component samples. The
 * composite policy is injectable and defaults to the temporary equal-weight
 * policy; it is NOT the canonical algorithm.
 */
export function createConfidenceProfile(
  samples: readonly ConfidenceComponents[],
  policy: CompositeScorePolicy = defaultCompositeScore
): ConfidenceProfile {
  const byKey = {} as Record<ComponentKey, number[]>;
  for (const key of COMPONENT_KEYS) {
    const values: number[] = [];
    for (const sample of samples) {
      assertFinite(key, sample[key]);
      values.push(sample[key]);
    }
    byKey[key] = values;
  }
  return Object.freeze({
    ocr: createConfidenceDistribution(byKey.ocr),
    geometric: createConfidenceDistribution(byKey.geometric),
    structural: createConfidenceDistribution(byKey.structural),
    boundary: createConfidenceDistribution(byKey.boundary),
    typological: createConfidenceDistribution(byKey.typological),
    order: createConfidenceDistribution(byKey.order),
    aggregate: createConfidenceDistribution(samples.map((s) => policy(s))),
  });
}
