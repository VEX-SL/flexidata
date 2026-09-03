/**
 * Milestone 13 — NA-aware confidence regression tests.
 *
 * Proves the corrected presence semantics end to end:
 *   - `combineConfidence` averages only measured dimensions (the six-invariant
 *     matrix), so an OCR-only line scores its OCR confidence instead of 1/6;
 *   - measured zeros are real readings, never silently treated as absent;
 *   - presence propagates up every hierarchy level (word → line → block →
 *     region → page → document) through the propagation engine;
 *   - the real SuperPay receipt is no longer diluted to ~0.128 and its
 *     merchant_name survives grounding (> MIN_CONFIDENCE 0.3).
 */
import {
  buildLayoutAwareEvidence,
  combineConfidence,
  createLayoutEvidenceProvider,
  layoutReaderFor,
} from "@/lib/extraction/layout-aware-evidence";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  LayoutHierarchy,
  NODE_LEVEL,
  createConfidenceComponents,
  createConfidenceProfile,
  createHierarchyNode,
  propagateConfidence,
} from "@/lib/layout";
import type {
  ConfidenceComponents,
  ConfidenceProfile,
  HierarchyLevel,
} from "@/lib/layout";
import { unionBoxes } from "@/lib/pipeline/geometry";
import type {
  ExtractionProfile,
  FieldSchema,
  OcrDocument,
  OcrLine,
  OcrWord,
} from "@/lib/pipeline/types";
import { equal, ok, test } from "./harness.ts";

function approx(
  actual: number,
  expected: number,
  eps = 1e-9,
  msg?: string
): void {
  ok(
    Math.abs(actual - expected) <= eps,
    msg ?? `expected ${actual} ≈ ${expected} within ${eps}`
  );
}

function comps(values: Partial<ConfidenceComponents> = {}): ConfidenceComponents {
  return createConfidenceComponents(values);
}

function prof(samples: readonly ConfidenceComponents[]): ConfidenceProfile {
  return createConfidenceProfile(samples);
}

// ─── combineConfidence invariant matrix ─────────────────────────────────────

test("combineConfidence: OCR measured + 5 NA averages only OCR", () => {
  const profile = prof([comps({ ocr: 0.768 })]);
  approx(combineConfidence(profile), 0.768, 1e-9, "not 0.768 / 6");
});

test("combineConfidence: a measured zero is a zero, not an absent component", () => {
  const profile = prof([comps({ ocr: 0 })]);
  equal(combineConfidence(profile), 0, "measured OCR=0 stays 0");
  ok(profile.measured.ocr === true, "ocr presence is recorded");
});

test("combineConfidence: two measured dimensions average those two", () => {
  const profile = prof([comps({ ocr: 0.8, geometric: 0.6 })]);
  approx(combineConfidence(profile), 0.7, 1e-9);
});

test("combineConfidence: the four absent dimensions never dilute a measured pair", () => {
  const profile = prof([comps({ ocr: 0.8, geometric: 0.6 })]);
  approx(combineConfidence(profile), 0.7, 1e-9, "same as with only two samples");
  ok(profile.measured.structural === false, "structural stays absent");
  ok(profile.measured.boundary === false, "boundary stays absent");
  ok(profile.measured.typological === false, "typological stays absent");
  ok(profile.measured.order === false, "order stays absent");
});

test("combineConfidence: all six genuinely measured keeps the six-way mean", () => {
  const profile = prof([
    comps({
      ocr: 0.9,
      geometric: 0.7,
      structural: 0.6,
      boundary: 0.5,
      typological: 0.4,
      order: 0.3,
    }),
  ]);
  const sixWayMean =
    (0.9 + 0.7 + 0.6 + 0.5 + 0.4 + 0.3) / 6;
  approx(combineConfidence(profile), sixWayMean, 1e-9, "unchanged behavior");
});

test("combineConfidence: an entirely unmeasured profile is neutral zero", () => {
  const profile = prof([comps()]);
  equal(combineConfidence(profile), 0);
});

// ─── Presence propagation across hierarchy levels ───────────────────────────

