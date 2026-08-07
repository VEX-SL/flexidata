/**
 * Confidence propagation validation — Milestone 7.
 *
 * Guards over a `PropagatedConfidence` result: confidence values within
 * [0, 1], finite values (no NaN, no Infinity), a deep-frozen output, complete
 * coverage of the hierarchy, policy correctness (parents derive exactly what
 * the active policies prescribe from their children), deterministic rebuilds,
 * and identical input yielding identical confidence. Every check returns a
 * frozen `ValidationResult` with deterministic, insertion-ordered errors.
 */
import type { ConfidenceProfile, ConfidenceComponents } from "./confidence";
import {
  COMPONENT_KEYS,
  aggregateConfidenceComponents,
  defaultCompositeScore,
} from "./confidence";
import type { ConfidenceDistribution } from "./types";
import type { LayoutHierarchy } from "./hierarchy";
import { EqualWeightPolicy, validateChildWeights } from "./confidence-policies";
import type { ConfidenceChild } from "./confidence-policies";
import type {
  PropagateConfidenceOptions,
  PropagatedConfidence,
} from "./confidence-propagation";
import { propagateConfidence } from "./confidence-propagation";
import type { ValidationResult } from "./validation";
import { validationResult } from "./validation";

function distributionsOf(profile: ConfidenceProfile): readonly {
  key: string;
  distribution: ConfidenceDistribution;
}[] {
  return [
    ...COMPONENT_KEYS.map((key) => ({
      key,
      distribution: profile[key],
    })),
    { key: "aggregate", distribution: profile.aggregate },
  ];
}

function distributionsEqual(
  a: ConfidenceDistribution,
  b: ConfidenceDistribution
): boolean {
  return (
    a.count === b.count &&
    a.mean === b.mean &&
    a.variance === b.variance &&
    a.min === b.min &&
    a.max === b.max
  );
}

/** Deep value equality of two confidence profiles (exact bitwise fields). */
export function confidenceProfilesEqual(
  a: ConfidenceProfile,
  b: ConfidenceProfile
): boolean {
  for (const key of COMPONENT_KEYS) {
    if (!distributionsEqual(a[key], b[key])) return false;
  }
  return distributionsEqual(a.aggregate, b.aggregate);
}

function sampleComponents(profile: ConfidenceProfile): ConfidenceComponents {
  return {
    ocr: profile.ocr.mean,
    geometric: profile.geometric.mean,
    structural: profile.structural.mean,
    boundary: profile.boundary.mean,
    typological: profile.typological.mean,
    order: profile.order.mean,
  };
}

/**
 * Every propagated value (mean, min, max of every component and of the
 * aggregate) must lie within [0, 1]. Flags values above 1, below 0 and NaN.
 */
export function validateConfidenceBounds(
  hierarchy: LayoutHierarchy,
  propagated: PropagatedConfidence
): ValidationResult {
  const errors: string[] = [];
  const parts = ["mean", "min", "max"] as const;
  for (const node of hierarchy.nodes()) {
    const profile = propagated.get(node.id);
    if (profile === undefined) continue;
    for (const entry of distributionsOf(profile)) {
      for (const part of parts) {
        const value = entry.distribution[part];
        if (!(value >= 0 && value <= 1)) {
          errors.push(
            `node ${node.id} ${entry.key}.${part} ${value} is outside the confidence range [0, 1]`
          );
        }
      }
    }
  }
  return validationResult(errors);
}

/**
 * Every numeric field of every propagated profile must be finite: no NaN, no
 * positive or negative Infinity.
 */
export function validateFiniteConfidenceValues(
  hierarchy: LayoutHierarchy,
  propagated: PropagatedConfidence
): ValidationResult {
  const errors: string[] = [];
  const parts = ["count", "mean", "variance", "min", "max"] as const;
  for (const node of hierarchy.nodes()) {
    const profile = propagated.get(node.id);
    if (profile === undefined) continue;
    for (const entry of distributionsOf(profile)) {
      for (const part of parts) {
        const value = entry.distribution[part];
        if (!Number.isFinite(value)) {
          errors.push(
            `node ${node.id} ${entry.key}.${part} must be finite, got ${value}`
          );
        }
      }
    }
  }
  return validationResult(errors);
}

/**
 * The propagation output must be immutable: the container instance, every
 * propagated profile and every distribution must be frozen.
 */
export function validateFrozenConfidenceOutput(
  hierarchy: LayoutHierarchy,
  propagated: PropagatedConfidence
): ValidationResult {
  const errors: string[] = [];
  if (!Object.isFrozen(propagated)) {
    errors.push("propagated confidence container is not frozen");
  }
  for (const node of hierarchy.nodes()) {
    const profile = propagated.get(node.id);
    if (profile === undefined) continue;
    if (!Object.isFrozen(profile)) {
      errors.push(`node ${node.id} profile is not frozen`);
    }
    for (const entry of distributionsOf(profile)) {
      if (!Object.isFrozen(entry.distribution)) {
        errors.push(`node ${node.id} ${entry.key} distribution is not frozen`);
      }
    }
  }
  return validationResult(errors);
}

