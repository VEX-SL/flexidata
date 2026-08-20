/**
 * Arabic invoice generalization suite — universal behavior across real Arabic
 * invoices and structured tables, locked with unit tests:
 *
 *   1. Eastern Arabic numerals (٠-٩ / ۰-۹) are normalized to ASCII digits
 *      early, so grounding, verification and lexicon matching all see "2700"
 *      for "۲۷۰۰" while spatial coordinates are preserved.
 *   2. Table headers (الصنف / الكمية / السعر / الإجمالي) pair values in the
 *      SAME COLUMN directly beneath them — a multi-column row attributes each
 *      cell to its own header instead of grabbing the most digit-dense token.
 *   3. A document with zero structural overlap with the requested schema (a
 *      UI screenshot fed to an invoice schema) is flagged as a schema mismatch:
 *      overallConfidence is severely penalized and an explicit warning is
 *      returned instead of high-confidence hallucinated data.
 */
import { test, equal, ok } from "../../../../tests/harness";
import { normalizeArabicNumerals } from "@/lib/ocr/arabic-numerals";
import {
  groundDocument,
  normalizeDocumentNumerals,
} from "../grounding";
import { toFinalExtractionResult } from "../transformer";
import {
  detectLabelGroup,
  labelGroupForField,
} from "@/lib/pipeline/extractor/label-lexicon";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface WordSpec {
  text: string;
  x: number;
  width?: number;
}

/** Build a line with explicit per-word horizontal positions (table layout). */
function colLine(
  words: WordSpec[],
  y: number,
  conf: number,
  height = 22
): OcrLine {
  const ws: OcrWord[] = words.map((w) => ({
    text: w.text,
    confidence: conf,
    bbox: { x: w.x, y, width: w.width ?? Math.max(10, w.text.length * 9), height },
  }));
  const minX = Math.min(...ws.map((w) => w.bbox!.x));
  const maxX = Math.max(...ws.map((w) => w.bbox!.x + w.bbox!.width));
  return {
    text: ws.map((w) => w.text).join(" "),
    confidence: conf,
    words: ws,
    bbox: { x: minX, y, width: maxX - minX, height },
  };
}

function docOf(lines: OcrLine[], meta?: Record<string, unknown>): OcrDocument {
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.9, meta };
}

function fieldOf(g: ReturnType<typeof groundDocument>, key: string) {
  const f = g.fields.find((x) => x.key === key);
  ok(f !== undefined, `field ${key} present`);
  return f!;
}

// ─── 1. Eastern Arabic numeral normalization ────────────────────────────────

test("normalizeArabicNumerals converts Eastern Arabic and Persian digits to ASCII", () => {
  equal(normalizeArabicNumerals("۲۰۰"), "200");
  equal(normalizeArabicNumerals("٣٦"), "36");
  equal(normalizeArabicNumerals("۷۲۰۰"), "7200");
  equal(normalizeArabicNumerals("۱٢٣٤٥٦٧٨٩۰"), "1234567890");
  equal(normalizeArabicNumerals("مجموع ۲۷۰۰ ريال"), "مجموع 2700 ريال");
  equal(normalizeArabicNumerals("12345"), "12345", "ASCII digits pass through untouched");
});

test("normalizeDocumentNumerals rewrites text but preserves every spatial coordinate", () => {
  const doc = docOf([
    colLine([{ text: "الإجمالي", x: 0 }], 100, 0.95),
    colLine([{ text: "۲۷۰۰", x: 0 }], 126, 0.95),
  ]);
  const out = normalizeDocumentNumerals(doc);
  ok(out.text.includes("2700"), "document text carries ASCII digits");
  const valueWord = out.lines[1].words[0];
  equal(valueWord.text, "2700");
  equal(valueWord.bbox!.x, 0);
  equal(valueWord.bbox!.y, 126);
  ok(!out.text.includes("۲۷۰۰"), "no Eastern digits remain in the surface");
});