interface Spec {
  id: string;
  level: HierarchyLevel;
  parent: string | null;
  profile: ConfidenceProfile;
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
        bbox: { x: 0, y: 0, width: 100, height: 20 },
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

function W(id: string, ocr: number, parent: string): Spec {
  return { id, level: NODE_LEVEL.WORD, parent, profile: prof([comps({ ocr })]), children: [] };
}

test("presence propagates bottom-up so an OCR-only chain keeps its OCR confidence", () => {
  const h = tree([
    rootSpec(["page"]),
    P("page", ["region"]),
    R("region", ["block"], "page"),
    B("block", ["line"], "region"),
    L("line", ["w1", "w2", "w3"], "block"),
    W("w1", 0.768, "line"),
    W("w2", 0.768, "line"),
    W("w3", 0.768, "line"),
  ]);
  const p = propagateConfidence(h);
  for (const id of ["line", "block", "region", "page", "document"]) {
    const profile = p.get(id)!;
    approx(combineConfidence(profile), 0.768, 1e-9, `${id} combine`);
    ok(profile.measured.ocr === true, `${id} ocr measured`);
    ok(profile.measured.geometric === false, `${id} geometric absent`);
    ok(profile.measured.structural === false, `${id} structural absent`);
    ok(profile.measured.boundary === false, `${id} boundary absent`);
    ok(profile.measured.typological === false, `${id} typological absent`);
    ok(profile.measured.order === false, `${id} order absent`);
  }
});

test("presence union: a component stays measured when any child measured it", () => {
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
      profile: prof([comps({ ocr: 0.9, order: 0.6 })]),
      children: [],
    },
    { id: "w2", level: NODE_LEVEL.WORD, parent: "line", profile: prof([comps({ ocr: 0.5 })]), children: [] },
  ]);
  const p = propagateConfidence(h);
  const line = p.get("line")!;
  ok(line.measured.ocr === true, "ocr measured by both children");
  ok(line.measured.order === true, "order measured because one child measured it");
  ok(line.measured.geometric === false, "geometric measured by nobody");
  // Per-component means average over ALL children (unmeasured ones count as
  // zero): ocr (0.9+0.5)/2 = 0.7, order 0.6×0.5 = 0.3. The measured union
  // {ocr, order} selects which means enter the equal-weight composite.
  approx(combineConfidence(line), (0.7 + 0.3) / 2, 1e-9, "mean over measured union");
});

// ─── Real layout pipeline + SuperPay grounding regression ───────────────────

function mkWord(text: string, x: number, y: number, c = 0.768): OcrWord {
  return { text, confidence: c, bbox: { x, y, width: 30, height: 12 } };
}

function mkLine(y: number, words: readonly OcrWord[]): OcrLine {
  const bbox = unionBoxes(words.map((w) => w.bbox!))!;
  return { text: words.map((w) => w.text).join(" "), words: [...words], bbox };
}

function mkDoc(lines: readonly string[], conf: number): OcrDocument {
  const out: OcrLine[] = [];
  lines.forEach((text, li) => {
    const y = li * 16;
    const words = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w, wi) => mkWord(w, wi * 40, y, conf));
    out.push(mkLine(y, words));
  });
  return { text: lines.join("\n"), lines: out };
}

/** Real SuperPay receipt OCR (M13): the merchant line carries the value. */
function superpayDoc(): OcrDocument {
  return mkDoc(
    ["RECEIPT", "له SuperPay 60", "TOTAL", "38.40"],
    0.768
  );
}

test("SuperPay regression: layout evidence confidence is the OCR confidence, not the diluted sixth", () => {
  const reader = layoutReaderFor(superpayDoc());
  ok(reader.isLayoutAvailable, "layout must build for the receipt");
  const { evidence } = buildLayoutAwareEvidence(
    reader,
    { key: "merchant_name", type: "string" },
    ["merchant_name", "SuperPay"]
  );
  ok(evidence.length >= 1, "merchant evidence found");
  approx(evidence[0].confidence, 0.768, 1e-6, "combineConfidence keeps OCR 0.768");
  ok(evidence[0].confidence > 0.5, "was ~0.128 before M13 (five-way NA dilution)");
});

test("SuperPay regression: merchant_name survives grounding above MIN_CONFIDENCE", () => {
  const doc = superpayDoc();
  const profile = mkProfile([{ key: "merchant_name", type: "string" }]);
  const extraction = mkExtraction(profile, { merchant_name: "SuperPay" });
  const out = groundExtraction(
    profile,
    extraction,
    doc.text,
    doc,
    createLayoutEvidenceProvider(layoutReaderFor(doc))
  );
  ok(out.fieldsMap.merchant_name !== undefined, "merchant_name survived grounding");
  ok(out.droppedFields.merchant_name === undefined, "no drop reason attached");
  const confidence = out.fieldsMap.merchant_name!.confidence!;
  // aiConf 0.9 × ocrFactor 0.768 × labelNeutral 0.92 ≈ 0.636 > 0.3.
  approx(confidence, 0.9 * 0.768 * 0.92, 1e-6, "composed confidence");
  ok(confidence >= 0.3, "above the drop threshold (was 0.9 × 0.128 × 0.8 ≈ 0.092)");
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function mkProfile(fields: FieldSchema[]): ExtractionProfile {
  return {
    id: "test-profile",
    label: "Test profile",
    docTypes: ["test"],
    schema: { version: 1, fields },
    promptTemplate: "Extract from: {{document}}\nSchema: {{schema}}",
    validationRules: [],
    exportConfig: { formats: ["json"] },
    version: 1,
  } as ExtractionProfile;
}

function mkExtraction(
  profile: ExtractionProfile,
  values: Record<string, unknown>
): ExtractionResult {
  const fieldsMap: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(values)) {
    fieldsMap[key] = {
      value,
      rawValue: value,
      confidence: 0.9,
      source: "ai",
      status: "extracted",
    };
  }
  return {
    profileType: profile.id as ExtractionResult["profileType"],
    profileVersion: profile.version,
    fields: [],
    fieldsMap,
    cleanFields: { ...values },
    droppedFields: {},
    model: "fake",
    provider: "test",
  };
}
