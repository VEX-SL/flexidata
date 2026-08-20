/**
 * SuperPay thermal-receipt regression suite — the four defects found on
 * `benchmarks/corpus/real-superpay.jpg`, each with a locking test:
 *
 *   1. Misattribution: "15468" (hotline) must never be grounded as the
 *      transaction number; the transaction field anchors to its own label
 *      ("رقم انعمليه" — the thermal "العملية" variant) only.
 *   2. BiDi layout: an Arabic label and Latin digits on one printed line with
 *      visibly different x-heights (boxes far apart vertically) still pair on
 *      the same visual line — no false "label not matched" rejection.
 *   3. Digit collapse: Tesseract reads 9→8 / 9→0 on faint thermal digits; the
 *      gated Paddle rescue re-reads each weak long-digit line and replaces
 *      its token in place (607021830113216→6070218301132157,
 *      2013438351→2013439351, 0640833767→9640833767, 0123456788→0123456789).
 *   4. Confidence calibration: overallConfidence reflects unresolved fields
 *      (covered in transformer.test.ts; here we assert the healed receipt
 *      scores high).
 *
 * The mock HTTP service replays the REAL PaddleOCR readings captured from the
 * live service (captured per-region, in request order — a region reads only
 * its own crop, so a single canned script cannot serve them all).
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, equal, ok, includes } from "../../../../tests/harness";
import { processDocumentPipeline, type PipelineSchema } from "../pipeline";
import { groundDocument } from "../grounding";
import type { OcrDocument, OcrLine } from "@/lib/pipeline/types";

// ─── Real readings captured from the live PaddleOCR service (request order) ─

const SUPERPAY_READINGS: Array<{
  text: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
}>[] = [
  [{ text: "6070218301132157|", confidence: 0.9613, bbox: { x: 0, y: 0, width: 521, height: 49 } }],
  [{ text: "18:30:12 02-07-2026 :", confidence: 0.8833, bbox: { x: 0, y: 0, width: 599, height: 54 } }],
  [{ text: "391003452", confidence: 0.9482, bbox: { x: 0, y: 0, width: 409, height: 52 } }],
  [{ text: "2013439351", confidence: 0.6193, bbox: { x: 0, y: 0, width: 454, height: 54 } }],
  [{ text: "9640833767", confidence: 0.851, bbox: { x: 0, y: 0, width: 419, height: 54 } }],
  [{ text: "(0123456789); Hostinger;Description", confidence: 0.9985, bbox: { x: 0, y: 0, width: 696, height: 58 } }],
];

const SUPERPAY_SCHEMA: PipelineSchema = {
  fields: [
    { key: "transaction_number", type: "string", expectedValue: "6070218301132157" },
    { key: "account_number", type: "string", labelGroup: "pos", expectedValue: "391003452" },
    { key: "mobile_number", type: "string", label: "Mobile", expectedValue: "0123456789" },
    { key: "customer_number", type: "string", labelGroup: "buyer", expectedValue: "9640833767" },
    { key: "reference_number", type: "string", expectedValue: "2013439351" },
  ],
};

async function startSequentialMock(script: typeof SUPERPAY_READINGS) {
  let count = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const i = Math.min(count, script.length - 1);
      count += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ engine: "paddleocr-en", texts: script[i], latency_ms: 60 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/ocr`,
    requests: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ─── 1. Real receipt end to end: rescue heals the collapse, values verify ───

test("superpay: thermal digit collapse is healed and all five identifiers verify", async () => {
  const png = readFileSync("benchmarks/corpus/real-superpay.jpg");
  const server = await startSequentialMock(SUPERPAY_READINGS);
  try {
    const out = await processDocumentPipeline(png, SUPERPAY_SCHEMA, {
      paddleUrl: server.url,
      langs: "ara+eng",
    });
    equal(server.requests(), SUPERPAY_READINGS.length, "one request per rescue region");

    const rescue = (out.grounded.doc.meta as Record<string, unknown>).paddleRescue as {
      triggered: boolean;
      accepted: number;
      attempts: Array<{ region: string; accepted: number }>;
    };
    ok(rescue?.triggered === true, "rescue triggered");
    equal(rescue?.accepted, 4, "four collapsed tokens replaced (transaction/reference/customer/mobile)");
    ok(
      rescue?.attempts.every((a) => ["digit_line", "candidate"].includes(a.region)),
      "every attempt is an anchored crop re-read"
    );
    ok(
      rescue?.attempts.filter((a) => a.accepted === 1).every((a) => a.region === "digit_line"),
      "every accepted replacement was an in-place digit-line swap"
    );

    equal(out.result.data.transaction_number, "6070218301132157", "transaction healed");
    equal(out.result.data.reference_number, "2013439351", "reference healed (9→8 collapse)");
    equal(out.result.data.customer_number, "9640833767", "customer healed (9→0 collapse)");
    equal(out.result.data.mobile_number, "0123456789", "mobile healed (9→8 collapse)");
    equal(out.result.data.account_number, "391003452", "account verified unchanged");

    equal(out.result.issues.length, 0, "no unresolved fields");
    ok(out.result.overallConfidence >= 0.8, `calibrated confidence reflects the healed doc (got ${out.result.overallConfidence})`);
    ok(
      !JSON.stringify(out.result.data).includes("15468"),
      "the 5-digit hotline is never committed"
    );

    const txn = out.result.meta.transaction_number;
    equal(txn.state, "VERIFIED");
    equal(txn.attribution!.labelLine, 5, "transaction anchored to its own label line");
    includes(txn.attribution!.label, "انعمليه", "thermal label variant matched");
    equal(txn.attribution!.source, "paddle_rescue");
    equal(out.result.meta.reference_number.attribution!.source, "paddle_rescue");
    equal(out.result.meta.customer_number.attribution!.source, "paddle_rescue");
    equal(out.result.meta.mobile_number.attribution!.alignment, "column_below", "mobile value sits directly beneath its label on the x-axis");
  } finally {
    await server.close();
  }
});

// ─── 2. Misattribution: the hotline can never become the transaction ────────

function line(text: string, y: number, conf: number, opts: { height?: number; x?: number } = {}): OcrLine {
  const words = text.split(/\s+/).map((t, i) => ({
    text: t,
    confidence: conf,
    bbox: { x: opts.x ?? i * 30, y, width: Math.max(10, t.length * 9), height: opts.height ?? 22 },
  }));
  return {
    text,
    confidence: conf,
    words,
    bbox: { x: opts.x ?? 0, y, width: 300, height: opts.height ?? 22 },
  };
}

function docOf(lines: OcrLine[], meta?: Record<string, unknown>): OcrDocument {
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.9, meta };
}

test("grounding: the 5-digit hotline '15468' is never attributed as the transaction number", () => {
  const doc = docOf([
    line("15468 ذا", 20, 0.63),
    line("607021830113216] : رقم انعمليه", 54, 0.53),
    line("2013438351 : انرقم المرجقي", 90, 0.69),
  ]);
  const out = groundDocument(doc, [
    { key: "transaction_number", type: "string", expectedValue: "6070218301132157" },
    { key: "reference_number", type: "string", expectedValue: "2013439351" },
  ]);
  ok(
    !JSON.stringify({ fields: out.fields, summary: out.summary }).includes("15468"),
    "hotline appears in no grounding verdict"
  );
  const txn = out.fields.find((f) => f.key === "transaction_number")!;
  equal(txn.state, "MISSING", "transaction stays missing without a 16-digit value");
  ok(txn.reasons.includes("no_valid_length_value"), "length gate reason recorded");
  const ref = out.fields.find((f) => f.key === "reference_number")!;
  equal(ref.state, "UNCERTAIN", "reference keeps its raw-but-mismatched reading");
  ok(ref.reasons.includes("value_mismatch_expected"));
});

// ─── 3. BiDi layout: mixed-height boxes on one visual line still pair ───────

test("grounding: Arabic label and tall digit box on one visual line pair without rejection", () => {
  const doc = docOf([
    line("رقم الحساب", 110, 0.9, { height: 18, x: 5 }),
    line("391003452", 74, 0.79, { height: 54, x: 260 }),
  ]);
  const out = groundDocument(doc, [
    { key: "account_number", type: "string", labelGroup: "pos", expectedValue: "391003452" },
  ]);
  const f = out.fields[0];
  equal(f.state, "VERIFIED", "boxes 18px apart vertically still pair as one visual line");
  equal(f.attribution!.alignment, "same_line");
  equal(f.value, "391003452");
  equal(f.reasons.length, 0);
});