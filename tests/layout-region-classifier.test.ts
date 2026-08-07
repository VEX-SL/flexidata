/**
 * Milestone 5 adaptive region classification — scenario-driven tests. Every
 * required scenario must classify its regions to the intended layout role using
 * geometry alone; the output must be deterministic, adaptive (page-derived
 * thresholds with recorded fallbacks), explainable and confidence-bearing.
 */
import {
  REGION_TYPE,
  classifyRegions,
} from "@/lib/layout";
import type {
  CompositeScorePolicy,
  RegionClassification,
  RegionClassificationOutcome,
  RegionType,
} from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";
import { buildRegionHierarchy } from "./layout-region-helpers.ts";
import {
  ANNOTATION_PAGE,
  CENTERED_HEADER_PAGE,
  CONTRACT_PAGE,
  DENSE_PAGE,
  FOOTER_PAGE,
  INVOICE_PAGE,
  MULTI_COLUMN_PAGE,
  RECEIPT_PAGE,
  REQUIRED_SCENARIOS,
  SIDEBAR_PAGE,
  SIGNATURE_PAGE,
  SPARSE_PAGE,
  STAMP_PAGE,
  UNKNOWN_PAGE,
  FORM_FIELD_PAGE,
  renameScenarioIds,
} from "./layout-region-scenarios.ts";
import type { ScenarioPage } from "./layout-region-scenarios.ts";