test("grounding: Eastern-numeral total '۲۷۰۰' under 'المجموع' verifies as 2700", () => {
  const doc = docOf([
    colLine([{ text: "المجموع", x: 0 }], 100, 0.95),
    colLine([{ text: "۲۷۰۰", x: 0 }], 126, 0.95),
  ]);
  const out = groundDocument(doc, [
    { key: "total_amount", type: "currency", expectedValue: "2700" },
  ]);
  const f = fieldOf(out, "total_amount");
  equal(f.state, "VERIFIED");
  equal(f.value, "2700", "Eastern digits normalized before grounding");
});

test("grounding: inline Eastern-numeral total 'الإجمالي ۳۶' verifies as 36", () => {
  const doc = docOf([
    colLine([{ text: "الإجمالي", x: 0 }, { text: "۳۶", x: 100 }], 100, 0.95),
  ]);
  const out = groundDocument(doc, [
    { key: "total_amount", type: "currency", expectedValue: "36" },
  ]);
  const f = fieldOf(out, "total_amount");
  equal(f.state, "VERIFIED");
  equal(f.value, "36");
  equal(f.attribution!.alignment, "inline_label");
});

// ─── 2. Vertical table-column alignment ─────────────────────────────────────

test("table columns: each header pairs the value in its own column below", () => {
  const header = colLine(
    [
      { text: "الصنف", x: 0 },
      { text: "الكمية", x: 300 },
      { text: "السعر", x: 500 },
      { text: "الإجمالي", x: 700 },
    ],
    100,
    0.95
  );
  const row = colLine(
    [
      { text: "قمح", x: 0 },
      { text: "2", x: 300 },
      { text: "25.00", x: 500 },
      { text: "50.00", x: 700 },
    ],
    140,
    0.95
  );
  const out = groundDocument(docOf([header, row]), [
    { key: "quantity", type: "number", expectedValue: "2" },
    { key: "unit_price", type: "currency", expectedValue: "25.00" },
    { key: "total_amount", type: "currency", expectedValue: "50.00" },
  ]);

  const qty = fieldOf(out, "quantity");
  equal(qty.state, "VERIFIED");
  equal(qty.value, "2", "quantity reads the الكمية column, not the row's max token");
  equal(qty.attribution!.alignment, "column_below");

  const price = fieldOf(out, "unit_price");
  equal(price.state, "VERIFIED");
  equal(price.value, "25.00", "price reads the السعر column");
  equal(price.attribution!.alignment, "column_below");

  const total = fieldOf(out, "total_amount");
  equal(total.state, "VERIFIED");
  equal(total.value, "50.00", "total reads the الإجمالي column");
  equal(total.attribution!.alignment, "column_below");
});

test("table columns: single-digit quantity with an Eastern numeral verifies", () => {
  const header = colLine([{ text: "الكمية", x: 300 }], 100, 0.95);
  // "۲" is Eastern-Arabic "2"; the row sits far below the header (gap 78px),
  // beyond the side-by-side PADDLE_PAIR_GAP, so only column alignment can pair.
  const row = colLine([{ text: "۲", x: 300 }], 200, 0.95);
  const out = groundDocument(docOf([header, row]), [
    { key: "quantity", type: "number", expectedValue: "2" },
  ]);
  const f = fieldOf(out, "quantity");
  equal(f.state, "VERIFIED");
  equal(f.value, "2");
  equal(f.attribution!.alignment, "column_below");
});

// ─── 3. Lexicon coverage ────────────────────────────────────────────────────

