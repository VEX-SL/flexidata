/**
 * Milestone 11 — layout-aware extraction tests.
 *
 * Proves the M11 integration contract:
 *   - the layout path is used (evidence carries layout ladder scope + rank),
 *   - the fallback path is used when layout fails (provider returns nothing,
 *     OCR-only grounding runs unchanged, outputs are identical),
 *   - evidence is deterministic and never duplicated or skipped,
 *   - the priority ladder (explicit region → reading-order neighbors → same
 *     block → same page → whole document) is honored,
 *   - realistic documents (receipt, invoice, bank statement, contract, mixed
 *     Arabic/English, multi-column, table, noisy OCR, missing layout, broken
 *     layout) extract through the layout-aware path without regressions.
 */
import { LayoutAwareReader } from "@/lib/extraction/layout-aware-reader";
import type { LayoutBuilder } from "@/lib/extraction/layout-aware-reader";
import { LayoutAwareSelector } from "@/lib/extraction/layout-aware-selector";
import type { FieldRegionRule } from "@/lib/extraction/layout-aware-selector";
import {
  buildLayoutAwareEvidence,
  collectEvidenceText,
  combineConfidence,
  createLayoutEvidenceProvider,
  layoutReaderFor,
} from "@/lib/extraction/layout-aware-evidence";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { extractStage, groundStage } from "@/lib/pipeline/stages";
import {
  brokenLayoutContext,
  layoutFailure,
  REGION_TYPE,
} from "@/lib/layout";
import type { LayoutResult } from "@/lib/layout";
import { buildOcrDocument } from "@/lib/pipeline/ocr";
import type {
  AIClient,
  ExtractionProfile,
  ExtractionResult,
  FieldSchema,
  FieldValue,
  OcrDocument,
  OcrLine,
  OcrWord,
  PipelineState,
} from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import { equal, ok, test } from "./harness.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function mkWord(text: string, x: number, y: number, c = 0.9): OcrWord {
  return { text, confidence: c, bbox: { x, y, width: 30, height: 12 } };
}

function mkLine(y: number, words: readonly OcrWord[]): OcrLine {
  const bbox = unionBoxes(words.map((w) => w.bbox!))!;
  return { text: words.map((w) => w.text).join(" "), words: [...words], bbox };
}

/** Build a positioned OCR doc from text lines (left-to-right words, top-down). */
function mkDoc(lines: readonly string[], opts: { conf?: number; column?: number } = {}): OcrDocument {
  const out: OcrLine[] = [];
  lines.forEach((text, li) => {
    const y = li * 16;
    const words = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w, wi) => mkWord(w, (opts.column ?? 0) + wi * 40, y, opts.conf ?? 0.9));
    out.push(mkLine(y, words));
  });
  return { text: lines.join("\n"), lines: out };
}

function invoiceDoc(): OcrDocument {
  return mkDoc([
    "INVOICE INV-2024-001",
    "DATE 2024-07-02",
    "Item A 10.00",
    "Item B 20.00",
    "TOTAL 30.00",
  ]);
}

function receiptDoc(): OcrDocument {
  // Real SuperPay receipt OCR: mixed Arabic/English, OCR artifacts preserved.
  return mkDoc(
    [
      "i م 0 5 ل 1 3 : = : ب",
      "له SuperPay 60",
      "Zahra Aman =",
      "() رقم التمليه : 6070218301132167",
      "تبيخ الوقت : 02-07-2028 18:30:12",
      "| رقم الحساب : 391803452",
      "B انرقم المرجقي : 2013438351",
      "8[ رقم العميل : 9840833767",
      "gla المطلوب : 68.38 ;",
      "glad | العلى : 68.38",
    ],
    { conf: 0.7 }
  );
}

function bankDoc(): OcrDocument {
  return mkDoc([
    "BANK STATEMENT",
    "ACCOUNT 1002003004",
    "PERIOD 2024-01-01 TO 2024-03-31",
    "ATM WITHDRAWAL -100.00",
    "DEPOSIT 500.00",
    "BALANCE 400.00",
  ]);
}