function approx(actual: number, expected: number, eps = 1e-6): void {
  ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} within ${eps}`
  );
}

function classify(page: ScenarioPage): RegionClassificationOutcome {
  return classifyRegions(buildRegionHierarchy(page));
}

function byId(
  outcome: RegionClassificationOutcome,
  id: string
): RegionClassification {
  const found = outcome.classifications.find((c) => c.regionId === id);
  ok(found !== undefined, `region ${id} is classified`);
  return found!;
}

function expectTypes(
  page: ScenarioPage,
  expected: Readonly<Record<string, RegionType>>
): RegionClassificationOutcome {
  const outcome = classify(page);
  for (const [id, type] of Object.entries(expected)) {
    equal(byId(outcome, id).type, type, `region ${id}`);
  }
  return outcome;
}

// ─── Required scenarios ──────────────────────────────────────────────────────

test("invoice: header / body / table / footer", () => {
  expectTypes(INVOICE_PAGE, {
    header: REGION_TYPE.HEADER,
    body: REGION_TYPE.BODY,
    table: REGION_TYPE.TABLE,
    footer: REGION_TYPE.FOOTER,
  });
});

test("centered header: header / body / footer", () => {
  expectTypes(CENTERED_HEADER_PAGE, {
    chead: REGION_TYPE.HEADER,
    body: REGION_TYPE.BODY,
    footer: REGION_TYPE.FOOTER,
  });
});

test("footer scenario: header / body / footer", () => {
  expectTypes(FOOTER_PAGE, {
    header: REGION_TYPE.HEADER,
    body: REGION_TYPE.BODY,
    footer: REGION_TYPE.FOOTER,
  });
});

test("sidebar: body / sidebar", () => {
  expectTypes(SIDEBAR_PAGE, {
    body: REGION_TYPE.BODY,
    rail: REGION_TYPE.SIDEBAR,
  });
});

test("multi-column: two bodies", () => {
  expectTypes(MULTI_COLUMN_PAGE, {
    colA: REGION_TYPE.BODY,
    colB: REGION_TYPE.BODY,
  });
});

test("receipt: shop header / line items / total / footer", () => {
  expectTypes(RECEIPT_PAGE, {
    shop: REGION_TYPE.HEADER,
    line1: REGION_TYPE.BODY,
    line2: REGION_TYPE.BODY,
    line3: REGION_TYPE.BODY,
    total: REGION_TYPE.BODY,
    footer: REGION_TYPE.FOOTER,
  });
});

test("contract: title / clauses / signature zone / footer", () => {
  expectTypes(CONTRACT_PAGE, {
    title: REGION_TYPE.HEADER,
    clause1: REGION_TYPE.BODY,
    clause2: REGION_TYPE.BODY,
    clause3: REGION_TYPE.BODY,
    sig: REGION_TYPE.SIGNATURE_ZONE,
    footer: REGION_TYPE.FOOTER,
  });
});

test("dense page: body / footer", () => {
  expectTypes(DENSE_PAGE, {
    body: REGION_TYPE.BODY,
    footer: REGION_TYPE.FOOTER,
  });
});

test("sparse page: no false positives", () => {
  expectTypes(SPARSE_PAGE, {
    r0: REGION_TYPE.BODY,
    r1: REGION_TYPE.BODY,
    r2: REGION_TYPE.BODY,
  });
});

test("stamp: body / isolated stamp", () => {
  expectTypes(STAMP_PAGE, {
    body: REGION_TYPE.BODY,
    stamp: REGION_TYPE.STAMP,
  });
});

test("annotation: body / margin note", () => {
  expectTypes(ANNOTATION_PAGE, {
    body: REGION_TYPE.BODY,
    note: REGION_TYPE.ANNOTATION,
  });
});

test("signature zone: body / bottom blank band", () => {
  expectTypes(SIGNATURE_PAGE, {
    body: REGION_TYPE.BODY,
    sig: REGION_TYPE.SIGNATURE_ZONE,
  });
});

test("form field: header / blank input bands / body / footer", () => {
  expectTypes(FORM_FIELD_PAGE, {
    header: REGION_TYPE.HEADER,
    f1: REGION_TYPE.FORM_FIELD,
    f2: REGION_TYPE.FORM_FIELD,
    body: REGION_TYPE.BODY,
    footer: REGION_TYPE.FOOTER,
  });
});

test("unknown layout: incoherent band is Unknown", () => {
  const outcome = expectTypes(UNKNOWN_PAGE, {
    body: REGION_TYPE.BODY,
    target: REGION_TYPE.UNKNOWN,
    sig: REGION_TYPE.SIGNATURE_ZONE,
    foot: REGION_TYPE.FOOTER,
  });
  const target = byId(outcome, "target");
  ok(
    target.notes.some((n) => n.includes("no candidate is decisive")),
    "unknown decision explains the adaptive floor"
  );
  ok(
    target.notes.some((n) => n.includes("gate rejected")),
    "gated candidates explain their rejection"
  );
});

// ─── Scoring / confidence contract ───────────────────────────────────────────

test("every region is classified exactly once", () => {
  for (const page of REQUIRED_SCENARIOS) {
    const outcome = classify(page);
    equal(outcome.classifications.length, page.regions.length);
  }
});

test("top score matches the winning candidate and margins are exact", () => {
  for (const page of REQUIRED_SCENARIOS) {
    const outcome = classify(page);
    for (const c of outcome.classifications) {
      equal(c.topScore, c.candidates[0].score);
      const runnerUp = c.candidates[1]?.score ?? 0;
      approx(c.margin, Math.max(0, c.topScore - runnerUp));
    }
  }
});

test("candidates are sorted best-first with deterministic ties", () => {
  for (const page of REQUIRED_SCENARIOS) {
    const outcome = classify(page);
    for (const c of outcome.classifications) {
      for (let i = 1; i < c.candidates.length; i++) {
        const prev = c.candidates[i - 1];
        const cur = c.candidates[i];
        ok(
          cur.score < prev.score ||
            (cur.score === prev.score && cur.type > prev.type),
          "candidate order is score-descending then lexicographic"
        );
      }
    }
  }
});

test("confidence geometric component is the top score, typological the margin", () => {
  for (const page of REQUIRED_SCENARIOS) {
    const outcome = classify(page);
    for (const c of outcome.classifications) {
      approx(c.confidence.geometric.min, c.topScore);
      approx(c.confidence.geometric.max, c.topScore);
      if (c.type === REGION_TYPE.UNKNOWN) {
        equal(c.confidence.typological.min, 0);
        equal(c.confidence.typological.max, 0);
      } else {
        approx(c.confidence.typological.min, c.margin / c.topScore);
        approx(c.confidence.typological.max, c.margin / c.topScore);
      }
      ok(c.confidence.aggregate.min >= 0 && c.confidence.aggregate.max <= 1);
    }
  }
});

test("an unknown decision carries zero typological confidence", () => {
  const outcome = classify(UNKNOWN_PAGE);
  const target = byId(outcome, "target");
  equal(target.type, REGION_TYPE.UNKNOWN);
  equal(target.confidence.typological.min, 0);
  equal(target.confidence.typological.max, 0);
});

test("primary and secondary evidence are exact subsets of the explanation", () => {
  for (const page of REQUIRED_SCENARIOS) {
    const outcome = classify(page);
    for (const c of outcome.classifications) {
      const competitorType =
        c.type === REGION_TYPE.UNKNOWN
          ? c.candidates[0].type
          : c.candidates[1]?.type ?? c.candidates[0].type;
      const expectedPrimary = c.explanation.filter((ev) => ev.supports === c.type);
      const expectedSecondary = c.explanation.filter(
        (ev) => ev.supports === competitorType
      );
      equal(
        c.primaryEvidence.length,
        expectedPrimary.length,
        `primary size for ${c.regionId}`
      );
      equal(
        c.secondaryEvidence.length,
        expectedSecondary.length,
        `secondary size for ${c.regionId}`
      );
      for (const ev of c.primaryEvidence) {
        equal(ev.supports, c.type, `primary supports winner for ${c.regionId}`);
      }
      for (const ev of c.secondaryEvidence) {
        equal(
          ev.supports,
          competitorType,
          `secondary supports the competitor for ${c.regionId}`
        );
      }
    }
  }
});

test("a custom composite policy is honored", () => {
  const policy: CompositeScorePolicy = (c) => c.geometric;
  const outcome = classifyRegions(
    buildRegionHierarchy(INVOICE_PAGE),
    [],
    { confidencePolicy: policy }
  );
  for (const c of outcome.classifications) {
    approx(c.confidence.aggregate.min, c.topScore);
    approx(c.confidence.aggregate.max, c.topScore);
  }
});

// ─── Adaptive thresholds ─────────────────────────────────────────────────────

test("thresholds derive from the page's own feature distribution", () => {
  const outcome = classify(INVOICE_PAGE);
  equal(outcome.thresholdSets.length, 1);
  const set = outcome.thresholdSets[0];
  equal(set.pageIndex, 0);
  equal(set.regionCount, 4);
  const width = set.statistics.stats["medianWidthRatio"];
  equal(width.sampleCount, 4);
  equal(width.method, "median");
  ok(set.statistics.stats["q25CenterY"] !== undefined);
  ok(set.statistics.stats["q75CenterY"] !== undefined);
  ok(Number.isFinite(set.decisions.unknownThreshold));
  ok(set.decisions.unknownThreshold > 0);
  equal(set.fallbacks.length, 0, "no silent fallbacks on a real page");
});

test("an empty page records fallback thresholds", () => {
  const empty: ScenarioPage = {
    id: "empty",
    bbox: { x: 0, y: 0, width: 600, height: 800 },
    regions: [],
  };
  const outcome = classify(empty);
  equal(outcome.classifications.length, 0);
  equal(outcome.thresholdSets.length, 1);
  const set = outcome.thresholdSets[0];
  ok(set.fallbacks.includes("medianWidthRatio"));
  ok(set.fallbacks.includes("unknownThreshold"));
  ok(Number.isFinite(set.decisions.unknownThreshold));
});

// ─── Determinism and geometry-only reasoning ─────────────────────────────────

test("identical input reproduces identical classifications", () => {
  for (const page of REQUIRED_SCENARIOS) {
    equal(
      JSON.stringify(classify(page)),
      JSON.stringify(classify(page)),
      `deterministic rebuild for ${page.id}`
    );
  }
});

test("same geometry with different ids classifies identically", () => {
  for (const page of [...REQUIRED_SCENARIOS, SIGNATURE_PAGE]) {
    const original = classify(page);
    const renamed = classify(renameScenarioIds(page, "x"));
    equal(
      renamed.classifications.map((c) => c.regionId),
      page.regions.map((r) => `x-${r.id}`)
    );
    for (let i = 0; i < original.classifications.length; i++) {
      equal(
        renamed.classifications[i].type,
        original.classifications[i].type,
        `type invariance for ${page.id}`
      );
      approx(renamed.classifications[i].topScore, original.classifications[i].topScore);
    }
  }
});
