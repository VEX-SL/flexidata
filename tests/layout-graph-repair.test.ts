/**
 * Milestone 8 graph auto-repair tests — the deterministic immutable repair
 * engine over the four composed structures.
 *
 * Covers the mandated scenarios: repaired graph, irreparable graph, repair
 * idempotence, plus determinism, immutability of the inputs, the repair-action
 * reporting and the repaired model's re-validation.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  LAYOUT_EDGE_TYPE,
  LayoutHierarchy,
  NODE_LEVEL,
  PropagatedConfidence,
  READING_NEXT,
  READING_PREVIOUS,
  ReadingOrderGraph,
  SemanticGraph,
  buildReadingOrder,
  createConfidenceComponents,
  createConfidenceProfile,
  createHierarchyNode,
  isGraphValidationFailure,
  propagateConfidence,
  repairGraphs,
  validateGraphs,
} from "@/lib/layout";
import type {
  ConfidenceComponents,
  ConfidenceProfile,
  GraphValidationInput,
  GraphRepairResult,
  HierarchyLevel,
  HierarchyNode,
  HierarchySourceRef,
  LayoutEdgeType,
  NodeLevel,
  ReadingOrderEdgeType,
  RegionType,
} from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { equal, includes, ok, test } from "./harness.ts";

// ─── Fixture helpers (shared shape with the validator tests) ─────────────────

const FULL_BBOX = { x: 0, y: 0, width: 100, height: 100 };

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
  children?: readonly string[];
  sourceRefs?: readonly HierarchySourceRef[];
  regionType?: RegionType;
  ocr?: number;
}

function makeNode(s: Spec): HierarchyNode {
  return createHierarchyNode({
    id: s.id,
    level: s.level,
    parentId: s.parent,
    pageIndex: s.parent === null ? -1 : 0,
    bbox: FULL_BBOX,
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: prof([comps(s.ocr !== undefined ? { ocr: s.ocr } : {})]),
    children: s.children ?? [],
    sourceRefs: s.sourceRefs ?? [],
    ...(s.regionType !== undefined ? { regionType: s.regionType } : {}),
  });
}

function docSpecs(): Spec[] {
  return [
    {
      id: HIERARCHY_DOCUMENT_ID,
      level: HIERARCHY_ROOT_LEVEL,
      parent: null,
      children: ["page"],
    },
    {
      id: "page",
      level: NODE_LEVEL.PAGE,
      parent: HIERARCHY_DOCUMENT_ID,
      children: ["region"],
    },
    {
      id: "region",
      level: NODE_LEVEL.REGION,
      parent: "page",
      children: ["block"],
    },
    {
      id: "block",
      level: NODE_LEVEL.BLOCK,
      parent: "region",
      children: ["line"],
    },
    {
      id: "line",
      level: NODE_LEVEL.LINE,
      parent: "block",
      children: ["w0", "w1", "w2"],
    },
    {
      id: "w0",
      level: NODE_LEVEL.WORD,
      parent: "line",
      sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 0 }],
      ocr: 0.9,
    },
    {
      id: "w1",
      level: NODE_LEVEL.WORD,
      parent: "line",
      sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 1 }],
      ocr: 0.8,
    },
    {
      id: "w2",
      level: NODE_LEVEL.WORD,
      parent: "line",
      sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 2 }],
      ocr: 0.1,
    },
  ];
}

function makeOcr(wordCount = 3): OcrDocument {
  const words: OcrWord[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push({ text: String.fromCharCode(97 + i), bbox: { x: i * 20, y: 0, width: 10, height: 10 } });
  }
  const line: OcrLine = {
    text: words.map((w) => w.text).join(" "),
    words,
    bbox: { x: 0, y: 0, width: wordCount * 20, height: 10 },
  };
  return { text: line.text, lines: [line] };
}

interface BuildModelOptions {
  readonly extraEdges?: readonly (readonly [LayoutEdgeType, string, string])[];
}

function buildModel(
  specs: readonly Spec[],
  ocr: OcrDocument,
  options: BuildModelOptions = {}
): GraphValidationInput {
  const hierarchy = new LayoutHierarchy(specs.map(makeNode));
  const graph = new SemanticGraph();
  for (const node of hierarchy.nodes()) {
    if (node.id === HIERARCHY_DOCUMENT_ID) continue;
    graph.addNode(node.id, {
      level: node.level as NodeLevel,
      regionType: node.regionType,
    });
  }
  for (const node of hierarchy.nodes()) {
    if (node.id === HIERARCHY_DOCUMENT_ID) continue;
    for (const childId of node.children) {
      graph.addEdge(LAYOUT_EDGE_TYPE.CHILD_OF, node.id, childId);
      graph.addEdge(LAYOUT_EDGE_TYPE.CONTAINS, node.id, childId);
    }
  }
  for (const [type, from, to] of options.extraEdges ?? []) {
    graph.addEdge(type, from, to);
  }
  graph.freeze();
  return {
    ocr,
    hierarchy,
    semanticGraph: graph,
    readingOrder: buildReadingOrder(hierarchy),
    confidence: propagateConfidence(hierarchy),
  };
}

function fixture(options: BuildModelOptions = {}): GraphValidationInput {
  return buildModel(docSpecs(), makeOcr(), options);
}

function readingOrderWith(
  model: GraphValidationInput,
  extra: readonly (readonly [ReadingOrderEdgeType, string, string])[]
): ReadingOrderGraph {
  return new ReadingOrderGraph(
    model.readingOrder.nodes(),
    model.readingOrder.edges().concat(
      extra.map(([type, from, to]) => ({ type, from, to }))
    )
  );
}

function expectReport(
  result: GraphRepairResult
): { report: Exclude<typeof result.outcome, { kind: "failure" }>; model: GraphValidationInput } {
  const outcome = result.outcome;
  if (isGraphValidationFailure(outcome)) {
    throw new Error(`expected a report, got a failure: ${outcome.reason}`);
  }
  if (result.repairedModel === undefined) {
    throw new Error("expected a repaired model alongside the report");
  }
  return { report: outcome, model: result.repairedModel };
}

function tamperedConfidence(
  input: GraphValidationInput
): PropagatedConfidence {
  const map = new Map<string, ConfidenceProfile>();
  for (const id of input.confidence.ids()) {
    map.set(id, input.confidence.get(id)!);
  }
  const w2 = map.get("w2")!;
  map.set(
    "w2",
    Object.freeze({
      ...w2,
      aggregate: Object.freeze({
        count: 1,
        mean: 1.5,
        variance: 0,
        min: 1.5,
        max: 1.5,
      }),
    })
  );
  return new PropagatedConfidence(input.hierarchy, map);
}

// ─── 1. Repaired graph ───────────────────────────────────────────────────────

test("repair breaks a reading-order cycle by dropping the lowest-confidence edge", () => {
  const input = fixture();
  const cyclic = readingOrderWith(input, [
    [READING_NEXT, "w2", "w0"],
    [READING_PREVIOUS, "w0", "w2"],
  ]);
  const { report, model } = expectReport(
    repairGraphs({ ...input, readingOrder: cyclic })
  );
  ok(report.repaired);
  ok(report.valid, `errors: ${report.errors.join("; ")}`);
  ok(
    report.repairActions.some((a) => a.kind === "REMOVE_READING_EDGE"),
    "the cycle break must be recorded"
  );
  equal(report.statistics.repairedEdgeCount, 1);
  equal(model.readingOrder.readingNext("w0"), ["w1"]);
  equal(model.readingOrder.readingNext("w1"), ["w2"]);
  ok(model.readingOrder.readingNext("w2").length === 0);
});

test("repair breaks a containment cycle by dropping the lowest-confidence edge", () => {
  const input = fixture({
    extraEdges: [[LAYOUT_EDGE_TYPE.CONTAINS, "w2", "line"]],
  });
  const { report, model } = expectReport(repairGraphs(input));
  ok(report.repaired);
  ok(report.valid, `errors: ${report.errors.join("; ")}`);
  ok(
    report.repairActions.some((a) => a.kind === "REMOVE_CONTAINMENT_EDGE"),
    "the containment break must be recorded"
  );
  ok(!model.semanticGraph.hasEdge(LAYOUT_EDGE_TYPE.CONTAINS, "w2", "line"));
});

test("repair deduplicates duplicate reading edges", () => {
  const input = fixture();
  const dup = readingOrderWith(input, [[READING_NEXT, "w0", "w1"]]);
  const { report, model } = expectReport(
    repairGraphs({ ...input, readingOrder: dup })
  );
  ok(report.repaired);
  ok(report.valid, `errors: ${report.errors.join("; ")}`);
  ok(
    report.repairActions.some((a) => a.kind === "DROP_DUPLICATE_EDGE"),
    "the deduplication must be recorded"
  );
  equal(model.readingOrder.readingNext("w0"), ["w1"]);
});

test("repair resolves multiple parents keeping the highest-confidence one", () => {
  const input = fixture({
    extraEdges: [[LAYOUT_EDGE_TYPE.CHILD_OF, "block", "w1"]],
  });
  const { report, model } = expectReport(repairGraphs(input));
  ok(report.repaired);
  ok(report.valid, `errors: ${report.errors.join("; ")}`);
  ok(
    report.repairActions.some((a) => a.kind === "DROP_PARENT"),
    "the dropped parent must be recorded"
  );
  // Both parents carry equal propagated confidence, so the earlier edge wins.
  equal(model.semanticGraph.parent("w1"), ["line"]);
  ok(!model.semanticGraph.hasEdge(LAYOUT_EDGE_TYPE.CHILD_OF, "block", "w1"));
});

test("a clean model is reported as not repaired", () => {
  const input = fixture();
  const { report, model } = expectReport(repairGraphs(input));
  equal(report.repaired, false);
  ok(report.valid);
  equal(report.repairActions, []);
  equal(report.statistics.repairedEdgeCount, 0);
  equal(report.statistics.repairedParentCount, 0);
  equal(JSON.stringify(model.semanticGraph.edges()), JSON.stringify(input.semanticGraph.edges()));
  equal(JSON.stringify(model.readingOrder.edges()), JSON.stringify(input.readingOrder.edges()));
});

// ─── 2. Irreparable graph ────────────────────────────────────────────────────

test("invalid confidence is reported as a failure, never repaired", () => {
  const input = fixture();
  const result = repairGraphs({ ...input, confidence: tamperedConfidence(input) });
  ok(isGraphValidationFailure(result.outcome));
  if (isGraphValidationFailure(result.outcome)) {
    includes(result.outcome.reason, "invalid confidence values");
  }
});

test("missing OCR ownership is reported as a failure, never repaired", () => {
  const input = buildModel(docSpecs(), makeOcr(4));
  const result = repairGraphs(input);
  ok(isGraphValidationFailure(result.outcome));
  if (isGraphValidationFailure(result.outcome)) {
    includes(result.outcome.reason, "missing or incomplete OCR ownership");
  }
});

test("incoherent structures are reported as a failure", () => {
  const input = fixture();
  const missing = new ReadingOrderGraph(
    input.readingOrder.nodes().filter((n) => n.id !== "w2"),
    input.readingOrder
      .edges()
      .filter((e) => e.from !== "w2" && e.to !== "w2")
  );
  const result = repairGraphs({ ...input, readingOrder: missing });
  ok(isGraphValidationFailure(result.outcome));
  if (isGraphValidationFailure(result.outcome)) {
    includes(result.outcome.reason, "different node universes");
  }
});

// ─── 3. Idempotence ──────────────────────────────────────────────────────────

test("repair is idempotent: repairing its own output changes nothing", () => {
  const input = fixture();
  const cyclic = readingOrderWith(input, [
    [READING_NEXT, "w2", "w0"],
    [READING_PREVIOUS, "w0", "w2"],
  ]);
  const once = expectReport(repairGraphs({ ...input, readingOrder: cyclic }));
  const twice = expectReport(repairGraphs(once.model));
  equal(twice.report.repaired, false);
  equal(twice.report.repairActions, []);
  equal(JSON.stringify(twice.model.readingOrder.edges()), JSON.stringify(once.model.readingOrder.edges()));
});

// ─── 4. Determinism and immutability ─────────────────────────────────────────

test("repair is deterministic: identical inputs reproduce identical output", () => {
  const input = fixture();
  const cyclic = readingOrderWith(input, [
    [READING_NEXT, "w2", "w0"],
    [READING_PREVIOUS, "w0", "w2"],
  ]);
  const broken = { ...input, readingOrder: cyclic };
  const first = repairGraphs(broken);
  const second = repairGraphs(broken);
  equal(JSON.stringify(first.outcome), JSON.stringify(second.outcome));
  equal(JSON.stringify(first.repairedModel), JSON.stringify(second.repairedModel));
});

test("repair never mutates its inputs", () => {
  const input = fixture({
    extraEdges: [[LAYOUT_EDGE_TYPE.CHILD_OF, "block", "w1"]],
  });
  const before = JSON.stringify(input);
  repairGraphs(input);
  equal(JSON.stringify(input), before);
});

test("repair output is deep-frozen", () => {
  const input = fixture();
  const cyclic = readingOrderWith(input, [
    [READING_NEXT, "w2", "w0"],
    [READING_PREVIOUS, "w0", "w2"],
  ]);
  const { report, model } = expectReport(
    repairGraphs({ ...input, readingOrder: cyclic })
  );
  ok(Object.isFrozen(report));
  ok(Object.isFrozen(report.errors));
  ok(Object.isFrozen(report.repairActions));
  ok(Object.isFrozen(model.semanticGraph));
  ok(Object.isFrozen(model.readingOrder));
});

test("repair never invents nodes or reorders positions", () => {
  const input = fixture();
  const cyclic = readingOrderWith(input, [
    [READING_NEXT, "w2", "w0"],
    [READING_PREVIOUS, "w0", "w2"],
  ]);
  const { model } = expectReport(repairGraphs({ ...input, readingOrder: cyclic }));
  equal(
    model.readingOrder.nodes().map((n) => n.id),
    input.readingOrder.nodes().map((n) => n.id)
  );
  for (const node of input.readingOrder.nodes()) {
    equal(model.readingOrder.get(node.id)!.position, node.position);
  }
});

// ─── 5. The repaired model re-validates clean ────────────────────────────────

test("the repaired model passes the validation gate", () => {
  const input = fixture({
    extraEdges: [
      [LAYOUT_EDGE_TYPE.CONTAINS, "w2", "line"],
      [LAYOUT_EDGE_TYPE.CHILD_OF, "block", "w1"],
    ],
  });
  const { report, model } = expectReport(repairGraphs(input));
  ok(report.valid, `errors: ${report.errors.join("; ")}`);
  const revalidated = validateGraphs(model);
  ok(!isGraphValidationFailure(revalidated), "must be a report");
  if (!isGraphValidationFailure(revalidated)) {
    ok(revalidated.valid, `errors: ${revalidated.errors.join("; ")}`);
  }
});
