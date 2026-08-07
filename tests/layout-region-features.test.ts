/**
 * Milestone 5 region feature extraction — the geometry-only feature surface the
 * adaptive classifier reasons over. Tests cover page-relative ratios, content
 * statistics (density/whitespace), edge sharing (alignment/grid), nearest
 * neighbor isolation (including the degenerate medianNN == 0 case), sibling
 * containment, dominant orientation and the determinism/frozenness contract.
 */
import {
  extractPageRegionFeatures,
  readRegionFeature,
} from "@/lib/layout";
import type { RegionFeatureSet } from "@/lib/layout";
import type { LayoutBlock } from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";
import { buildRegionHierarchy, box } from "./layout-region-helpers.ts";
import { INVOICE_PAGE } from "./layout-region-scenarios.ts";
import type { ScenarioPage } from "./layout-region-scenarios.ts";

function approx(actual: number, expected: number, eps = 1e-9): void {
  ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} within ${eps}`
  );
}

function extract(page: ScenarioPage): readonly RegionFeatureSet[] {
  const hierarchy = buildRegionHierarchy(page);
  return extractPageRegionFeatures(hierarchy, hierarchy.get(page.id)!);
}

function feature(page: ScenarioPage, regionId: string): RegionFeatureSet {
  const features = extract(page);
  const found = features.find((f) => f.regionId === regionId);
  ok(found !== undefined, `region ${regionId} has a feature set`);
  return found!;
}

// ─── Shape of the output ─────────────────────────────────────────────────────

test("extracts one feature set per region in page order", () => {
  const features = extract(INVOICE_PAGE);
  equal(
    features.map((f) => f.regionId),
    ["header", "body", "table", "footer"]
  );
});

test("empty page yields no feature sets", () => {
  const page: ScenarioPage = { id: "empty", bbox: box(0, 0, 600, 800), regions: [] };
  equal(extract(page).length, 0);
});

// ─── Page-relative geometry ──────────────────────────────────────────────────

test("normalized position is page-relative", () => {
  const f = feature(INVOICE_PAGE, "header");
  const pos = f.normalizedPosition;
  approx(pos.x, 0);
  approx(pos.y, 10 / 800);
  approx(pos.right, 1);
  approx(pos.bottom, 30 / 800);
  approx(pos.centerX, 0.5);
  approx(pos.centerY, 20 / 800);
});

test("area, width and height ratios are page-relative", () => {
  const f = feature(INVOICE_PAGE, "header");
  approx(f.areaRatio, 12000 / 480000);
  approx(f.widthRatio, 1);
  approx(f.heightRatio, 20 / 800);
  approx(f.aspectRatio, 30);
});

test("word counts come from the hierarchy's Word descendants", () => {
  const f = feature(INVOICE_PAGE, "table");
  equal(f.wordCount, 70);
  equal(f.childCount, 7);
});

test("word counts come from block density metrics when blocks are supplied", () => {
  const hierarchy = buildRegionHierarchy(INVOICE_PAGE);
  const fakeBlock = {
    id: "hb",
    densityMetrics: {
      wordCount: 99,
      lineCount: 1,
      charCount: 999,
      area: 0,
      wordDensity: 0,
      lineDensity: 0,
    },
  } as unknown as LayoutBlock;
  const features = extractPageRegionFeatures(
    hierarchy,
    hierarchy.get("page-0")!,
    [fakeBlock]
  );
  const header = features.find((f) => f.regionId === "header")!;
  equal(header.wordCount, 99, "block density metrics override hierarchy words");
});

test("readRegionFeature reads nested position features", () => {
  const features = extract(INVOICE_PAGE);
  const header = features[0];
  approx(readRegionFeature(header, "normalizedPosition.centerY"), 20 / 800);
  approx(readRegionFeature(header, "normalizedPosition.right"), 1);
});

test("center offset measures the region's horizontal distance from center", () => {
  const page: ScenarioPage = {
    id: "p",
    bbox: box(0, 0, 600, 800),
    regions: [
      { id: "left", bbox: box(0, 0, 300, 100), blocks: [{ id: "lb", bbox: box(0, 0, 300, 100), wordCount: 4 }] },
      { id: "mid", bbox: box(200, 200, 200, 100), blocks: [{ id: "mb", bbox: box(200, 200, 200, 100), wordCount: 4 }] },
      { id: "off", bbox: box(500, 400, 100, 100), blocks: [{ id: "ob", bbox: box(500, 400, 100, 100), wordCount: 4 }] },
    ],
  };
  const features = extract(page);
  const left = features.find((f) => f.regionId === "left")!;
  const mid = features.find((f) => f.regionId === "mid")!;
  const off = features.find((f) => f.regionId === "off")!;
  approx(left.centerOffsetX, 0.25);
  approx(mid.centerOffsetX, 0);
  approx(off.centerOffsetX, Math.abs(0.9167 - 0.5), 1e-3);
  approx(readRegionFeature(left, "centerOffsetX"), 0.25);
});

// ─── Content statistics ──────────────────────────────────────────────────────

test("whitespace ratio reflects content coverage", () => {
  const page: ScenarioPage = {
    id: "p",
    bbox: box(0, 0, 600, 800),
    regions: [
      { id: "full", bbox: box(0, 0, 600, 100), blocks: [{ id: "fb", bbox: box(0, 0, 600, 100), wordCount: 10 }] },
      { id: "band", bbox: box(0, 200, 600, 100), blocks: [{ id: "bb", bbox: box(100, 240, 200, 20), wordCount: 4 }] },
    ],
  };
  const features = extract(page);
  const full = features.find((f) => f.regionId === "full")!;
  const band = features.find((f) => f.regionId === "band")!;
  approx(full.whitespaceRatio, 0);
  approx(band.whitespaceRatio, 1 - 4000 / 60000);
});

test("density is words per unit area", () => {
  const f = feature(INVOICE_PAGE, "header");
  approx(f.density, 8 / 12000);
});

test("page coverage is the content footprint over the page area", () => {
  const page: ScenarioPage = {
    id: "p",
    bbox: box(0, 0, 600, 800),
    regions: [
      { id: "body", bbox: box(0, 0, 600, 500), blocks: [{ id: "bb", bbox: box(0, 0, 600, 500), wordCount: 90 }] },
    ],
  };
  const f = feature(page, "body");
  approx(f.pageCoverage, 300000 / 480000);
  equal(f.pageArea, 480000);
  equal(f.regionArea, 300000);
});

// ─── Edge sharing ────────────────────────────────────────────────────────────

test("alignment score counts shared vertical edges", () => {
  const page: ScenarioPage = {
    id: "p",
    bbox: box(0, 0, 600, 800),
    regions: [
      { id: "a", bbox: box(0, 0, 100, 100), blocks: [{ id: "ab", bbox: box(0, 0, 100, 100), wordCount: 5 }] },
      { id: "b", bbox: box(0, 200, 100, 100), blocks: [{ id: "bb", bbox: box(0, 200, 100, 100), wordCount: 5 }] },
    ],
  };
  const features = extract(page);
  for (const f of features) approx(f.alignmentScore, 1);
});

test("grid score counts shared horizontal edges", () => {
  const page: ScenarioPage = {
    id: "p",
    bbox: box(0, 0, 600, 800),
    regions: [
      { id: "a", bbox: box(0, 0, 100, 100), blocks: [{ id: "ab", bbox: box(0, 0, 100, 100), wordCount: 5 }] },
      { id: "b", bbox: box(200, 0, 100, 100), blocks: [{ id: "bb", bbox: box(200, 0, 100, 100), wordCount: 5 }] },
    ],
  };
  const features = extract(page);
  for (const f of features) approx(f.gridScore, 1);
});

// ─── Isolation ───────────────────────────────────────────────────────────────

test("isolated regions get a high isolation score", () => {
  const f = feature(INVOICE_PAGE, "header");
  const body = feature(INVOICE_PAGE, "body");
  // body far from everything else; nearest neighbors at the page edges
  ok(body.isolationScore >= 0.4, `body isolation ${body.isolationScore}`);
  ok(f.isolationScore >= 0.2, `header isolation ${f.isolationScore}`);
});

test("isolation stays ratio-based when the median NN distance is zero", () => {
  const page: ScenarioPage = {
    id: "p",
    bbox: box(0, 0, 600, 800),
    regions: [
      { id: "a", bbox: box(0, 0, 100, 100), blocks: [{ id: "ab", bbox: box(0, 0, 100, 100), wordCount: 2 }] },
      { id: "b", bbox: box(0, 0, 100, 100), blocks: [{ id: "bb", bbox: box(0, 0, 100, 100), wordCount: 2 }] },
      { id: "c", bbox: box(200, 200, 100, 100), blocks: [{ id: "cb", bbox: box(200, 200, 100, 100), wordCount: 2 }] },
      { id: "d", bbox: box(200, 200, 100, 100), blocks: [{ id: "db", bbox: box(200, 200, 100, 100), wordCount: 2 }] },
    ],
  };
  const features = extract(page);
  for (const f of features) {
    equal(f.isolationScore, 0, "coincident pairs are not isolated");
  }
});

// ─── Containment ─────────────────────────────────────────────────────────────

test("containment score reflects sibling overlap", () => {
  const page: ScenarioPage = {
    id: "p",
    bbox: box(0, 0, 600, 800),
    regions: [
      { id: "outer", bbox: box(0, 0, 200, 200), blocks: [{ id: "ob", bbox: box(0, 0, 200, 200), wordCount: 8 }] },
      { id: "inner", bbox: box(50, 50, 100, 100), blocks: [{ id: "ib", bbox: box(50, 50, 100, 100), wordCount: 4 }] },
    ],
  };
  const features = extract(page);
  const outer = features.find((f) => f.regionId === "outer")!;
  const inner = features.find((f) => f.regionId === "inner")!;
  approx(outer.containmentScore, 10000 / 40000);
  approx(inner.containmentScore, 1);
});

// ─── Orientation ─────────────────────────────────────────────────────────────

test("dominant block orientation follows the children", () => {
  const page: ScenarioPage = {
    id: "p",
    bbox: box(0, 0, 600, 800),
    regions: [
      { id: "hor", bbox: box(0, 0, 300, 100), blocks: [{ id: "hb", bbox: box(0, 0, 300, 100), wordCount: 5 }] },
      { id: "ver", bbox: box(0, 200, 100, 300), blocks: [{ id: "vb", bbox: box(0, 200, 100, 300), wordCount: 5 }] },
      { id: "sq", bbox: box(0, 500, 100, 100), blocks: [{ id: "sb", bbox: box(0, 500, 100, 100), wordCount: 5 }] },
      { id: "none", bbox: box(300, 500, 100, 100), blocks: [] },
    ],
  };
  const features = extract(page);
  equal(features.find((f) => f.regionId === "hor")!.dominantBlockOrientation, "horizontal");
  equal(features.find((f) => f.regionId === "ver")!.dominantBlockOrientation, "vertical");
  equal(features.find((f) => f.regionId === "sq")!.dominantBlockOrientation, "square");
  equal(features.find((f) => f.regionId === "none")!.dominantBlockOrientation, "none");
});

// ─── Determinism and immutability ────────────────────────────────────────────

test("identical input reproduces identical features", () => {
  const a = extract(INVOICE_PAGE);
  const b = extract(INVOICE_PAGE);
  equal(JSON.stringify(a), JSON.stringify(b));
});

test("feature output is deep-frozen", () => {
  const features = extract(INVOICE_PAGE);
  ok(Object.isFrozen(features));
  for (const f of features) {
    ok(Object.isFrozen(f));
    ok(Object.isFrozen(f.normalizedPosition));
  }
});
