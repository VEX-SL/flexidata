/**
 * Confidence propagation — Milestone 7.
 *
 * Deterministic, immutable, bottom-up propagation of the six Milestone 2
 * confidence components across the Milestone 4 hierarchy:
 *
 *     Word → Line → Block → Region → Page → Document
 *
 * Each component propagates independently from the children's profiles, and
 * the composite score is computed only AFTER propagation — never by averaging
 * child composites. Parents derive confidence exclusively from their children;
 * nodes without children (leaves) keep their own profile. Propagation never
 * invents confidence.
 *
 * The child-weight policy (default `EqualWeightPolicy`) decides how much each
 * child contributes and the composite policy (default `defaultCompositeScore`)
 * collapses the propagated components. Both are injectable without touching
 * this engine. The hierarchy and the OCR data are never modified; the output
 * is a deep-frozen `PropagatedConfidence` container mapping every hierarchy
 * node id to its propagated profile.
 */
import type {
  ConfidenceComponents,
  ConfidenceProfile,
  CompositeScorePolicy,
} from "./confidence";
import {
  COMPONENT_KEYS,
  aggregateConfidenceComponents,
  defaultCompositeScore,
} from "./confidence";
import type { ConfidenceDistribution } from "./types";
import type { HierarchyNode, LayoutHierarchy } from "./hierarchy";
import type { ChildWeightPolicy, ConfidenceChild } from "./confidence-policies";
import {
  EqualWeightPolicy,
  validateChildWeights,
} from "./confidence-policies";

/** Options that control one propagation pass. */
export interface PropagateConfidenceOptions {
  /** Child-weight policy (default: equal weights). */
  readonly weightPolicy?: ChildWeightPolicy;
  /** Composite policy applied to propagated components (default: equal weights). */
  readonly compositePolicy?: CompositeScorePolicy;
}

/**
 * Weighted summary of a set of values: `mean` is the policy-weighted mean and
 * `variance` the policy-weighted variance; `count` is the number of values and
 * `min`/`max` their range. With equal weights this reduces exactly to the
 * Milestone 1 `createConfidenceDistribution` formulas.
 */
function weightedDistribution(
  values: readonly number[],
  weights: readonly number[]
): ConfidenceDistribution {
  let mean = 0;
  for (let i = 0; i < values.length; i++) {
    mean += values[i] * weights[i];
  }
  let variance = 0;
  let min = values[0];
  let max = values[0];
  for (let i = 0; i < values.length; i++) {
    const delta = values[i] - mean;
    variance += delta * delta * weights[i];
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  return Object.freeze({
    count: values.length,
    mean,
    variance,
    min,
    max,
  });
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
 * The propagated confidence of a non-leaf node: per-component aggregation of
 * the children's propagated profiles under the active policies, with the
 * composite computed from the aggregated components (never from child
 * composites).
 */
function propagateParent(
  children: readonly HierarchyNode[],
  profiles: readonly ConfidenceProfile[],
  weightPolicy: ChildWeightPolicy,
  compositePolicy: CompositeScorePolicy
): ConfidenceProfile {
  const views: ConfidenceChild[] = children.map((child, i) => ({
    id: child.id,
    bbox: child.bbox,
    normalizedBBox: child.normalizedBBox,
    childCount: child.children.length,
    profile: profiles[i],
  }));
  const weights = weightPolicy.weights(views);
  validateChildWeights(weights, children.length);

  const samples = profiles.map((profile) => sampleComponents(profile));
  const propagated = aggregateConfidenceComponents(samples, weights);

  const byKey = {} as Record<keyof ConfidenceComponents, ConfidenceDistribution>;
  for (const key of COMPONENT_KEYS) {
    byKey[key] = weightedDistribution(
      samples.map((sample) => sample[key]),
      weights
    );
  }
  const composite = compositePolicy(propagated);
  return Object.freeze({
    ...byKey,
    aggregate: Object.freeze({
      count: 1,
      mean: composite,
      variance: 0,
      min: composite,
      max: composite,
    }),
  });
}

/**
 * Immutable result of a propagation pass: a deep-frozen map from every
 * hierarchy node id to its propagated confidence profile. Query views are
 * frozen copies and iteration order is the deterministic reverse pre-order in
 * which the profiles were built.
 */
export class PropagatedConfidence {
  private readonly source: LayoutHierarchy;
  private readonly byId: ReadonlyMap<string, ConfidenceProfile>;

  constructor(
    hierarchy: LayoutHierarchy,
    byId: ReadonlyMap<string, ConfidenceProfile>
  ) {
    for (const [id, profile] of byId) {
      if (!Object.isFrozen(profile)) {
        throw new Error(
          `propagated confidence profile for ${id} must be frozen`
        );
      }
    }
    this.source = hierarchy;
    this.byId = Object.freeze(new Map(byId));
    Object.freeze(this);
  }

  /** The hierarchy this propagation was computed over. */
  get hierarchy(): LayoutHierarchy {
    return this.source;
  }

  /** Number of propagated nodes. */
  get size(): number {
    return this.byId.size;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Propagated profile for a node, or undefined for unknown ids. */
  get(id: string): ConfidenceProfile | undefined {
    return this.byId.get(id);
  }

  /** All propagated node ids, in deterministic build order. */
  ids(): readonly string[] {
    return Object.freeze([...this.byId.keys()]);
  }
}

/**
 * Propagate confidence across an immutable hierarchy. Walks the tree
 * bottom-up (children always before their parent), so every parent aggregates
 * the already-propagated profiles of its children. Leaves keep their own
 * profile. The hierarchy is never modified.
 */
export function propagateConfidence(
  hierarchy: LayoutHierarchy,
  options: PropagateConfidenceOptions = {}
): PropagatedConfidence {
  const weightPolicy = options.weightPolicy ?? new EqualWeightPolicy();
  const compositePolicy = options.compositePolicy ?? defaultCompositeScore;

  const byId = new Map<string, ConfidenceProfile>();
  const nodes = hierarchy.nodes();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const children = hierarchy.childrenOf(node.id);
    const profile =
      children.length === 0
        ? node.confidence
        : propagateParent(
            children,
            children.map((child) => byId.get(child.id)!),
            weightPolicy,
            compositePolicy
          );
    byId.set(node.id, profile);
  }
  return new PropagatedConfidence(hierarchy, byId);
}