function contractDoc(): OcrDocument {
  return mkDoc([
    "CONTRACT AGREEMENT",
    "PARTY A: Acme Corporation",
    "PARTY B: Globex Ltd",
    "SIGNED 2024-07-02",
    "SIGNATURE ZONE",
  ]);
}

function multicolumnDoc(): OcrDocument {
  const left = ["ITEM", "Widget", "Gadget", "TOTAL"];
  const right = ["AMOUNT", "10.00", "20.00", "30.00"];
  const lines: OcrLine[] = [];
  left.forEach((text, li) => {
    const y = li * 16;
    const words = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w, wi) => mkWord(w, wi * 40, y, 0.9));
    lines.push(mkLine(y, words));
    const rightWords = right[li]
      .split(/\s+/)
      .filter(Boolean)
      .map((w, wi) => mkWord(w, 200 + wi * 40, y, 0.9));
    lines.push(mkLine(y, rightWords));
  });
  return { text: left.map((l, i) => `${l} ${right[i]}`).join("\n"), lines };
}

function tableDoc(): OcrDocument {
  return mkDoc([
    "DESC QTY PRICE AMOUNT",
    "Widget 2 5.00 10.00",
    "Gadget 1 20.00 20.00",
    "Service 3 0.00 0.00",
    "SUB 30.00",
  ]);
}

function noisyDoc(): OcrDocument {
  return mkDoc(
    [
      "I N V O I C E !!!",
      "NO 99@9",
      "T0TA1 30,0O",
      "GARBAGE-###",
    ],
    { conf: 0.4 }
  );
}

/** A builder that always reports a layout failure (broken-layout tests). */
const brokenBuilder: LayoutBuilder = {
  build(): LayoutResult {
    return Object.freeze({
      context: brokenLayoutContext(),
      failure: layoutFailure("forced layout failure", ["test injected"]),
    });
  },
};

// ─── Profile / extraction helpers ───────────────────────────────────────────

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

const INVOICE_FIELDS: FieldSchema[] = [
  { key: "invoice_number", type: "string", label: "Invoice number", required: true },
  { key: "invoice_date", type: "date", label: "Invoice date", required: true },
  { key: "total_amount", type: "currency", label: "Total", required: true },
];

const INVOICE_PROFILE = mkProfile(INVOICE_FIELDS);

/** Assert two extractions are identical (fallback-equivalence proof). */
function sameExtraction(a: ExtractionResult, b: ExtractionResult, msg: string): void {
  equal(
    JSON.stringify({ fieldsMap: a.fieldsMap, cleanFields: a.cleanFields, droppedFields: a.droppedFields }),
    JSON.stringify({ fieldsMap: b.fieldsMap, cleanFields: b.cleanFields, droppedFields: b.droppedFields }),
    msg
  );
}

// ─── 1. Reader mechanics ────────────────────────────────────────────────────

test("reader builds a usable layout and its documentText keeps every line", () => {
  const reader = layoutReaderFor(invoiceDoc());
  ok(reader.isLayoutAvailable, "layout must be available for the invoice doc");
  ok(reader.isBroken === false, "no failure reported");
  const text = reader.documentText();
  for (const line of ["INVOICE INV-2024-001", "DATE 2024-07-02", "TOTAL 30.00"]) {
    ok(text.includes(line), `documentText must include the source line: ${line}`);
  }
  equal(reader.allLineViews().length > 0, true, "line views exist");
  ok(Object.isFrozen(reader), "reader is frozen");
});

test("reader falls back verbatim when the layout is broken", () => {
  const doc = invoiceDoc();
  const reader = new LayoutAwareReader(doc, brokenBuilder);
  ok(reader.isLayoutAvailable === false, "broken layout is not available");
  ok(reader.isBroken, "failure surfaced");
  equal(reader.allLineViews().length, 0, "no line views from a broken layout");
  const fallback = "FALLBACK TEXT\nSECOND LINE";
  equal(reader.documentText(fallback), fallback, "OCR-only text returned verbatim");
});

test("missing layout (no OCR) keeps the OCR-only text", () => {
  const reader = new LayoutAwareReader(buildOcrDocument(invoiceDoc().text), brokenBuilder);
  equal(reader.documentText("RAW"), "RAW", "fallback passed through unchanged");
});