/**
 * Every hierarchy node must have a propagated profile, and the propagation
 * must not introduce ids outside the hierarchy (a full bijection).
 */
export function validateCompleteConfidenceCoverage(
  hierarchy: LayoutHierarchy,
  propagated: PropagatedConfidence
): ValidationResult {
  const errors: string[] = [];
  for (const node of hierarchy.nodes()) {
    if (!propagated.has(node.id)) {
      errors.push(`node ${node.id} has no propagated confidence profile`);
    }
  }
  for (const id of propagated.ids()) {
    if (!hierarchy.has(id)) {
      errors.push(`propagated profile for unknown node ${id}`);
    }
  }
  return validationResult(errors);
}

/**
 * Parents must carry exactly what the active policies prescribe: for every
 * non-leaf node the propagated components equal the policy-weighted
 * aggregation of the children's propagated components and the composite is the
 * composite policy over those aggregated components. Leaves must keep their
 * own profile (propagation never invents confidence).
 */
export function validateConfidencePolicyCorrectness(
  hierarchy: LayoutHierarchy,
  propagated: PropagatedConfidence,
  options: PropagateConfidenceOptions = {}
): ValidationResult {
  const weightPolicy = options.weightPolicy ?? new EqualWeightPolicy();
  const compositePolicy = options.compositePolicy ?? defaultCompositeScore;
  const errors: string[] = [];

  for (const node of hierarchy.nodes()) {
    const profile = propagated.get(node.id);
    if (profile === undefined) continue;
    const children = hierarchy.childrenOf(node.id);

    if (children.length === 0) {
      if (!confidenceProfilesEqual(profile, node.confidence)) {
        errors.push(
          `leaf node ${node.id} propagated profile differs from its own confidence`
        );
      }
      continue;
    }

    const childProfiles = children.map((child) => propagated.get(child.id));
    if (childProfiles.some((childProfile) => childProfile === undefined)) {
      errors.push(
        `node ${node.id} references children without propagated profiles`
      );
      continue;
    }
    const profiles = childProfiles as ConfidenceProfile[];
    const views: ConfidenceChild[] = children.map((child, i) => ({
      id: child.id,
      bbox: child.bbox,
      normalizedBBox: child.normalizedBBox,
      childCount: child.children.length,
      profile: profiles[i],
    }));

    let weights: readonly number[];
    try {
      weights = weightPolicy.weights(views);
      validateChildWeights(weights, children.length);
    } catch (error) {
      errors.push(
        `node ${node.id} weight policy rejected children: ${
          (error as Error).message
        }`
      );
      continue;
    }

    const samples = profiles.map((childProfile) =>
      sampleComponents(childProfile)
    );
    const expected = aggregateConfidenceComponents(samples, weights);
    for (const key of COMPONENT_KEYS) {
      if (profile[key].mean !== expected[key]) {
        errors.push(
          `node ${node.id} ${key}.mean ${profile[key].mean} does not match policy aggregation ${expected[key]}`
        );
      }
    }
    if (profile.ocr.count !== children.length) {
      errors.push(
        `node ${node.id} propagated distribution count ${profile.ocr.count} does not match child count ${children.length}`
      );
    }
    const composite = compositePolicy(expected);
    if (profile.aggregate.mean !== composite) {
      errors.push(
        `node ${node.id} aggregate.mean ${profile.aggregate.mean} does not match composite ${composite} of propagated components`
      );
    }
  }
  return validationResult(errors);
}

/**
 * Re-running propagation over the same hierarchy with the same options must
 * reproduce every propagated profile exactly.
 */
export function validatePropagationDeterminism(
  hierarchy: LayoutHierarchy,
  propagated: PropagatedConfidence,
  options: PropagateConfidenceOptions = {}
): ValidationResult {
  const errors: string[] = [];
  const rerun = propagateConfidence(hierarchy, options);
  for (const node of hierarchy.nodes()) {
    const first = propagated.get(node.id);
    const second = rerun.get(node.id);
    if (first === undefined || second === undefined) {
      errors.push(`node ${node.id} missing a propagated profile in a rebuild`);
      continue;
    }
    if (!confidenceProfilesEqual(first, second)) {
      errors.push(
        `node ${node.id} propagated confidence is not deterministic across rebuilds`
      );
    }
  }
  return validationResult(errors);
}

/**
 * Two propagation results over identical inputs must carry identical
 * confidence. Compares the full id set and every profile.
 */
export function compareConfidencePropagations(
  a: PropagatedConfidence,
  b: PropagatedConfidence
): ValidationResult {
  const errors: string[] = [];
  if (a.size !== b.size) {
    errors.push(`propagation sizes differ: ${a.size} vs ${b.size}`);
  }
  for (const id of a.ids()) {
    const other = b.get(id);
    if (other === undefined) {
      errors.push(`node ${id} missing from the second propagation`);
      continue;
    }
    if (!confidenceProfilesEqual(a.get(id)!, other)) {
      errors.push(`node ${id} confidence differs across propagations`);
    }
  }
  return validationResult(errors);
}
