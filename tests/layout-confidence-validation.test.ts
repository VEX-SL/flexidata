/**
 * Milestone 7 validation tests — the confidence propagation guards: bounds,
 * finite values, frozen output, full hierarchy coverage, policy correctness,
 * deterministic rebuilds and identical-input comparisons, including the
 * failure paths of every validator.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  NODE_LEVEL,
  AreaWeightedPolicy,
  ChildCountPolicy,
  LayoutHierarchy,
  PropagatedConfidence,
  compareConfidencePropagations,
  createConfidenceComponents,
  createConfidenceProfile,
  createHierarchyNode,
  propagateConfidence,
  validateChildWeights,
  validateCompleteConfidenceCoverage,
  validateConfidenceBounds,
  validateConfidencePolicyCorrectness,
  validateFiniteConfidenceValues,
  validateFrozenConfidenceOutput,
  validatePropagationDeterminism,
} from "@/lib/layout";
import type {
  CompositeScorePolicy,
  ConfidenceComponents,
  ConfidenceProfile,
  HierarchyLevel,
} from "@/lib/layout";
import type { BBox } from "@/lib/pipeline/types";
import { equal, includes, ok, test } from "./harness.ts";

function comps(values: Partial<ConfidenceComponents> = {}): ConfidenceComponents {
  return createConfidenceComponents(values);
}

function prof(samples: readonly ConfidenceComponents[]): ConfidenceProfile {
  return createConfidenceProfile(samples);
}

interface Spec {
  id: string;
  level: HierarchyLevel;
  parent: string | null;
  profile: ConfidenceProfile;
  bbox?: BBox;
  children?: readonly string[];
}

function tree(specs: readonly Spec[]): LayoutHierarchy {
  return new LayoutHierarchy(
    specs.map((s) =>
      createHierarchyNode({
        id: s.id,
        level: s.level,
        parentId: s.parent,
        pageIndex: s.parent === null ? -1 : 0,
        bbox: s.bbox ?? { x: 0, y: 0, width: 100, height: 20 },
        normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
        confidence: s.profile,
        children: s.children ?? [],
      })
    )
  );
}

function rootSpec(children: readonly string[]): Spec {
  return {
    id: HIERARCHY_DOCUMENT_ID,
    level: HIERARCHY_ROOT_LEVEL,
    parent: null,
    profile: prof([comps()]),
    children,
  };
}

function P(id: string, children: readonly string[], parent = HIERARCHY_DOCUMENT_ID): Spec {
  return { id, level: NODE_LEVEL.PAGE, parent, profile: prof([comps()]), children };
}

function R(id: string, children: readonly string[], parent: string): Spec {
  return { id, level: NODE_LEVEL.REGION, parent, profile: prof([comps()]), children };
}

function B(id: string, children: readonly string[], parent: string): Spec {
  return { id, level: NODE_LEVEL.BLOCK, parent, profile: prof([comps()]), children };
}

function L(id: string, children: readonly string[], parent: string): Spec {
  return { id, level: NODE_LEVEL.LINE, parent, profile: prof([comps()]), children };
}

function W(id: string, ocr: number, parent: string, bbox?: BBox): Spec {
  return {
    id,
    level: NODE_LEVEL.WORD,
    parent,
    profile: prof([comps({ ocr })]),
    ...(bbox ? { bbox } : {}),
  };
}

function manySpecs(): Spec[] {
  return [
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2", "w3"], "block"),
    W("w1", 0.6, "line"),
    W("w2", 0.8, "line"),
    W("w3", 1.0, "line"),
  ];
}

function areaSpecs(): Spec[] {
  return [
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2"], "block"),
    W("w1", 0.5, "line", { x: 0, y: 0, width: 100, height: 10 }),
    W("w2", 1.0, "line", { x: 0, y: 0, width: 200, height: 10 }),
  ];
}

function countSpecs(): Spec[] {
  return [
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["l1", "l2"], "region"),
    L("l1", ["w1"], "block"),
    L("l2", ["w2", "w3", "w4"], "block"),
    W("w1", 0.0, "l1"),
    W("w2", 1.0, "l2"),
    W("w3", 1.0, "l2"),
    W("w4", 1.0, "l2"),
  ];
}

const productPolicy: CompositeScorePolicy = (c) =>
  c.ocr * c.geometric * c.structural * c.boundary * c.typological * c.order;

function tamperMap(
  propagated: PropagatedConfidence
): Map<string, ConfidenceProfile> {
  return new Map(propagated.ids().map((id) => [id, propagated.get(id)!]));
}

function throws(fn: () => unknown, needle?: string): Error {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (err === undefined) {
    throw new Error("expected function to throw");
  }
  const message = (err as Error).message;
  if (needle !== undefined && !message.includes(needle)) {
    throw new Error(
      `expected error containing ${JSON.stringify(needle)}, got ${JSON.stringify(message)}`
    );
  }
  return err as Error;
}

// ─── Bounds ──────────────────────────────────────────────────────────────────

test("bounds validator accepts in-range confidence", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  ok(validateConfidenceBounds(h, p).valid);
});

test("bounds validator rejects out-of-range components", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1"], "block"),
    W("w1", 1.4, "line"),
  ]);
  const p = propagateConfidence(h);
  const result = validateConfidenceBounds(h, p);
  ok(!result.valid);
  includes(result.errors.join("\n"), "outside the confidence range");
  includes(result.errors.join("\n"), "node line");
});

// ─── Finite values ───────────────────────────────────────────────────────────

test("finite validator accepts normal output", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  ok(validateFiniteConfidenceValues(h, p).valid);
});

function craftedNaNRoot(): ConfidenceProfile {
  return Object.freeze({
    ...prof([comps({ ocr: 0.9 })]),
    aggregate: Object.freeze({ count: 1, mean: NaN, variance: 0, min: NaN, max: NaN }),
  });
}

function craftedInfinityRoot(): ConfidenceProfile {
  return Object.freeze({
    ...prof([comps({ ocr: 0.9 })]),
    aggregate: Object.freeze({
      count: 1,
      mean: Infinity,
      variance: 0,
      min: Infinity,
      max: Infinity,
    }),
  });
}

test("finite validator rejects NaN and Infinity", () => {
  const h = tree([
    {
      id: HIERARCHY_DOCUMENT_ID,
      level: HIERARCHY_ROOT_LEVEL,
      parent: null,
      profile: craftedNaNRoot(),
    },
  ]);
  const p = propagateConfidence(h);
  const result = validateFiniteConfidenceValues(h, p);
  ok(!result.valid);
  includes(result.errors.join("\n"), "aggregate.mean");
  includes(result.errors.join("\n"), "NaN");

  const h2 = tree([
    {
      id: HIERARCHY_DOCUMENT_ID,
      level: HIERARCHY_ROOT_LEVEL,
      parent: null,
      profile: craftedInfinityRoot(),
    },
  ]);
  const p2 = propagateConfidence(h2);
  const result2 = validateFiniteConfidenceValues(h2, p2);
  ok(!result2.valid);
  includes(result2.errors.join("\n"), "Infinity");
});

// ─── Frozen output ───────────────────────────────────────────────────────────

test("frozen validator passes on propagation output", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  ok(validateFrozenConfidenceOutput(h, p).valid);
});

test("PropagatedConfidence rejects unfrozen profiles", () => {
  const h = tree(manySpecs());
  const unfrozen = { ...prof([comps({ ocr: 0.9 })]) };
  throws(
    () => new PropagatedConfidence(h, new Map([["ghost", unfrozen]])),
    "must be frozen"
  );
});

// ─── Coverage ────────────────────────────────────────────────────────────────

test("coverage validator requires a full bijection over the hierarchy", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  ok(validateCompleteConfidenceCoverage(h, p).valid);

  const map = tamperMap(p);
  map.delete("w2");
  const missing = new PropagatedConfidence(h, map);
  const result = validateCompleteConfidenceCoverage(h, missing);
  ok(!result.valid);
  includes(result.errors.join("\n"), "w2");

  map.set("ghost", prof([comps()]));
  const extra = new PropagatedConfidence(h, map);
  const result2 = validateCompleteConfidenceCoverage(h, extra);
  ok(!result2.valid);
  includes(result2.errors.join("\n"), "ghost");
});

// ─── Policy correctness ──────────────────────────────────────────────────────

test("policy correctness holds for equal, area and child-count policies", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  ok(validateConfidencePolicyCorrectness(h, p).valid);

  const hArea = tree(areaSpecs());
  const pArea = propagateConfidence(hArea, {
    weightPolicy: new AreaWeightedPolicy(),
  });
  ok(
    validateConfidencePolicyCorrectness(hArea, pArea, {
      weightPolicy: new AreaWeightedPolicy(),
    }).valid
  );

  const hCount = tree(countSpecs());
  const pCount = propagateConfidence(hCount, {
    weightPolicy: new ChildCountPolicy(),
  });
  ok(
    validateConfidencePolicyCorrectness(hCount, pCount, {
      weightPolicy: new ChildCountPolicy(),
    }).valid
  );
});

test("policy correctness holds for a non-linear composite policy", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2"], "block"),
    W("w1", 1.0, "line"),
    W("w2", 0.0, "line"),
  ]);
  const p = propagateConfidence(h, { compositePolicy: productPolicy });
  ok(
    validateConfidencePolicyCorrectness(h, p, {
      compositePolicy: productPolicy,
    }).valid
  );
});

test("policy correctness detects tampered parent profiles", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  const map = tamperMap(p);
  const line = p.get("line")!;
  map.set(
    "line",
    Object.freeze({ ...line, ocr: Object.freeze({ ...line.ocr, mean: 0.99 }) })
  );
  const bad = new PropagatedConfidence(h, map);
  const result = validateConfidencePolicyCorrectness(h, bad);
  ok(!result.valid);
  includes(result.errors.join("\n"), "node line");
});

test("policy correctness detects tampered leaf profiles", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  const map = tamperMap(p);
  const word = p.get("w1")!;
  map.set(
    "w1",
    Object.freeze({ ...word, ocr: Object.freeze({ ...word.ocr, mean: 0.5 }) })
  );
  const bad = new PropagatedConfidence(h, map);
  const result = validateConfidencePolicyCorrectness(h, bad);
  ok(!result.valid);
  includes(result.errors.join("\n"), "leaf node w1");
});

// ─── Determinism ─────────────────────────────────────────────────────────────

test("determinism validator passes for matching options", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  ok(validatePropagationDeterminism(h, p).valid);
  const pArea = propagateConfidence(h, {
    weightPolicy: new AreaWeightedPolicy(),
  });
  ok(
    validatePropagationDeterminism(h, pArea, {
      weightPolicy: new AreaWeightedPolicy(),
    }).valid
  );
});

test("determinism validator flags mismatched policy options", () => {
  const h = tree(areaSpecs());
  const p = propagateConfidence(h);
  const result = validatePropagationDeterminism(h, p, {
    weightPolicy: new AreaWeightedPolicy(),
  });
  ok(!result.valid);
  includes(result.errors.join("\n"), "node line");
});

// ─── Identical input ⇒ identical output ──────────────────────────────────────

test("compareConfidencePropagations accepts identical inputs", () => {
  const a = propagateConfidence(tree(manySpecs()));
  const b = propagateConfidence(tree(manySpecs()));
  ok(compareConfidencePropagations(a, b).valid);
});

test("compareConfidencePropagations flags differing inputs", () => {
  const a = propagateConfidence(tree(manySpecs()));
  const specs = manySpecs();
  const idx = specs.findIndex((s) => s.id === "w1");
  const variant = [...specs];
  variant[idx] = { ...specs[idx], profile: prof([comps({ ocr: 0.9 })]) };
  const b = propagateConfidence(tree(variant));
  ok(!compareConfidencePropagations(a, b).valid);

  const c = propagateConfidence(
    tree([
      rootSpec(["page"]),
      P("page", ["region"]),
      R("region", ["block"], "page"),
      B("block", ["line"], "region"),
      L("line", ["w1"], "block"),
      W("w1", 0.6, "line"),
    ])
  );
  equal(a.size, 8);
  ok(c.size !== a.size);
  ok(!compareConfidencePropagations(a, c).valid);
});

// ─── Weight validation helper ────────────────────────────────────────────────

test("validateChildWeights is exported and guards policy outputs", () => {
  throws(() => validateChildWeights([0.5, 0.5, 0.5], 2), "must match child count");
  throws(() => validateChildWeights([Infinity, -Infinity], 2), "finite");
  throws(() => validateChildWeights([0.7, 0.7], 2), "sum to 1");
  validateChildWeights([0.25, 0.75], 2);
});