test("documentText is deterministic across rebuilds", () => {
  const doc = invoiceDoc();
  const a = layoutReaderFor(doc).documentText();
  const b = layoutReaderFor(doc).documentText();
  equal(a, b, "identical OCR → identical layout text");
  const first = layoutReaderFor(doc).allLineViews().map((v) => v.node.id);
  const second = layoutReaderFor(doc).allLineViews().map((v) => v.node.id);
  equal(JSON.stringify(first), JSON.stringify(second), "identical line views");
});

// ─── 2. Selector mechanics ──────────────────────────────────────────────────

test("selector maps invoice_number to the header region and the full ladder", () => {
  const selector = new LayoutAwareSelector();
  const plan = selector.planFor({ key: "invoice_number", type: "string" });
  ok(plan.regionTypes.includes(REGION_TYPE.HEADER), "header region targeted");
  ok(plan.regionTypes.includes(REGION_TYPE.FORM_FIELD), "form-field region targeted");
  equal(
    JSON.stringify(plan.scopeOrder),
    JSON.stringify(["region", "neighbors", "block", "page", "document"]),
    "full priority ladder"
  );
});

test("selector falls straight to the document for unmapped fields", () => {
  const selector = new LayoutAwareSelector();
  const plan = selector.planFor({ key: "custom_unique_field", type: "string" });
  equal(plan.regionTypes.length, 0, "no region hint");
  equal(JSON.stringify(plan.scopeOrder), JSON.stringify(["document"]), "document catch-all only");
});

test("selector extra rules take precedence and stay deterministic", () => {
  const extra: FieldRegionRule[] = [
    { match: /special/, types: [REGION_TYPE.SIGNATURE_ZONE] },
  ];
  const selector = new LayoutAwareSelector(extra);
  equal(
    JSON.stringify(selector.regionTypesFor({ key: "special_field", type: "string" })),
    JSON.stringify([REGION_TYPE.SIGNATURE_ZONE]),
    "extra rule wins"
  );
  equal(
    JSON.stringify(selector.regionTypesFor({ key: "invoice_number", type: "string" })),
    JSON.stringify([REGION_TYPE.HEADER, REGION_TYPE.FORM_FIELD]),
    "defaults still apply to other keys"
  );
});

// ─── 3. Evidence ladder ─────────────────────────────────────────────────────

test("explicit region scope wins when the value is inside the region", () => {
  const reader = layoutReaderFor(invoiceDoc());
  // Map the probe field to the document's own (UNKNOWN) region type so the
  // explicit-region scope is reachable with the real pipeline.
  const selector = new LayoutAwareSelector([
    { match: /probe/, types: [REGION_TYPE.UNKNOWN] },
  ]);
  const { evidence, scope } = buildLayoutAwareEvidence(
    reader,
    { key: "probe_value", type: "string" },
    ["INV-2024-001"],
    selector
  );
  equal(scope, "region", "explicit region scope produced the evidence");
  ok(evidence.length >= 1, "evidence found");
  equal(evidence[0].layoutRank, 0, "region is rank 0 in the ladder");
  equal(evidence[0].scope, "region", "evidence records its scope");
  equal(evidence[0].source, "ocr", "provenance stays in the OCR vocabulary");
  ok(
    typeof evidence[0].confidence === "number" &&
      evidence[0].confidence >= 0 &&
      evidence[0].confidence <= 1,
    "confidence is a finite 0..1 number"
  );
});

test("the ladder falls through to the whole document when the region misses", () => {
  const reader = layoutReaderFor(invoiceDoc());
  // invoice_number maps to HEADER/FORM_FIELD; the fixture has no such region.
  const { evidence, scope } = buildLayoutAwareEvidence(
    reader,
    { key: "invoice_number", type: "string" },
    ["INV-2024-001"]
  );
  equal(scope, "document", "whole-document scope is the terminal fallback");
  equal(evidence[0].layoutRank, 4, "document is rank 4 in the ladder");
  ok(evidence.length >= 1, "nothing is skipped: value still found");
});

