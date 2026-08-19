import { test, equal, ok, includes } from "../../../../tests/harness";
import {
  groundDocument,
  type GroundedDocument,
  type GroundedField,
} from "../grounding";
import type { OcrDocument, OcrLine } from "@/lib/pipeline/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface LineOpts {
  height?: number;
  x?: number;
  wordConfs?: number[];
  sourceLine?: number;
}

function line(text: string, y: number, conf: number, opts: LineOpts = {}): OcrLine {
  const words = text.split(/\s+/).map((t, i) => ({
    text: t,
    confidence: opts.wordConfs ? opts.wordConfs[i] : conf,
    bbox: { x: opts.x ?? i * 30, y, width: Math.max(10, t.length * 9), height: opts.height ?? 22 },
  }));
  return {
    text,
    confidence: conf,
    words,
    bbox: { x: opts.x ?? 0, y, width: 300, height: opts.height ?? 22 },
    ...(opts.sourceLine !== undefined ? { sourceLine: opts.sourceLine } : {}),
  };
}

function docOf(lines: OcrLine[], meta?: Record<string, unknown>): OcrDocument {
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.9, meta };
}

function byKey(doc: GroundedDocument, key: string): GroundedField {
  const f = doc.fields.find((x) => x.key === key);
  ok(f !== undefined, `field ${key} present`);
  return f as GroundedField;
}

// ─── 1. Inline rescue line → VERIFIED with paddle_rescue attribution ────────

test("inline rescue line 'TOTAL 38.40' is VERIFIED with paddle_rescue attribution", () => {
  const rescueLine = line("TOTAL 38.40", 100, 1.0, { wordConfs: [1.0, 1.0] });
  const doc = docOf(
    [line("Sugar 1kg", 60, 0.9), rescueLine, line("Thank you", 140, 0.9)],
    { paddleRescue: { triggered: true, accepted: 3, regions: [], attempts: [], latencyMs: 0, budgetMs: 0, elapsedMs: 0 } }
  );
  const out = groundDocument(doc, [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]);
  const f = byKey(out, "total_amount");
  equal(f.state, "VERIFIED");
  equal(f.value, "38.40");
  ok(f.attribution !== undefined, "attribution attached");
  equal(f.attribution!.alignment, "inline_label");
  equal(f.attribution!.source, "paddle_rescue");
  equal(f.attribution!.labelLine, 1);
  ok(f.attribution!.labelBBox !== undefined, "label bbox attached");
  equal(f.reasons.length, 0);
});

// ─── 2. Tesseract label + adjacent value on rows below → VERIFIED ───────────

test("Tesseract 'Cash' with '50.00' directly below is VERIFIED (adjacent_below, tesseract)", () => {
  const doc = docOf([
    line("Cash", 100, 0.95, { sourceLine: 0 }),
    line("50.00", 126, 0.9, { sourceLine: 1 }),
  ]);
  const out = groundDocument(doc, [{ key: "cash", label: "Cash", type: "currency", expectedValue: "50.00" }]);
  const f = byKey(out, "cash");
  equal(f.state, "VERIFIED");
  equal(f.value, "50.00");
  equal(f.attribution!.alignment, "adjacent_below");
  equal(f.attribution!.source, "tesseract");
});

// ─── 3. Bare value with no label → NEVER VERIFIED ───────────────────────────

test("bare numeric '38.40' with no label is UNCERTAIN (value_without_label), never VERIFIED", () => {
  const doc = docOf([
    line("AL RABIH SUPERMARKET", 20, 0.95, { sourceLine: 0 }),
    line("38.40", 60, 0.95, { sourceLine: 1 }),
  ]);
  const out = groundDocument(doc, [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]);
  const f = byKey(out, "total_amount");
  notEqual(f.state, "VERIFIED", "bare value without label is never VERIFIED");
  equal(f.state, "UNCERTAIN");
  ok(f.reasons.includes("value_without_label"), "reason recorded");
  equal(f.value, "38.40", "value still surfaced for review");
  ok(f.attribution === undefined, "no attribution for a bare value");
});

// ─── 4. Distant label/value pair → NOT VERIFIED ─────────────────────────────

test("label and value 376px apart are NOT VERIFIED (label_value_gap_too_large)", () => {
  const doc = docOf([
    line("TOTAL", 100, 0.95, { sourceLine: 0 }),
    line("38.40", 500, 0.95, { sourceLine: 1 }),
  ]);
  const out = groundDocument(doc, [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]);
  const f = byKey(out, "total_amount");
  notEqual(f.state, "VERIFIED", "distant pair never VERIFIED");
  equal(f.state, "UNCERTAIN");
  ok(f.reasons.includes("label_value_gap_too_large"), "reason recorded");
});

// ─── 5. Expected-value mismatch → NOT VERIFIED ──────────────────────────────

test("'TOTAL 50.00' against expected 38.40 is UNCERTAIN (value_mismatch_expected)", () => {
  const doc = docOf([line("TOTAL 50.00", 100, 1.0, { wordConfs: [1.0, 1.0] })]);
  const out = groundDocument(doc, [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]);
  const f = byKey(out, "total_amount");
  notEqual(f.state, "VERIFIED", "mismatched value never VERIFIED");
  equal(f.state, "UNCERTAIN");
  ok(f.reasons.includes("value_mismatch_expected"), "reason recorded");
});

// ─── 6. Nothing in the document → MISSING ───────────────────────────────────

