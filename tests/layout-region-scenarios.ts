/**
 * Shared Milestone 5 region-classification scenarios — exact region geometry
 * so the adaptive classifier's decisions are fully controlled. The page bbox
 * is always 600×800 and every region carries explicit blocks with word counts
 * (word counts only matter through density; text itself is never inspected).
 */
import type { BBox } from "@/lib/pipeline/types";
import { box } from "./layout-region-helpers.ts";
import type { RegionSpec } from "./layout-region-helpers.ts";

export interface ScenarioPage {
  readonly id: string;
  readonly bbox: BBox;
  readonly regions: readonly RegionSpec[];
}

function page(
  id: string,
  bbox: BBox,
  regions: RegionSpec[]
): ScenarioPage {
  return { id, bbox, regions };
}

const PAGE_600X800 = box(0, 0, 600, 800);

// ─── Required scenarios ──────────────────────────────────────────────────────

// invoice: header / body / table / footer
export const INVOICE_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "header", bbox: box(0, 10, 600, 20), blocks: [{ id: "hb", bbox: box(0, 10, 600, 20), wordCount: 8 }] },
  { id: "body", bbox: box(0, 60, 600, 360), blocks: [{ id: "bb", bbox: box(0, 60, 600, 360), wordCount: 60 }] },
  {
    id: "table",
    bbox: box(0, 460, 600, 140),
    blocks: [
      { id: "t0", bbox: box(0, 460, 600, 20), wordCount: 10 },
      { id: "t1", bbox: box(0, 480, 600, 20), wordCount: 10 },
      { id: "t2", bbox: box(0, 500, 600, 20), wordCount: 10 },
      { id: "t3", bbox: box(0, 520, 600, 20), wordCount: 10 },
      { id: "t4", bbox: box(0, 540, 600, 20), wordCount: 10 },
      { id: "t5", bbox: box(0, 560, 600, 20), wordCount: 10 },
      { id: "t6", bbox: box(0, 580, 600, 20), wordCount: 10 },
    ],
  },
  { id: "footer", bbox: box(0, 700, 600, 20), blocks: [{ id: "fb", bbox: box(0, 700, 600, 20), wordCount: 6 }] },
]);

// centered header + body + footer
export const CENTERED_HEADER_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "chead", bbox: box(120, 10, 360, 20), blocks: [{ id: "chb", bbox: box(120, 10, 360, 20), wordCount: 6 }] },
  { id: "body", bbox: box(0, 60, 600, 500), blocks: [{ id: "bb", bbox: box(0, 60, 600, 500), wordCount: 90 }] },
  { id: "footer", bbox: box(0, 700, 600, 20), blocks: [{ id: "fb", bbox: box(0, 700, 600, 20), wordCount: 6 }] },
]);

// footer scenario: header / body / dense footer
export const FOOTER_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "header", bbox: box(0, 0, 600, 20), blocks: [{ id: "hb", bbox: box(0, 0, 600, 20), wordCount: 8 }] },
  { id: "body", bbox: box(0, 40, 600, 560), blocks: [{ id: "bb", bbox: box(0, 40, 600, 560), wordCount: 120 }] },
  { id: "footer", bbox: box(0, 700, 600, 16), blocks: [{ id: "fb", bbox: box(0, 700, 600, 16), wordCount: 4 }] },
]);

// sidebar layout: big body + narrow right rail
export const SIDEBAR_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "body", bbox: box(0, 0, 440, 800), blocks: [{ id: "bb", bbox: box(0, 0, 440, 800), wordCount: 120 }] },
  { id: "rail", bbox: box(480, 0, 120, 800), blocks: [{ id: "rb", bbox: box(480, 0, 120, 800), wordCount: 12 }] },
]);

// multi-column: two equal columns
export const MULTI_COLUMN_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "colA", bbox: box(0, 0, 280, 800), blocks: [{ id: "ab", bbox: box(0, 0, 280, 800), wordCount: 60 }] },
  { id: "colB", bbox: box(320, 0, 280, 800), blocks: [{ id: "bb", bbox: box(320, 0, 280, 800), wordCount: 60 }] },
]);