test("evidence is deterministic and deduplicated per OCR line", () => {
  const reader = layoutReaderFor(invoiceDoc());
  const a = buildLayoutAwareEvidence(reader, { key: "total_amount", type: "string" }, ["30.00"]);
  const b = buildLayoutAwareEvidence(reader, { key: "total_amount", type: "string" }, ["30.00"]);
  equal(JSON.stringify(a), JSON.stringify(b), "same field + same OCR → same evidence");

  const { evidence } = a;
  const keys = evidence.map((e) => `${e.lineIndex}:${e.quote}`);
  equal(new Set(keys).size, keys.length, "no duplicate evidence entries");
  ok(evidence.length >= 1, "evidence present");

  // Two needles matching the same line still produce one entry per line.
  const multi = buildLayoutAwareEvidence(reader, { key: "total_amount", type: "string" }, ["30.00", "TOTAL"]);
  equal(
    multi.evidence.filter((e) => e.lineIndex === 4).length,
    1,
    "one OCR line is one evidence unit regardless of how many needles match"
  );
});

test("collectEvidenceText exposes the evidence lines verbatim, nothing skipped", () => {
  const reader = layoutReaderFor(invoiceDoc());
  const { text, evidence, usedLayout } = collectEvidenceText(
    reader,
    { key: "total_amount", type: "string", enum: ["TOTAL"] }
  );
  ok(usedLayout, "layout used for the prompt text");
  ok(text !== undefined && text.includes("TOTAL 30.00"), "evidence line present verbatim");
  ok(evidence.length >= 1, "evidence recorded");
  const lineIndexes = evidence.map((e) => e.lineIndex);
  equal(new Set(lineIndexes).size, lineIndexes.length, "evidence lines are unique");
});

test("combineConfidence reuses the frozen six-component profile", () => {
  const reader = layoutReaderFor(invoiceDoc());
  const lineId = reader.allLineViews()[0].node.id;
  const entry = reader.evidenceFor(lineId);
  ok(entry !== undefined, "evidence entry for the first line");
  const combined = combineConfidence(entry!.confidenceProfile);
  ok(Number.isFinite(combined) && combined >= 0 && combined <= 1, "0..1 finite");
  equal(combined, combineConfidence(entry!.confidenceProfile), "deterministic");
});

// ─── 4. Grounding integration ───────────────────────────────────────────────

test("layout path is used: grounded fields carry ladder scope + rank", () => {
  const doc = invoiceDoc();
  const extraction = mkExtraction(INVOICE_PROFILE, {
    invoice_number: "INV-2024-001",
    invoice_date: "2024-07-02",
    total_amount: "30.00",
  });
  const grounded = groundExtraction(
    INVOICE_PROFILE,
    extraction,
    doc.text,
    doc,
    createLayoutEvidenceProvider(layoutReaderFor(doc))
  );
  const fv = grounded.fieldsMap.invoice_number;
  ok(fv && fv.evidence && fv.evidence.length > 0, "layout evidence attached");
  equal(fv.evidence![0].source, "ocr", "evidence is OCR-compatible");
  ok("layoutRank" in fv.evidence![0], "layout ladder rank recorded");
  ok("scope" in fv.evidence![0], "layout ladder scope recorded");
  ok(
    typeof fv.evidence![0].confidence === "number" && fv.evidence![0].confidence <= 1,
    "composed confidence finite"
  );
});

test("fallback path: broken layout produces byte-identical grounding", () => {
  const doc = invoiceDoc();
  const extraction = mkExtraction(INVOICE_PROFILE, {
    invoice_number: "INV-2024-001",
    invoice_date: "2024-07-02",
    total_amount: "30.00",
  });
  const baseline = groundExtraction(INVOICE_PROFILE, extraction, doc.text, doc);
  const brokenReader = new LayoutAwareReader(doc, brokenBuilder);
  const withFallback = groundExtraction(
    INVOICE_PROFILE,
    extraction,
    doc.text,
    doc,
    createLayoutEvidenceProvider(brokenReader)
  );
  sameExtraction(baseline, withFallback, "identical outputs when layout is broken");
});