test("field absent from the document is MISSING", () => {
  const doc = docOf([line("Sugar 1kg", 100, 0.9, { sourceLine: 0 })]);
  const out = groundDocument(doc, [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]);
  const f = byKey(out, "total_amount");
  equal(f.state, "MISSING");
  ok(f.attribution === undefined, "no attribution when missing");
});

// ─── 7. Side-by-side boxes on the same visual line → VERIFIED ───────────────

test("label and value boxes on the same visual line are VERIFIED (same_line)", () => {
  const doc = docOf([
    line("Sugar 1kg", 100, 0.9, { height: 30, x: 5, sourceLine: 0 }),
    line("6.50", 102, 0.95, { height: 28, x: 260, sourceLine: 1 }),
  ]);
  const out = groundDocument(doc, [{ key: "items", label: "Sugar 1kg", expectedValue: "6.5" }]);
  const f = byKey(out, "items");
  equal(f.state, "VERIFIED");
  equal(f.value, "6.50");
  equal(f.attribution!.alignment, "same_line");
});

// ─── 8. Low-confidence aligned value → UNCERTAIN ────────────────────────────

test("aligned value with confidence below GROUNDED_MIN_CONF is UNCERTAIN", () => {
  const doc = docOf([
    line("Change", 100, 0.9, { sourceLine: 0 }),
    line("11.60", 126, 0.3, { sourceLine: 1 }),
  ]);
  const out = groundDocument(doc, [{ key: "change", label: "Change", type: "currency", expectedValue: "11.60" }]);
  const f = byKey(out, "change");
  equal(f.state, "UNCERTAIN");
  ok(f.reasons.includes("low_confidence"), "reason recorded");
});

// ─── 9. Label group derived from the schema key ─────────────────────────────

test("total_amount derives the 'total' label group from the key alone", () => {
  const doc = docOf([
    line("TOTAL", 100, 0.9, { sourceLine: 0 }),
    line("38.40", 126, 0.95, { sourceLine: 1 }),
  ]);
  const out = groundDocument(doc, [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]);
  const f = byKey(out, "total_amount");
  equal(f.state, "VERIFIED");
  equal(f.attribution!.labelLine, 0);
});

// ─── 10. Summary counts ─────────────────────────────────────────────────────

test("summary counts verified / uncertain / missing", () => {
  const doc = docOf([
    line("TOTAL 38.40", 100, 1.0, { wordConfs: [1.0, 1.0] }),
    line("38.40", 60, 0.95, { sourceLine: 1 }),
    line("Sugar 1kg", 140, 0.9, { sourceLine: 2 }),
  ]);
  const out = groundDocument(doc, [
    { key: "total_amount", type: "currency", expectedValue: "38.40" },
    { key: "cash", label: "Cash", type: "currency", expectedValue: "38.40" },
    { key: "change", label: "Change", type: "currency", expectedValue: "11.60" },
  ]);
  equal(out.summary.total, 3);
  equal(out.summary.verified, 1, "only the inline TOTAL is verified");
  equal(out.summary.uncertain, 1, "bare 38.40 with no Cash label is uncertain");
  equal(out.summary.missing, 1, "Change is missing");
});

// ─── 11. Empty document ─────────────────────────────────────────────────────

test("empty document marks every field MISSING", () => {
  const out = groundDocument(docOf([]), [
    { key: "total_amount", type: "currency" },
    { key: "cash", label: "Cash" },
  ]);
  equal(out.summary.total, 2);
  equal(out.summary.missing, 2);
  equal(out.summary.verified, 0);
});

// ─── 12. Canonical amount equivalence ───────────────────────────────────────

test("expected 38.40 matches printed 38.4 by numeric value", () => {
  const doc = docOf([
    line("TOTAL", 100, 0.9, { sourceLine: 0 }),
    line("38.4", 126, 0.95, { sourceLine: 1 }),
  ]);
  const out = groundDocument(doc, [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]);
  equal(byKey(out, "total_amount").state, "VERIFIED");
});

// ─── 13. Rescue record with no accepted insertions → tesseract provenance ───

test("a rescue record with accepted=0 does not claim paddle_rescue provenance", () => {
  const doc = docOf(
    [line("TOTAL 38.40", 100, 0.9, { wordConfs: [0.9, 0.92] })],
    { paddleRescue: { triggered: true, accepted: 0, regions: [], attempts: [], latencyMs: 0, budgetMs: 0, elapsedMs: 0 } }
  );
  const out = groundDocument(doc, [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]);
  const f = byKey(out, "total_amount");
  equal(f.state, "VERIFIED");
  equal(f.attribution!.source, "tesseract");
});

// ─── 14. Inline label with no numeric token is not a value line ─────────────

test("label line 'Sugar 1kg' carries no numeric value inline", () => {
  const doc = docOf([
    line("Sugar 1kg", 100, 0.9, { sourceLine: 0 }),
    line("6.50", 126, 0.95, { sourceLine: 1 }),
  ]);
  const out = groundDocument(doc, [{ key: "items", label: "Sugar 1kg", expectedValue: "6.50" }]);
  const f = byKey(out, "items");
  equal(f.state, "VERIFIED");
  equal(f.attribution!.alignment, "adjacent_below");
});

function notEqual<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    throw new Error(`${msg ?? "values are equal"}\n  actual:   ${JSON.stringify(actual)}`);
  }
}