/**
 * Confidence propagation policies.
 *
 * Milestone 7 aggregation policies: every parent derives its confidence from
 * its children, and the child-weight policy decides how much each child
 * contributes. The shipped policies are deterministic and pure: equal weights
 * by default, area weighting and child-count weighting, with a documented
 * equal-weight fallback when a weighted policy has nothing to weight against
 * (all-zero areas or all-zero child counts).
 *
 * The `ChildWeightPolicy` seam is the extension point: any policy can be
 * injected into `propagateConfidence` without touching the propagation engine,
 * because the engine validates every policy output before use.
 */
import type { BBox } from "@/lib/pipeline/types";
import type { ConfidenceProfile } from "./confidence";
import type { CompositeScorePolicy } from "./confidence";

export type { CompositeScorePolicy };

/**
 * Read-only view of a child handed to a child-weight policy. Carries the
 * child's geometry, its own child count and its propagated profile so future
 * policies can weight by any of these without changing the engine.
 */
export interface ConfidenceChild {
  readonly id: string;
  /** Visual box in page coordinates. */
  readonly bbox: BBox;
  /** The bbox mapped onto the unit square of the build's page size. */
  readonly normalizedBBox: BBox;
  /** Number of children the child itself has (0 for leaves). */
  readonly childCount: number;
  /** The child's propagated confidence profile. */
  readonly profile: ConfidenceProfile;
}

/**
 * Policy that assigns one weight per child of a parent. Output must be
 * finite, non-negative and sum to 1; the propagation engine validates it
 * before use, so a misbehaving policy fails loudly instead of corrupting
 * confidence values.
 */
export interface ChildWeightPolicy {
  /** Stable diagnostic name. */
  readonly name: string;
  /** Deterministic weights over the given children; empty for no children. */
  weights(children: readonly ConfidenceChild[]): readonly number[];
}

/**
 * Validate a candidate child-weight vector: count must match, every weight
 * must be finite and non-negative, and the weights must sum to 1 within
 * floating-point tolerance. An empty vector over zero children is trivially
 * valid (no children to weight). Throws a RangeError on any violation.
 */
export function validateChildWeights(
  weights: readonly number[],
  childCount: number
): void {
  if (weights.length !== childCount) {
    throw new RangeError(
      `child weight count (${weights.length}) must match child count (${childCount})`
    );
  }
  if (childCount === 0) return;
  let sum = 0;
  for (const weight of weights) {
    if (!Number.isFinite(weight)) {
      throw new RangeError(`child weight must be finite, got ${weight}`);
    }
    if (weight < 0) {
      throw new RangeError(`child weight must be non-negative, got ${weight}`);
    }
    sum += weight;
  }
  if (Math.abs(sum - 1) > 1e-9) {
    throw new RangeError(`child weights must sum to 1, got ${sum}`);
  }
}

/**
 * Every child contributes the same weight (1/N). The default policy; the
 * propagation engine falls back to it when no policy is supplied.
 */
export class EqualWeightPolicy implements ChildWeightPolicy {
  readonly name: string = "equal";

  weights(children: readonly ConfidenceChild[]): readonly number[] {
    if (children.length === 0) return Object.freeze([]);
    return Object.freeze(children.map(() => 1 / children.length));
  }
}

/**
 * Each child's weight is proportional to the area of its bbox. Children with
 * zero area contribute nothing; when every child has zero area the policy
 * falls back to equal weights so propagation stays well-defined.
 */
export class AreaWeightedPolicy implements ChildWeightPolicy {
  readonly name: string = "area";

  weights(children: readonly ConfidenceChild[]): readonly number[] {
    if (children.length === 0) return Object.freeze([]);
    const areas = children.map(
      (child) =>
        Math.max(0, child.bbox.width) * Math.max(0, child.bbox.height)
    );
    const total = areas.reduce((acc, area) => acc + area, 0);
    if (total <= 0) return new EqualWeightPolicy().weights(children);
    return Object.freeze(areas.map((area) => area / total));
  }
}

/**
 * Each child's weight is proportional to the number of children it has itself.
 * A child that spans more content counts for more. When every child is a leaf
 * (all-zero counts) the policy falls back to equal weights.
 */
export class ChildCountPolicy implements ChildWeightPolicy {
  readonly name: string = "child-count";

  weights(children: readonly ConfidenceChild[]): readonly number[] {
    if (children.length === 0) return Object.freeze([]);
    const counts = children.map((child) => child.childCount);
    const total = counts.reduce((acc, count) => acc + count, 0);
    if (total <= 0) return new EqualWeightPolicy().weights(children);
    return Object.freeze(counts.map((count) => count / total));
  }
}
