import { test, equal, ok, includes } from "../../../../tests/harness";
import {
  toFinalExtractionResult,
  type FinalExtractionResult,
} from "../transformer";
import { groundDocument } from "../grounding";
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

function ground(lines: OcrLine[], fields: Parameters<typeof groundDocument>[1]): FinalExtractionResult {
  return toFinalExtractionResult(groundDocument(docOf(lines), fields));
}

// ─── 1. Only VERIFIED fields reach data ─────────────────────────────────────

test("data contains only VERIFIED fields", () => {
  const out = ground(
    [
      line("TOTAL 38.40", 100, 1.0, { wordConfs: [1.0, 1.0] }),
      line("38.40", 60, 0.95, { sourceLine: 1 }),
    ],
    [
      { key: "total_amount", type: "currency", expectedValue: "38.40" },
      { key: "cash", label: "Cash", type: "currency", expectedValue: "38.40" },
    ]
  );
  equal(Object.keys(out.data), ["total_amount"], "only the VERIFIED field is committed");
  equal(out.data.total_amount, "38.40");
  ok(!("cash" in out.data), "UNCERTAIN field never leaks into data");
});

// ─── 2. meta describes every field ──────────────────────────────────────────

test("meta carries state, confidence and attribution for every field", () => {
  const out = ground(
    [line("TOTAL 38.40", 100, 1.0, { wordConfs: [1.0, 1.0] })],
    [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]
  );
  ok(out.meta.total_amount !== undefined, "meta present for the field");
  equal(out.meta.total_amount.state, "VERIFIED");
  equal(out.meta.total_amount.value, "38.40");
  equal(out.meta.total_amount.confidence, 1.0);
  ok(out.meta.total_amount.attribution !== undefined, "spatial attribution in meta");
  equal(out.meta.total_amount.attribution!.alignment, "inline_label");
  equal(out.meta.total_amount.attribution!.label, "TOTAL 38.40");
});

// ─── 3. issues list every UNCERTAIN and MISSING field ───────────────────────

test("issues list every UNCERTAIN and MISSING field with reason and raw value", () => {
  const out = ground(
    [
      line("TOTAL 38.40", 100, 1.0, { wordConfs: [1.0, 1.0] }),
      line("38.40", 60, 0.95, { sourceLine: 1 }),
      line("Sugar 1kg", 140, 0.9, { sourceLine: 2 }),
    ],
    [
      { key: "total_amount", type: "currency", expectedValue: "38.40" },
      { key: "cash", label: "Cash", type: "currency", expectedValue: "38.40" },
      { key: "change", label: "Change", type: "currency", expectedValue: "11.60" },
    ]
  );
  equal(out.issues.length, 2, "one UNCERTAIN + one MISSING");
  const cash = out.issues.find((i) => i.key === "cash");
  const change = out.issues.find((i) => i.key === "change");
  ok(cash !== undefined, "cash issue present");
  equal(cash!.state, "UNCERTAIN");
  ok(cash!.reasons.includes("value_without_label"), "rejection reason recorded");
  equal(cash!.rawValue, "38.40", "raw reading surfaced for manual review");
  ok(change !== undefined, "change issue present");
  equal(change!.state, "MISSING");
  ok(change!.rawValue === undefined, "no raw value for a truly missing field");
});

// ─── 4. No unverified value leaks into data ─────────────────────────────────

test("no unverified raw value ever leaks into data", () => {
  const out = ground(
    [
      line("TOTAL 38.40", 100, 1.0, { wordConfs: [1.0, 1.0] }),
      line("50.00", 60, 0.95, { sourceLine: 1 }),
    ],
    [
      { key: "total_amount", type: "currency", expectedValue: "38.40" },
      { key: "cash", label: "Cash", type: "currency", expectedValue: "50.00" },
    ]
  );
  const dataValues = Object.values(out.data);
  for (const issue of out.issues) {
    if (issue.rawValue === undefined) continue;
    ok(!dataValues.includes(issue.rawValue), `${issue.key} raw value ${issue.rawValue} is not in data`);
  }
  ok(!dataValues.includes("50.00"), "bare 50.00 with no label is not committed");
});

// ─── 5. Empty grounded document ─────────────────────────────────────────────

test("empty grounded document yields empty data, meta and issues", () => {
  const out = ground([], []);
  equal(out.data, {});
  equal(out.meta, {});
  equal(out.issues, []);
});

// ─── 6. Issue count matches the grounded summary ────────────────────────────

test("issue count matches uncertain+missing summary count", () => {
  const grounded = groundDocument(
    docOf([line("TOTAL 38.40", 100, 1.0, { wordConfs: [1.0, 1.0] })]),
    [
      { key: "total_amount", type: "currency", expectedValue: "38.40" },
      { key: "cash", label: "Cash", type: "currency", expectedValue: "50.00" },
      { key: "change", label: "Change", type: "currency", expectedValue: "11.60" },
    ]
  );
  const out = toFinalExtractionResult(grounded);
  equal(out.issues.length, grounded.summary.uncertain + grounded.summary.missing);
  equal(Object.keys(out.data).length, grounded.summary.verified);
});

// ─── 7. Stable default reason for a MISSING field without reasons ───────────

test("a MISSING field with no recorded reasons gets a stable default", () => {
  const grounded = groundDocument(docOf([]), [{ key: "total_amount", type: "currency" }]);
  const out = toFinalExtractionResult(grounded);
  equal(out.issues.length, 1);
  equal(out.issues[0].state, "MISSING");
  equal(out.issues[0].reason, "no value found in document");
  equal(out.meta.total_amount.state, "MISSING");
  equal(out.data, {}, "nothing committed");
});

// ─── 8. Attribution survives into issues for partially-attributed fields ────

test("distant label/value pair issue carries its partial attribution", () => {
  const out = ground(
    [
      line("TOTAL", 100, 0.95, { sourceLine: 0 }),
      line("38.40", 500, 0.95, { sourceLine: 1 }),
    ],
    [{ key: "total_amount", type: "currency", expectedValue: "38.40" }]
  );
  equal(out.issues.length, 1);
  const issue = out.issues[0];
  equal(issue.state, "UNCERTAIN");
  ok(issue.reasons.includes("label_value_gap_too_large"), "spatial rejection reason");
  equal(issue.rawValue, "38.40", "raw reading available for manual review");
  ok(issue.attribution === undefined, "no attribution for a value too far from its label");
});

// ─── 9. Multi-field document end to end ─────────────────────────────────────

test("multi-field receipt grounds correctly end to end", () => {
  const out = ground(
    [
      line("TOTAL 38.40", 100, 1.0, { wordConfs: [1.0, 1.0] }),
      line("Cash 50.00", 140, 1.0, { wordConfs: [1.0, 1.0] }),
      line("Change 11.60", 180, 1.0, { wordConfs: [1.0, 1.0] }),
    ],
    [
      { key: "total_amount", type: "currency", expectedValue: "38.40" },
      { key: "cash", label: "Cash", type: "currency", expectedValue: "50.00" },
      { key: "change", label: "Change", type: "currency", expectedValue: "11.60" },
    ]
  );
  equal(Object.keys(out.data), ["total_amount", "cash", "change"]);
  equal(out.data.total_amount, "38.40");
  equal(out.data.cash, "50.00");
  equal(out.data.change, "11.60");
  equal(out.issues.length, 0, "no issues when everything is verified");
});