test("lexicon: Arabic invoice headers resolve to their semantic groups", () => {
  equal(detectLabelGroup("المجموع"), "total");
  equal(detectLabelGroup("الإجمالي"), "total");
  equal(detectLabelGroup("إجمالي الفاتورة"), "total");
  equal(detectLabelGroup("الصافي"), "total");
  equal(detectLabelGroup("الإجمالي الفرعي"), "subtotal");
  equal(detectLabelGroup("المبلغ قبل الضريبة"), "subtotal");
  equal(detectLabelGroup("السعر"), "price");
  equal(detectLabelGroup("سعر الوحدة"), "price");
  equal(detectLabelGroup("الكمية"), "quantity");
  equal(detectLabelGroup("العدد"), "quantity");
  equal(detectLabelGroup("الصنف"), "item_name");
  equal(detectLabelGroup("الوصف"), "item_name");
});

test("lexicon: field keys derive the new Arabic groups", () => {
  equal(labelGroupForField({ key: "subtotal", type: "currency" }), "subtotal");
  equal(labelGroupForField({ key: "unit_price", type: "currency" }), "price");
  equal(labelGroupForField({ key: "price", type: "currency" }), "price");
  equal(labelGroupForField({ key: "quantity", type: "number" }), "quantity");
  equal(labelGroupForField({ key: "item_name", type: "string" }), "item_name");
});

// ─── 4. Schema mismatch detection ───────────────────────────────────────────

test("schema mismatch: a UI-screenshot-like document is penalized, never high-confidence", () => {
  // Bare floating numbers, no schema labels anywhere, nothing verified.
  const doc = docOf([
    colLine([{ text: "38.40", x: 0 }], 40, 0.95),
    colLine([{ text: "50.00", x: 0 }], 80, 0.95),
    colLine([{ text: "11.60", x: 0 }], 120, 0.95),
  ]);
  const out = toFinalExtractionResult(
    groundDocument(doc, [
      { key: "total_amount", type: "currency", expectedValue: "38.40" },
      { key: "cash", label: "Cash", type: "currency", expectedValue: "50.00" },
      { key: "change", label: "Change", type: "currency", expectedValue: "11.60" },
    ])
  );

  equal(out.data, {}, "no hallucinated data is committed");
  equal(out.issues.length, 3, "every field surfaces as an issue for review");
  ok(out.schemaFit.matched === false, "schema fit rejected");
  ok(
    out.schemaFit.mismatchReasons.includes("no_schema_labels_in_document"),
    "machine-readable mismatch reason recorded"
  );
  equal(out.schemaFit.labelCoverage, 0);
  equal(out.overallConfidence, 0.3, "base 0.35 is capped to the severe mismatch cap");
  equal(out.warnings.length, 1, "explicit document-level warning returned");
  ok(out.warnings[0].includes("structurally match"), "warning names the mismatch");
});

test("schema mismatch: an empty document also flags and stays at zero confidence", () => {
  const out = toFinalExtractionResult(
    groundDocument(docOf([]), [
      { key: "total_amount", type: "currency", expectedValue: "38.40" },
      { key: "invoice_number", type: "string", expectedValue: "INV-2026-001" },
    ])
  );
  equal(out.data, {});
  ok(out.schemaFit.matched === false);
  ok(out.schemaFit.mismatchReasons.length > 0);
  equal(out.overallConfidence, 0, "all-missing document scores 0 regardless of the cap");
});

test("schema fit: a real (low-quality) invoice is never misclassified as mismatched", () => {
  // The document carries the schema's labels — only the values are missing.
  const doc = docOf([
    colLine([{ text: "المجموع", x: 0 }], 100, 0.95),
    colLine([{ text: "الكمية", x: 300 }], 130, 0.95),
    colLine([{ text: "Thank you", x: 0 }], 300, 0.95),
  ]);
  const out = toFinalExtractionResult(
    groundDocument(doc, [
      { key: "total_amount", type: "currency", expectedValue: "2700" },
      { key: "quantity", type: "number", expectedValue: "2" },
    ])
  );
  ok(out.schemaFit.matched === true, "labels present ⇒ structurally the right document");
  equal(out.warnings.length, 0, "no mismatch warning on a real document");
  equal(out.schemaFit.labelCoverage, 1);
});