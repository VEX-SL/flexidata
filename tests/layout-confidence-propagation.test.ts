/**
 * Milestone 7 propagation tests — deterministic bottom-up confidence
 * propagation across the layout hierarchy: single and many children, equal and
 * weighted policies, empty children (leaf identity), deep and large
 * hierarchies, deterministic rebuilds, frozen output, composite-after-
 * propagation, and rejection of non-finite values and invalid weights.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  NODE_LEVEL,
  AreaWeightedPolicy,
  ChildCountPolicy,
  COMPONENT_KEYS,
  EqualWeightPolicy,
  LayoutHierarchy,
  createConfidenceComponents,
  createConfidenceProfile,
  createHierarchyNode,
  defaultCompositeScore,
  propagateConfidence,
  validateChildWeights,
} from "@/lib/layout";
import type {
  ChildWeightPolicy,
  CompositeScorePolicy,
  ConfidenceChild,
  ConfidenceComponents,
  ConfidenceProfile,
  HierarchyLevel,
} from "@/lib/layout";
import type { BBox } from "@/lib/pipeline/types";
import { equal, ok, test } from "./harness.ts";

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

function childView(
  id: string,
  width: number,
  height: number,
  childCount = 0
): ConfidenceChild {
  return {
    id,
    bbox: { x: 0, y: 0, width, height },
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    childCount,
    profile: prof([comps()]),
  };
}

function sameProfile(a: ConfidenceProfile, b: ConfidenceProfile): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function approx(actual: number, expected: number, eps = 1e-9): void {
  ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`);
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

class FixedWeights implements ChildWeightPolicy {
  readonly name: string;
  private readonly values: readonly number[];

  constructor(name: string, values: readonly number[]) {
    this.name = name;
    this.values = values;
  }

  weights(): readonly number[] {
    return this.values;
  }
}

// ─── Policy mechanics ────────────────────────────────────────────────────────

test("child-weight policies assign deterministic weights", () => {
  equal(
    new EqualWeightPolicy().weights([
      childView("a", 1, 1),
      childView("b", 1, 1),
      childView("c", 1, 1),
    ]),
    [1 / 3, 1 / 3, 1 / 3]
  );
  equal(new EqualWeightPolicy().weights([]), []);
  equal(
    new AreaWeightedPolicy().weights([
      childView("a", 100, 10),
      childView("b", 200, 10),
    ]),
    [1 / 3, 2 / 3]
  );
  equal(
    new AreaWeightedPolicy().weights([
      childView("a", 0, 10),
      childView("b", 0, 10),
    ]),
    [0.5, 0.5]
  );
  equal(
    new ChildCountPolicy().weights([
      childView("a", 1, 1, 1),
      childView("b", 1, 1, 3),
    ]),
    [0.25, 0.75]
  );
  equal(
    new ChildCountPolicy().weights([
      childView("a", 1, 1, 0),
      childView("b", 1, 1, 0),
    ]),
    [0.5, 0.5]
  );
  equal(new ChildCountPolicy().weights([]), []);
});

test("validateChildWeights accepts valid vectors and rejects invalid ones", () => {
  validateChildWeights([0.5, 0.5], 2);
  validateChildWeights([], 0);
  throws(() => validateChildWeights([0.5, 0.4], 2), "sum to 1");
  throws(() => validateChildWeights([2, -1], 2), "non-negative");
  throws(() => validateChildWeights([NaN, NaN], 2), "finite");
  throws(() => validateChildWeights([0.5], 2), "must match child count");
});

// ─── Core propagation ────────────────────────────────────────────────────────

test("single child: parent inherits the child's components; composite is computed after propagation", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1"], "block"),
    W("w1", 0.9, "line"),
  ]);
  const p = propagateConfidence(h);
  ok(sameProfile(p.get("w1")!, prof([comps({ ocr: 0.9 })])));
  equal(p.get("line")!.ocr.mean, 0.9);
  equal(p.get("line")!.ocr.count, 1);
  equal(p.get("line")!.ocr.min, 0.9);
  equal(p.get("line")!.ocr.max, 0.9);
  equal(p.get("line")!.geometric.mean, 0);
  const expected = defaultCompositeScore(comps({ ocr: 0.9 }));
  equal(p.get("line")!.aggregate.mean, expected);
  equal(p.get("block")!.ocr.mean, 0.9);
  equal(p.get("block")!.aggregate.mean, expected);
  equal(p.get("region")!.ocr.mean, 0.9);
  equal(p.get("page")!.ocr.mean, 0.9);
  equal(p.get("document")!.ocr.mean, 0.9);
  equal(p.get("document")!.aggregate.mean, expected);
});

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

test("many children: equal-weight mean, distribution stats and composite after propagation", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  const ocr = p.get("line")!.ocr;
  equal(ocr.count, 3);
  approx(ocr.mean, 0.8);
  equal(ocr.min, 0.6);
  equal(ocr.max, 1.0);
  approx(
    ocr.variance,
    ((0.6 - 0.8) ** 2 + (0.8 - 0.8) ** 2 + (1.0 - 0.8) ** 2) / 3
  );
  approx(p.get("line")!.aggregate.mean, defaultCompositeScore(comps({ ocr: 0.8 })));
  const explicit = propagateConfidence(h, {
    weightPolicy: new EqualWeightPolicy(),
  });
  ok(sameProfile(explicit.get("line")!, p.get("line")!));
});

test("empty children: leaf nodes keep their own profile; container reports identity", () => {
  const rootProfile = prof([comps({ ocr: 0.7 })]);
  const h = tree([
    {
      id: HIERARCHY_DOCUMENT_ID,
      level: HIERARCHY_ROOT_LEVEL,
      parent: null,
      profile: rootProfile,
    },
  ]);
  const p = propagateConfidence(h);
  equal(p.size, 1);
  ok(p.has(HIERARCHY_DOCUMENT_ID));
  equal(p.get("missing"), undefined);
  ok(sameProfile(p.get(HIERARCHY_DOCUMENT_ID)!, rootProfile));
  equal(p.ids().length, 1);
});

// ─── Weighted policies ───────────────────────────────────────────────────────

test("area-weighted policy weights larger children more and falls back to equal weights on zero areas", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2"], "block"),
    W("w1", 0.5, "line", { x: 0, y: 0, width: 100, height: 10 }),
    W("w2", 1.0, "line", { x: 0, y: 0, width: 200, height: 10 }),
  ]);
  const p = propagateConfidence(h, { weightPolicy: new AreaWeightedPolicy() });
  approx(p.get("line")!.ocr.mean, 0.5 * (1 / 3) + 1.0 * (2 / 3));

  const zeroArea = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2"], "block"),
    W("w1", 0.5, "line", { x: 0, y: 0, width: 0, height: 10 }),
    W("w2", 1.0, "line", { x: 0, y: 0, width: 0, height: 10 }),
  ]);
  const p2 = propagateConfidence(zeroArea, {
    weightPolicy: new AreaWeightedPolicy(),
  });
  equal(p2.get("line")!.ocr.mean, 0.75);
});

test("child-count policy weights children by how much they span and falls back to equal weights on leaves", () => {
  const h = tree([
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
  ]);
  const p = propagateConfidence(h, { weightPolicy: new ChildCountPolicy() });
  approx(p.get("block")!.ocr.mean, 0.75);

  const allLeaves = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2"], "block"),
    W("w1", 0.2, "line"),
    W("w2", 0.8, "line"),
  ]);
  const p2 = propagateConfidence(allLeaves, {
    weightPolicy: new ChildCountPolicy(),
  });
  equal(p2.get("line")!.ocr.mean, 0.5);
});

// ─── Deep and large hierarchies ─────────────────────────────────────────────

test("deep hierarchy propagates bottom-up across every level", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["l1", "l2"], "region"),
    L("l1", ["w1", "w2"], "block"),
    L("l2", ["w3", "w4"], "block"),
    W("w1", 0.6, "l1"),
    W("w2", 0.8, "l1"),
    W("w3", 1.0, "l2"),
    W("w4", 0.4, "l2"),
  ]);
  const p = propagateConfidence(h);
  equal(p.get("l1")!.ocr.mean, 0.7);
  equal(p.get("l2")!.ocr.mean, 0.7);
  equal(p.get("l1")!.ocr.count, 2);
  approx(p.get("l1")!.ocr.variance, 0.01);
  equal(p.get("block")!.ocr.mean, 0.7);
  equal(p.get("block")!.ocr.count, 2);
  equal(p.get("region")!.ocr.mean, 0.7);
  equal(p.get("page")!.ocr.mean, 0.7);
  equal(p.get("document")!.ocr.mean, 0.7);
  const composite = defaultCompositeScore(comps({ ocr: 0.7 }));
  equal(p.get("l1")!.aggregate.mean, composite);
  equal(p.get("block")!.aggregate.mean, composite);
  equal(p.get("document")!.aggregate.mean, composite);
});

function largeTree(): LayoutHierarchy {
  const specs: Spec[] = [];
  const documentChildren: string[] = [];
  let k = 0;
  for (let pg = 0; pg < 10; pg++) {
    const pageId = `p${pg}`;
    const pageChildren: string[] = [];
    for (let r = 0; r < 5; r++) {
      const regionId = `${pageId}r${r}`;
      const regionChildren: string[] = [];
      for (let b = 0; b < 4; b++) {
        const blockId = `${regionId}b${b}`;
        const blockChildren: string[] = [];
        for (let l = 0; l < 4; l++) {
          const lineId = `${blockId}l${l}`;
          const lineChildren: string[] = [];
          for (let w = 0; w < 5; w++) {
            const wordId = `${lineId}w${w}`;
            specs.push({
              id: wordId,
              level: NODE_LEVEL.WORD,
              parent: lineId,
              profile: prof([comps({ ocr: 0.4 + (k % 10) * 0.05 })]),
            });
            lineChildren.push(wordId);
            k += 1;
          }
          specs.push({
            id: lineId,
            level: NODE_LEVEL.LINE,
            parent: blockId,
            profile: prof([comps()]),
            children: lineChildren,
          });
          blockChildren.push(lineId);
        }
        specs.push({
          id: blockId,
          level: NODE_LEVEL.BLOCK,
          parent: regionId,
          profile: prof([comps()]),
          children: blockChildren,
        });
        regionChildren.push(blockId);
      }
      specs.push({
        id: regionId,
        level: NODE_LEVEL.REGION,
        parent: pageId,
        profile: prof([comps()]),
        children: regionChildren,
      });
      pageChildren.push(regionId);
    }
    specs.push({
      id: pageId,
      level: NODE_LEVEL.PAGE,
      parent: HIERARCHY_DOCUMENT_ID,
      profile: prof([comps()]),
      children: pageChildren,
    });
    documentChildren.push(pageId);
  }
  specs.push({
    id: HIERARCHY_DOCUMENT_ID,
    level: HIERARCHY_ROOT_LEVEL,
    parent: null,
    profile: prof([comps()]),
    children: documentChildren,
  });
  return tree(specs);
}

test("large hierarchy: every node is propagated and the root aggregates all words", () => {
  const h = largeTree();
  equal(h.nodeCount, 5061);
  const p = propagateConfidence(h);
  equal(p.size, 5061);
  for (const node of h.nodes()) ok(p.has(node.id), `missing ${node.id}`);
  approx(p.get("document")!.ocr.mean, 0.625);
  approx(p.get("p0r0b0l0")!.ocr.mean, 0.5);
});

// ─── Determinism, frozenness and identical inputs ───────────────────────────

test("propagation is deterministic across rebuilds", () => {
  const h = tree(manySpecs());
  const p1 = propagateConfidence(h);
  const p2 = propagateConfidence(h);
  equal(p1.size, p2.size);
  for (const id of p1.ids()) {
    ok(sameProfile(p1.get(id)!, p2.get(id)!), `node ${id}`);
  }
});

test("identical hierarchy yields identical confidence", () => {
  const a = propagateConfidence(tree(manySpecs()));
  const b = propagateConfidence(tree(manySpecs()));
  equal(a.size, b.size);
  for (const node of a.hierarchy.nodes()) {
    ok(sameProfile(a.get(node.id)!, b.get(node.id)!), node.id);
  }
});

test("propagation output is deep-frozen", () => {
  const h = tree(manySpecs());
  const p = propagateConfidence(h);
  ok(Object.isFrozen(p));
  for (const id of p.ids()) {
    const profile = p.get(id)!;
    ok(Object.isFrozen(profile), `${id} profile`);
    for (const key of COMPONENT_KEYS) {
      ok(Object.isFrozen(profile[key]), `${id} ${key}`);
    }
    ok(Object.isFrozen(profile.aggregate), `${id} aggregate`);
  }
});

// ─── Composite-after-propagation ─────────────────────────────────────────────

test("composite is computed from propagated components, not from child composites", () => {
  const productPolicy: CompositeScorePolicy = (c) =>
    c.ocr * c.geometric * c.structural * c.boundary * c.typological * c.order;
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2"], "block"),
    {
      id: "w1",
      level: NODE_LEVEL.WORD,
      parent: "line",
      profile: prof([
        comps({
          ocr: 1,
          geometric: 1,
          structural: 1,
          boundary: 1,
          typological: 1,
          order: 1,
        }),
      ]),
    },
    { id: "w2", level: NODE_LEVEL.WORD, parent: "line", profile: prof([comps()]) },
  ]);
  const p = propagateConfidence(h, { compositePolicy: productPolicy });
  equal(p.get("line")!.aggregate.mean, 0.5 ** 6);
  ok(p.get("line")!.aggregate.mean !== 0.5);
  equal(p.get("block")!.aggregate.mean, 0.5 ** 6);
});

// ─── Input rejection ─────────────────────────────────────────────────────────

test("propagation rejects NaN confidence components", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1"], "block"),
    {
      id: "w1",
      level: NODE_LEVEL.WORD,
      parent: "line",
      profile: Object.freeze({
        ...prof([comps({ ocr: 0.9 })]),
        ocr: Object.freeze({ count: 1, mean: NaN, variance: 0, min: NaN, max: NaN }),
      }),
    },
  ]);
  throws(() => propagateConfidence(h), "finite");
});

test("propagation rejects Infinity confidence components", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1"], "block"),
    {
      id: "w1",
      level: NODE_LEVEL.WORD,
      parent: "line",
      profile: Object.freeze({
        ...prof([comps({ ocr: 0.9 })]),
        ocr: Object.freeze({
          count: 1,
          mean: Infinity,
          variance: 0,
          min: Infinity,
          max: Infinity,
        }),
      }),
    },
  ]);
  throws(() => propagateConfidence(h), "finite");
});

test("propagation rejects invalid child weights", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2"], "block"),
    W("w1", 0.6, "line"),
    W("w2", 0.8, "line"),
  ]);
  throws(
    () =>
      propagateConfidence(h, {
        weightPolicy: new FixedWeights("wrong-sum", [0.2, 0.2]),
      }),
    "sum to 1"
  );
  throws(
    () =>
      propagateConfidence(h, {
        weightPolicy: new FixedWeights("negative", [2, -1]),
      }),
    "non-negative"
  );
  throws(
    () =>
      propagateConfidence(h, {
        weightPolicy: new FixedWeights("nan", [NaN, NaN]),
      }),
    "finite"
  );
  throws(
    () =>
      propagateConfidence(h, {
        weightPolicy: new FixedWeights("count", [0.5]),
      }),
    "must match child count"
  );
});