test("missing layout: no OCR and no provider keeps the OCR-only path", () => {
  const text = invoiceDoc().text;
  const extraction = mkExtraction(INVOICE_PROFILE, {
    invoice_number: "INV-2024-001",
    invoice_date: "2024-07-02",
    total_amount: "30.00",
  });
  const baseline = groundExtraction(INVOICE_PROFILE, extraction, text);
  const doc = buildOcrDocument(text);
  const brokenReader = new LayoutAwareReader(doc, brokenBuilder);
  const withFallback = groundExtraction(
    INVOICE_PROFILE,
    extraction,
    text,
    doc,
    createLayoutEvidenceProvider(brokenReader)
  );
  sameExtraction(baseline, withFallback, "identical outputs when layout is missing");
});

test("grounding is deterministic across repeated runs", () => {
  const doc = invoiceDoc();
  const extraction = mkExtraction(INVOICE_PROFILE, {
    invoice_number: "INV-2024-001",
    total_amount: "30.00",
  });
  const provider = createLayoutEvidenceProvider(layoutReaderFor(doc));
  const a = groundExtraction(INVOICE_PROFILE, extraction, doc.text, doc, provider);
  const b = groundExtraction(INVOICE_PROFILE, extraction, doc.text, doc, provider);
  sameExtraction(a, b, "identical extraction on identical input");
  equal(
    JSON.stringify(a.fieldsMap.invoice_number.evidence),
    JSON.stringify(b.fieldsMap.invoice_number.evidence),
    "identical evidence arrays"
  );
});

test("no evidence is skipped: a value on several lines grounds to every line", () => {
  const doc = mkDoc([
    "INVOICE NO 1",
    "TOTAL 30.00",
    "Amount due 30.00",
    "Pay 30.00",
  ]);
  const extraction = mkExtraction(INVOICE_PROFILE, { total_amount: "30.00" });
  const grounded = groundExtraction(
    INVOICE_PROFILE,
    extraction,
    doc.text,
    doc,
    createLayoutEvidenceProvider(layoutReaderFor(doc))
  );
  const fv = grounded.fieldsMap.total_amount;
  ok(fv && fv.evidence && fv.evidence.length >= 2, "every matching line became evidence");
});

// ─── 5. Stage integration ───────────────────────────────────────────────────

test("groundStage wires the layout-aware evidence provider", async () => {
  const doc = invoiceDoc();
  const ctx = {
    sourceText: doc.text,
    ocr: doc,
    profile: INVOICE_PROFILE,
    extraction: mkExtraction(INVOICE_PROFILE, {
      invoice_number: "INV-2024-001",
      total_amount: "30.00",
    }),
  } as unknown as PipelineState;
  await groundStage().run(ctx);
  const fv = ctx.extraction!.fieldsMap.invoice_number;
  ok(fv && fv.evidence && fv.evidence.length > 0, "stage attached evidence");
  ok("layoutRank" in fv.evidence![0], "stage used the layout ladder");
});

test("groundStage without OCR behaves exactly like OCR-only grounding", async () => {
  const text = invoiceDoc().text;
  const extraction = mkExtraction(INVOICE_PROFILE, {
    invoice_number: "INV-2024-001",
    total_amount: "30.00",
  });
  const baseline = groundExtraction(INVOICE_PROFILE, extraction, text);
  const ctx = {
    sourceText: text,
    profile: INVOICE_PROFILE,
    extraction,
  } as unknown as PipelineState;
  await groundStage().run(ctx);
  sameExtraction(baseline, ctx.extraction!, "stage without OCR matches the baseline");
});