// single receipt: narrow shop header / line items / total / footer
export const RECEIPT_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "shop", bbox: box(150, 10, 300, 24), blocks: [{ id: "sb", bbox: box(150, 10, 300, 24), wordCount: 6 }] },
  { id: "line1", bbox: box(40, 80, 520, 20), blocks: [{ id: "l1", bbox: box(40, 80, 520, 20), wordCount: 8 }] },
  { id: "line2", bbox: box(40, 100, 520, 20), blocks: [{ id: "l2", bbox: box(40, 100, 520, 20), wordCount: 8 }] },
  { id: "line3", bbox: box(40, 120, 520, 20), blocks: [{ id: "l3", bbox: box(40, 120, 520, 20), wordCount: 8 }] },
  { id: "total", bbox: box(40, 160, 520, 20), blocks: [{ id: "tt", bbox: box(40, 160, 520, 20), wordCount: 4 }] },
  { id: "footer", bbox: box(0, 740, 600, 16), blocks: [{ id: "fb", bbox: box(0, 740, 600, 16), wordCount: 4 }] },
]);

// contract: centered title / dense clauses / signature line / footer
export const CONTRACT_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "title", bbox: box(150, 20, 300, 20), blocks: [{ id: "tb", bbox: box(150, 20, 300, 20), wordCount: 4 }] },
  { id: "clause1", bbox: box(50, 60, 500, 120), blocks: [{ id: "c1", bbox: box(50, 60, 500, 120), wordCount: 60 }] },
  { id: "clause2", bbox: box(50, 200, 500, 120), blocks: [{ id: "c2", bbox: box(50, 200, 500, 120), wordCount: 60 }] },
  { id: "clause3", bbox: box(50, 340, 500, 120), blocks: [{ id: "c3", bbox: box(50, 340, 500, 120), wordCount: 60 }] },
  { id: "sig", bbox: box(50, 690, 500, 40), blocks: [{ id: "sgb", bbox: box(200, 705, 200, 10), wordCount: 3 }] },
  { id: "footer", bbox: box(0, 760, 600, 12), blocks: [{ id: "fb", bbox: box(0, 760, 600, 12), wordCount: 3 }] },
]);

// dense page: one large dense block + footer
export const DENSE_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "body", bbox: box(0, 0, 600, 640), blocks: [{ id: "bb", bbox: box(0, 0, 600, 640), wordCount: 400 }] },
  { id: "footer", bbox: box(0, 660, 600, 16), blocks: [{ id: "fb", bbox: box(0, 660, 600, 16), wordCount: 4 }] },
]);

// sparse: three small far-apart full-width rows
export const SPARSE_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "r0", bbox: box(0, 0, 600, 20), blocks: [{ id: "b0", bbox: box(0, 0, 600, 20), wordCount: 6 }] },
  { id: "r1", bbox: box(0, 300, 600, 20), blocks: [{ id: "b1", bbox: box(0, 300, 600, 20), wordCount: 6 }] },
  { id: "r2", bbox: box(0, 600, 600, 20), blocks: [{ id: "b2", bbox: box(0, 600, 600, 20), wordCount: 6 }] },
]);

// stamp: body + compact isolated corner blob
export const STAMP_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "body", bbox: box(0, 0, 440, 700), blocks: [{ id: "bb", bbox: box(0, 0, 440, 700), wordCount: 100 }] },
  { id: "stamp", bbox: box(500, 100, 80, 80), blocks: [{ id: "sb", bbox: box(500, 100, 80, 80), wordCount: 8 }] },
]);

// annotation: body + small margin note
export const ANNOTATION_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "body", bbox: box(0, 0, 440, 700), blocks: [{ id: "bb", bbox: box(0, 0, 440, 700), wordCount: 100 }] },
  { id: "note", bbox: box(470, 200, 120, 40), blocks: [{ id: "nb", bbox: box(470, 200, 120, 40), wordCount: 5 }] },
]);