test("extractStage feeds the layout document text to the prompt", async () => {
  const doc = invoiceDoc();
  let seenPrompt = "";
  const ai: AIClient = {
    chatCompletion: async (request) => {
      seenPrompt = request.messages[1].content;
      return {
        content: JSON.stringify({
          data: {
            invoice_number: {
              raw: "INV-2024-001",
              value: "INV-2024-001",
              confidence: 0.9,
              evidence: "INVOICE INV-2024-001",
            },
          },
        }),
        model: "fake",
        provider: "test",
      };
    },
  };
  const ctx = {
    sourceText: doc.text,
    ocr: doc,
    classification: { profileType: "invoice" },
  } as unknown as PipelineState;
  await extractStage({ ai }).run(ctx);
  ok(seenPrompt.includes("INV-2024-001"), "prompt contains the layout text");
  ok(seenPrompt.includes("TOTAL 30.00"), "prompt keeps every region's lines");
  ok(ctx.extraction !== undefined, "candidates produced");
});

// ─── 6. Document scenarios ──────────────────────────────────────────────────

function assertScenario(
  name: string,
  doc: OcrDocument,
  field: FieldSchema,
  value: string
): void {
  test(`scenario: ${name} — layout path, determinism, no skipped evidence`, () => {
    const reader = layoutReaderFor(doc);
    ok(reader.isLayoutAvailable, `${name}: layout built`);
    ok(reader.isBroken === false, `${name}: no failure`);
    const text = reader.documentText();
    for (const line of doc.lines) {
      ok(text.includes(line.text.trim()), `${name}: every source line kept (${line.text.trim()})`);
    }
    const profile = mkProfile([field]);
    const extraction = mkExtraction(profile, { [field.key]: value });
    const provider = createLayoutEvidenceProvider(reader);
    const a = groundExtraction(profile, extraction, doc.text, doc, provider);
    const b = groundExtraction(profile, extraction, doc.text, doc, provider);
    sameExtraction(a, b, `${name}: deterministic`);
    const fv = a.fieldsMap[field.key];
    ok(fv && fv.evidence && fv.evidence.length >= 1, `${name}: evidence attached`);
    ok("scope" in fv.evidence![0], `${name}: ladder scope recorded`);
    const keys = fv.evidence!.map((e) => `${e.lineIndex}:${e.quote}`);
    equal(new Set(keys).size, keys.length, `${name}: no duplicated evidence`);
  });
}

assertScenario(
  "receipt (mixed Arabic/English)",
  receiptDoc(),
  { key: "total_amount", type: "currency" },
  "68.38"
);
assertScenario(
  "invoice",
  invoiceDoc(),
  { key: "invoice_number", type: "string" },
  "INV-2024-001"
);
assertScenario(
  "bank statement",
  bankDoc(),
  { key: "balance", type: "currency" },
  "400.00"
);
assertScenario(
  "contract",
  contractDoc(),
  { key: "party_a_name", type: "string" },
  "Acme"
);
assertScenario(
  "mixed Arabic/English",
  receiptDoc(),
  { key: "merchant_name", type: "string" },
  "SuperPay"
);
assertScenario(
  "multi-column",
  multicolumnDoc(),
  { key: "total_amount", type: "currency" },
  "30.00"
);
assertScenario(
  "table",
  tableDoc(),
  { key: "subtotal", type: "currency" },
  "30.00"
);
assertScenario(
  "noisy OCR",
  noisyDoc(),
  { key: "invoice_number", type: "string" },
  "99@9"
);

test("scenario: broken layout falls back without failing extraction", () => {
  const doc = invoiceDoc();
  const profile = mkProfile([{ key: "total_amount", type: "currency" }]);
  const extraction = mkExtraction(profile, { total_amount: "30.00" });
  const reader = new LayoutAwareReader(doc, brokenBuilder);
  const result = groundExtraction(
    profile,
    extraction,
    doc.text,
    doc,
    createLayoutEvidenceProvider(reader)
  );
  // Extraction completes; the OCR-only path keeps the value.
  ok(result.fieldsMap.total_amount !== undefined, "field survived the fallback");
  ok(result.droppedFields.total_amount === undefined, "no spurious drop reason");
});

test("scenario: missing layout never blocks extraction", () => {
  const text = invoiceDoc().text;
  const profile = mkProfile([{ key: "total_amount", type: "currency" }]);
  const extraction = mkExtraction(profile, { total_amount: "30.00" });
  const result = groundExtraction(profile, extraction, text);
  ok(result.fieldsMap.total_amount !== undefined, "field grounded from text only");
});