// unknown layout: body + sections + an incoherent mid band + sig + footer
export const UNKNOWN_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "body", bbox: box(0, 0, 600, 600), blocks: [{ id: "bb", bbox: box(0, 0, 600, 600), wordCount: 300 }] },
  { id: "sec1", bbox: box(0, 0, 600, 120), blocks: [{ id: "s1", bbox: box(0, 0, 600, 120), wordCount: 60 }] },
  { id: "sec2", bbox: box(0, 120, 600, 120), blocks: [{ id: "s2", bbox: box(0, 120, 600, 120), wordCount: 60 }] },
  {
    id: "target",
    bbox: box(0, 600, 600, 140),
    blocks: [
      { id: "x0", bbox: box(0, 600, 90, 20), wordCount: 1 },
      { id: "x1", bbox: box(100, 600, 90, 20), wordCount: 1 },
      { id: "x2", bbox: box(200, 600, 90, 20), wordCount: 1 },
      { id: "x3", bbox: box(300, 600, 90, 20), wordCount: 1 },
      { id: "x4", bbox: box(400, 600, 90, 20), wordCount: 1 },
      { id: "x5", bbox: box(500, 600, 90, 20), wordCount: 1 },
    ],
  },
  { id: "sig", bbox: box(0, 740, 600, 40), blocks: [{ id: "sgb", bbox: box(150, 775, 300, 10), wordCount: 3 }] },
  { id: "foot", bbox: box(0, 780, 600, 16), blocks: [{ id: "fb", bbox: box(0, 780, 600, 16), wordCount: 4 }] },
]);

// ─── Bonus scenarios ─────────────────────────────────────────────────────────

// signature zone: body + mostly-blank bottom band
export const SIGNATURE_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "body", bbox: box(0, 0, 600, 500), blocks: [{ id: "bb", bbox: box(0, 0, 600, 500), wordCount: 100 }] },
  { id: "sig", bbox: box(0, 700, 600, 60), blocks: [{ id: "sgb", bbox: box(150, 715, 300, 10), wordCount: 3 }] },
]);

// form field: header / two sparse short bands / body / footer
export const FORM_FIELD_PAGE: ScenarioPage = page("page-0", PAGE_600X800, [
  { id: "header", bbox: box(0, 0, 600, 20), blocks: [{ id: "hb", bbox: box(0, 0, 600, 20), wordCount: 8 }] },
  { id: "f1", bbox: box(60, 80, 480, 12), blocks: [{ id: "f1b", bbox: box(260, 83, 280, 8), wordCount: 1 }] },
  { id: "f2", bbox: box(60, 100, 480, 12), blocks: [{ id: "f2b", bbox: box(260, 103, 280, 8), wordCount: 1 }] },
  { id: "body", bbox: box(0, 140, 600, 560), blocks: [{ id: "bb", bbox: box(0, 140, 600, 560), wordCount: 120 }] },
  { id: "footer", bbox: box(0, 760, 600, 16), blocks: [{ id: "fb", bbox: box(0, 760, 600, 16), wordCount: 4 }] },
]);

/** All required scenarios in the order they must classify correctly. */
export const REQUIRED_SCENARIOS: readonly ScenarioPage[] = [
  INVOICE_PAGE,
  CENTERED_HEADER_PAGE,
  FOOTER_PAGE,
  SIDEBAR_PAGE,
  MULTI_COLUMN_PAGE,
  RECEIPT_PAGE,
  CONTRACT_PAGE,
  DENSE_PAGE,
  SPARSE_PAGE,
  STAMP_PAGE,
  ANNOTATION_PAGE,
  UNKNOWN_PAGE,
];

/** Deep copy of a scenario with every id renamed (geometry unchanged). */
export function renameScenarioIds(
  source: ScenarioPage,
  prefix: string
): ScenarioPage {
  return {
    id: `${prefix}-${source.id}`,
    bbox: { ...source.bbox },
    regions: source.regions.map((r) => ({
      id: `${prefix}-${r.id}`,
      bbox: { ...r.bbox },
      blocks: r.blocks.map((b) => ({
        id: `${prefix}-${b.id}`,
        bbox: { ...b.bbox },
        wordCount: b.wordCount,
      })),
    })),
  };
}
