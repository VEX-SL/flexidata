/**
 * Unit + integration tests for the gated PaddleOCR rescue layer.
 *
 * Unit tests inject a fake HTTP layer (no network, no PaddleOCR), and the
 * integration tests run the real recognizeMainThread pipeline against a
 * local mock HTTP service that replays the real PaddleOCR reading captured
 * for the scan-blur fixture.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createCanvas, loadImage } from "@/lib/pdf-canvas";
import {
  PADDLE_MAX_REGIONS,
  PADDLE_MIN_BUDGET_MS,
  runPaddleRescue,
  type PaddleRescueRecord,
} from "@/lib/ocr/paddle-rescue";
import type { PaddleRescueResult } from "@/lib/ocr/paddle-client";
import { requestPaddleRescue } from "@/lib/ocr/paddle-client";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { canvasFromImage, type RawImage } from "@/lib/ocr/preprocess";
import type { OcrDocument, OcrLine } from "@/lib/pipeline/types";
import { test, ok, equal, includes, assert } from "./harness.ts";

// The rescue URL must never leak from the environment into unit tests.
delete process.env.PADDLE_OCR_URL;

// ─── Helpers ────────────────────────────────────────────────────────────────

interface LineSpec {
  text: string;
  conf: number;
  y: number;
  height?: number;
}

function makeDoc(lineSpecs: LineSpec[], detected = true): OcrDocument {
  const lines: OcrLine[] = lineSpecs.map((s, i) => {
    const words = s.text.split(/\s+/).filter((t) => t.length > 0).map((t) => ({
      text: t,
      confidence: s.conf,
      bbox: { x: 10, y: s.y, width: Math.max(8, t.length * 6), height: s.height ?? 18 },
    }));
    return {
      text: s.text,
      confidence: s.conf,
      words,
      bbox: { x: 10, y: s.y, width: 480, height: s.height ?? 18 },
    } as OcrLine;
  });
  const doc: OcrDocument = {
    text: lines.map((l) => l.text).join("\n"),
    language: "ara+eng",
    confidence: lineSpecs.reduce((s, l) => s + l.conf, 0) / Math.max(1, lineSpecs.length),
    lines,
  };
  if (detected) {
    doc.meta = { recallRecovery: { detected: true, signals: ["lowDensity"], attempts: 3, selected: "candidate" } };
  } else {
    doc.meta = { recallRecovery: { detected: false, signals: [], attempts: 0, selected: "primary" } };
  }
  return doc;
}

/** A doc with one invalid + two valid numeric candidates (not severe collapse). */
function makeProblemDoc(detected = true): OcrDocument {
  return makeDoc(
    [
      { text: "Ref 1343786620]", conf: 0.8, y: 20 },
      { text: "Transaction 607021830113216", conf: 0.9, y: 54 },
      { text: "Num 5890043307984222", conf: 0.9, y: 88 },
      { text: "hello", conf: 0.7, y: 122 },
      { text: "world", conf: 0.7, y: 156 },
      { text: "thank you", conf: 0.7, y: 190 },
    ],
    detected
  );
}

function makePng(bandY: number[], height = 260): Buffer {
  const w = 60;
  const h = height;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ink = bandY.includes(y);
    for (let x = 0; x < w; x++) {
      const v = ink ? 30 : 240;
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const img: RawImage = { data, width: w, height: h };
  return Buffer.from(canvasFromImage(img).toBuffer("image/png"));
}

function okResult(texts: PaddleRescueResult["texts"], latencyMs = 10): PaddleRescueResult {
  return { engine: "paddleocr-en", texts, latencyMs };
}

function countingRequest(script: PaddleRescueResult["texts"]) {
  let calls = 0;
  const request = async (): Promise<PaddleRescueResult> => {
    calls += 1;
    return okResult(script);
  };
  return { request, calls: () => calls };
}

function rescueRecord(doc: OcrDocument): PaddleRescueRecord | undefined {
  return doc.meta?.paddleRescue as PaddleRescueRecord | undefined;
}

// ─── 1. Gate: healthy documents never call Paddle ───────────────────────────

test("healthy doc (recall not detected) → skipped, zero requests", async () => {
  const { request, calls } = countingRequest([]);
  const doc = makeProblemDoc(false);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.skippedReason, "recall_not_detected");
  equal(calls(), 0, "no request for a healthy doc");
  equal(out.doc.text, doc.text, "document untouched");
});

test("no recall recovery record → skipped, zero requests", async () => {
  const { request, calls } = countingRequest([]);
  const doc = makeDoc([{ text: "TOTAL 38.40", conf: 0.9, y: 20 }], false);
  delete (doc.meta as Record<string, unknown>).recallRecovery;
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.skippedReason, "recall_not_detected");
  equal(calls(), 0);
});

test("insufficient budget → skipped before any request", async () => {
  const { request, calls } = countingRequest([]);
  const out = await runPaddleRescue(makeProblemDoc(), {
    buffer: makePng([10]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: PADDLE_MIN_BUDGET_MS - 1,
    url: "http://mock",
    request,
  });
  equal(out.record.skippedReason, "budget_too_small");
  equal(calls(), 0);
});

test("missing PADDLE_OCR_URL → graceful skip, zero requests", async () => {
  const { request, calls } = countingRequest([]);
  const out = await runPaddleRescue(makeProblemDoc(), {
    buffer: makePng([10]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    request,
  });
  equal(out.record.skippedReason, "paddle_unavailable");
  equal(calls(), 0);
});

// ─── 2. Primary protection: a valid primary is never replaced ───────────────

test("valid primary stays even when Paddle reads a conflicting value (607021830113216 never becomes 6070218301132157)", async () => {
  const { request, calls } = countingRequest([{ text: "6070218301132157", confidence: 1.0 }]);
  const doc = makeProblemDoc();
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(calls(), 1, "one anchored region re-read");
  includes(out.doc.text, "Transaction 607021830113216", "valid transaction untouched");
  equal(out.record.accepted, 1, "the invalid ref candidate was replaced");
  includes(out.doc.text, "Ref 6070218301132157", "invalid candidate accepted the reading");
  includes(out.record.attempts[0].reason, "1343786620]");
});

// ─── 3. Case A: anchored replacement of an invalid/ambiguous candidate ──────

test("invalid primary + deterministic-valid Paddle reading → anchored accept", async () => {
  const doc = makeDoc(
    [
      { text: "Tel: 011488-1212", conf: 0.7, y: 20 },
      { text: "Ref 607021830113216", conf: 0.9, y: 54 },
      { text: "Num 5890043307984222", conf: 0.9, y: 88 },
      { text: "hello", conf: 0.7, y: 122 },
      { text: "world", conf: 0.7, y: 156 },
      { text: "thank you", conf: 0.7, y: 190 },
    ]
  );
  const { request } = countingRequest([{ text: "0114881212", confidence: 1.0 }]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 1);
  includes(out.doc.text, "Tel: 0114881212", "invalid phone replaced by valid reading");
  ok(!out.doc.text.includes("011488-1212"), "dashed phone gone");
});

test("Case A: Paddle reading invalid → rejected, primary kept", async () => {
  const doc = makeDoc(
    [
      { text: "Tel: 011488-1212", conf: 0.7, y: 20 },
      { text: "Ref 607021830113216", conf: 0.9, y: 54 },
      { text: "Num 5890043307984222", conf: 0.9, y: 88 },
      { text: "hello", conf: 0.7, y: 122 },
      { text: "world", conf: 0.7, y: 156 },
      { text: "thank you", conf: 0.7, y: 190 },
    ]
  );
  const { request } = countingRequest([{ text: "0l1-488-1212", confidence: 0.99 }]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 0);
  equal(out.record.attempts[0].rejected[0].reason, "paddle_invalid");
  includes(out.doc.text, "Tel: 011488-1212", "primary kept");
});

// ─── 4. Case B: missing value recovered via label region insertion ──────────

test("Case B: label line without value + Paddle reading → line inserted", async () => {
  const doc = makeDoc(
    [
      { text: "Ref 607021830113216", conf: 0.9, y: 20 },
      { text: "Num 5890043307984222", conf: 0.9, y: 54 },
      { text: "Code 1343786620", conf: 0.9, y: 88 },
      { text: "TOTAL", conf: 0.7, y: 150 },
      { text: "hello", conf: 0.7, y: 190 },
      { text: "world", conf: 0.7, y: 224 },
    ]
  );
  const { request } = countingRequest([{ text: "TOTAL 38.40", bbox: { x: 20, y: 150, width: 130, height: 20 }, confidence: 1.0 }]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 1);
  includes(out.doc.text, "TOTAL 38.40", "value line inserted with its label");
  equal(out.record.attempts[0].region, "label");
});

test("Case B: value already present in the doc → rejected, no duplicate", async () => {
  const doc = makeDoc(
    [
      { text: "Ref 607021830113216", conf: 0.9, y: 20 },
      { text: "Num 5890043307984222", conf: 0.9, y: 54 },
      { text: "Code 1343786620", conf: 0.9, y: 88 },
      { text: "TOTAL 38.40", conf: 0.9, y: 122 },
      { text: "CASH", conf: 0.7, y: 156 },
      { text: "hello", conf: 0.7, y: 190 },
    ]
  );
  const { request } = countingRequest([{ text: "CASH 38.40", bbox: { x: 20, y: 156, width: 130, height: 20 }, confidence: 1.0 }]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 0);
  equal(out.record.attempts[0].rejected[0].reason, "value_already_present");
});

// ─── 5. No numeric problem → no rescue ──────────────────────────────────────

test("all candidates valid, no label gaps, no collapse → no_numeric_problem", async () => {
  const doc = makeDoc(
    [
      { text: "Ref 607021830113216", conf: 0.9, y: 20 },
      { text: "Num 5890043307984222", conf: 0.9, y: 54 },
      { text: "Code 1343786620", conf: 0.9, y: 88 },
      { text: "hello", conf: 0.7, y: 122 },
      { text: "world", conf: 0.7, y: 156 },
      { text: "thank you", conf: 0.7, y: 190 },
    ]
  );
  const { request, calls } = countingRequest([]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.skippedReason, "no_numeric_problem");
  equal(calls(), 0);
});

// ─── 6. Conflict rule: a valid primary in the same region blocks the reading ─

test("Paddle reading conflicting with a valid Tesseract primary in the same region → rejected, primary kept", async () => {
  const doc = makeDoc(
    [
      { text: "TOTAL 38.40", conf: 0.9, y: 20 },
      { text: "CASH", conf: 0.7, y: 20 },
      { text: "Ref 607021830113216", conf: 0.9, y: 90 },
      { text: "Num 5890043307984222", conf: 0.9, y: 124 },
      { text: "hello", conf: 0.7, y: 158 },
      { text: "world", conf: 0.7, y: 192 },
    ]
  );
  // CASH line bbox overlaps the valid TOTAL region (same y band).
  const { request } = countingRequest([{ text: "CASH 11.60", bbox: { x: 10, y: 20, width: 110, height: 18 }, confidence: 1.0 }]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 0);
  equal(out.record.attempts[0].rejected[0].reason, "conflict_with_valid_primary");
  includes(out.doc.text, "TOTAL 38.40", "valid primary kept");
  ok(!out.doc.text.includes("11.60"), "conflicting reading never inserted");
});

// ─── 7. Graceful failure modes ──────────────────────────────────────────────

test("Paddle timeout → graceful attempt error, document untouched", async () => {
  const doc = makeProblemDoc();
  const request = async (): Promise<PaddleRescueResult> => ({
    engine: "paddleocr-ar",
    texts: [],
    latencyMs: 3000,
    error: "paddle_timeout",
  });
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.attempts[0].error, "paddle_timeout");
  equal(out.doc.text, doc.text, "document untouched on timeout");
});

test("low-confidence Paddle reading → rejected", async () => {
  const doc = makeProblemDoc();
  const { request } = countingRequest([{ text: "1343786620", confidence: 0.6 }]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 0);
  equal(out.record.attempts[0].rejected[0].reason, "paddle_low_conf");
  includes(out.doc.text, "Ref 1343786620]", "primary kept");
});

// ─── 8. Region budget: at most 3 regions ────────────────────────────────────

test("more problem candidates than the region cap → at most 3 requests", async () => {
  const doc = makeDoc(
    [
      { text: "A 011488-1212", conf: 0.7, y: 20 },
      { text: "B 011488-1213", conf: 0.7, y: 54 },
      { text: "C 011488-1214", conf: 0.7, y: 88 },
      { text: "D 011488-1215", conf: 0.7, y: 122 },
      { text: "E 011488-1216", conf: 0.7, y: 156 },
      { text: "hello world", conf: 0.7, y: 190 },
    ]
  );
  const { request, calls } = countingRequest([{ text: "0114881212", confidence: 1.0 }]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(calls(), PADDLE_MAX_REGIONS, `capped at ${PADDLE_MAX_REGIONS} region requests`);
  equal(out.record.regions.length, PADDLE_MAX_REGIONS);
});

// ─── 10. Paired insertion: spatial adjacency (semantic attribution) ─────────

test("Case B: label and value lines too far apart → pair rejected, no fabricated label", async () => {
  const doc = makeDoc(
    [
      { text: "Ref 607021830113216", conf: 0.9, y: 20 },
      { text: "Num 5890043307984222", conf: 0.9, y: 54 },
      { text: "Code 1343786620", conf: 0.9, y: 88 },
      { text: "TOTAL", conf: 0.7, y: 150 },
      { text: "hello", conf: 0.7, y: 190 },
      { text: "world", conf: 0.7, y: 224 },
    ]
  );
  // "38.40" sits 376px below its pending line: no safe merge is possible.
  const { request } = countingRequest([
    { text: "Thank you for shopping", bbox: { x: 20, y: 100, width: 220, height: 24 }, confidence: 1.0 },
    { text: "38.40", bbox: { x: 300, y: 500, width: 60, height: 24 }, confidence: 1.0 },
  ]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 0, "no fabricated insertion");
  equal(out.record.attempts[0].rejected[0].reason, "pair_not_adjacent");
  ok(!out.doc.text.includes("38.40"), "distant value never inserted without its label");
  ok(!out.doc.text.includes("Thank you for shopping 38.40"), "no merged fabricated label");
});

// ─── 4b. Missing-field region: pairing contract applies here too ────────────

test("missing_field: bare standalone numeric reading → rejected, never inserted", async () => {
  const doc = makeDoc(
    [
      { text: "Ref 607021830113216", conf: 0.9, y: 20 },
      { text: "Num 5890043307984222", conf: 0.9, y: 54 },
      { text: "Code 1343786620", conf: 0.9, y: 88 },
      { text: "TOTAL", conf: 0.7, y: 150 },
      { text: "hello", conf: 0.7, y: 190 },
      { text: "world", conf: 0.7, y: 224 },
    ]
  );
  // No label line at all — a bare value can never be attributed.
  const { request } = countingRequest([
    { text: "38.40", bbox: { x: 300, y: 300, width: 60, height: 24 }, confidence: 1.0 },
  ]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 0, "bare value never accepted");
  ok(
    out.record.attempts.some((a) => a.rejected.some((r) => r.reason === "value_without_label")),
    "rejection reason recorded"
  );
  ok(!out.doc.text.includes("38.40"), "value never appears as a bare OCR line");
});

test("missing_field: distant label/value pair → rejected, no fabrication", async () => {
  const doc = makeDoc(
    [
      { text: "Ref 607021830113216", conf: 0.9, y: 20 },
      { text: "Num 5890043307984222", conf: 0.9, y: 54 },
      { text: "Code 1343786620", conf: 0.9, y: 88 },
      { text: "TOTAL", conf: 0.7, y: 150 },
      { text: "hello", conf: 0.7, y: 190 },
      { text: "world", conf: 0.7, y: 224 },
    ]
  );
  // "TOTAL" and "38.40" are far apart — pairing is unsafe.
  const { request } = countingRequest([
    { text: "TOTAL", bbox: { x: 20, y: 100, width: 80, height: 24 }, confidence: 1.0 },
    { text: "38.40", bbox: { x: 300, y: 500, width: 60, height: 24 }, confidence: 1.0 },
  ]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 0, "distant pair never accepted");
  ok(
    out.record.attempts.some((a) => a.rejected.some((r) => r.reason === "pair_not_adjacent")),
    "pair_not_adjacent recorded"
  );
  ok(!out.doc.text.includes("38.40"), "distant value never inserted");
});

test("missing_field: adjacent trustworthy pair → accepted with its label", async () => {
  const doc = makeDoc(
    [
      { text: "Ref 607021830113216", conf: 0.9, y: 20 },
      { text: "Num 5890043307984222", conf: 0.9, y: 54 },
      { text: "Code 1343786620", conf: 0.9, y: 88 },
      { text: "TOTAL", conf: 0.7, y: 150 },
      { text: "hello", conf: 0.7, y: 190 },
      { text: "world", conf: 0.7, y: 224 },
    ]
  );
  const { request } = countingRequest([
    { text: "TOTAL", bbox: { x: 20, y: 100, width: 80, height: 24 }, confidence: 1.0 },
    { text: "38.40", bbox: { x: 300, y: 130, width: 60, height: 24 }, confidence: 1.0 },
  ]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  ok(out.record.accepted >= 1, "trustworthy pair accepted");
  includes(out.doc.text, "TOTAL 38.40", "recovered line carries its label");
});

test("Case B: adjacent label + value lines merge into one recovered line", async () => {
  const doc = makeDoc(
    [
      { text: "Ref 607021830113216", conf: 0.9, y: 20 },
      { text: "Num 5890043307984222", conf: 0.9, y: 54 },
      { text: "Code 1343786620", conf: 0.9, y: 88 },
      { text: "TOTAL", conf: 0.7, y: 150 },
      { text: "hello", conf: 0.7, y: 190 },
      { text: "world", conf: 0.7, y: 224 },
    ]
  );
  const { request } = countingRequest([
    { text: "Sugar 1kg", bbox: { x: 20, y: 100, width: 100, height: 24 }, confidence: 0.99 },
    { text: "6.50", bbox: { x: 300, y: 134, width: 50, height: 24 }, confidence: 1.0 },
  ]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 1);
  includes(out.doc.text, "Sugar 1kg 6.50", "adjacent pair merged into one line");
});

// ─── 11. HTTP client: wire-contract validation (real requestPaddleRescue) ───

async function startRawServer(
  respond: (rawBody: string) => { status: number; body: string }
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = respond(body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("client: malformed JSON response → graceful paddle_unreachable, zero texts", async () => {
  const server = await startRawServer(() => ({ status: 200, body: "{not json" }));
  try {
    const res = await requestPaddleRescue(Buffer.from("x"), { url: server.url });
    equal(res.error, "paddle_unreachable");
    equal(res.texts.length, 0);
  } finally {
    await server.close();
  }
});

test("client: items with invalid fields are dropped (no confidence / bad bbox / blank text)", async () => {
  const server = await startRawServer(() => ({
    status: 200,
    body: JSON.stringify({
      texts: [
        { text: "38.40" },
        { text: "50.00", confidence: 0.99, bbox: { x: 1, y: 2, width: 0, height: 10 } },
        { text: "11.60", confidence: 0.99, bbox: { x: 1, y: 2, width: 10, height: 10 } },
        { text: "  ", confidence: 0.99, bbox: { x: 1, y: 2, width: 10, height: 10 } },
      ],
    }),
  }));
  try {
    const res = await requestPaddleRescue(Buffer.from("x"), { url: server.url });
    equal(res.texts.length, 1, "only the fully valid item survives");
    equal(res.texts[0].text, "11.60");
  } finally {
    await server.close();
  }
});

test("client: confidence 95 is normalized to 0.95", async () => {
  const server = await startRawServer(() => ({
    status: 200,
    body: JSON.stringify({
      texts: [{ text: "38.40", confidence: 95, bbox: { x: 1, y: 2, width: 10, height: 10 } }],
    }),
  }));
  try {
    const res = await requestPaddleRescue(Buffer.from("x"), { url: server.url });
    equal(res.texts.length, 1);
    equal(res.texts[0].confidence, 0.95);
  } finally {
    await server.close();
  }
});

test("client: response without a texts field → empty reading, no error", async () => {
  const server = await startRawServer(() => ({ status: 200, body: JSON.stringify({ engine: "paddleocr-en" }) }));
  try {
    const res = await requestPaddleRescue(Buffer.from("x"), { url: server.url });
    equal(res.texts.length, 0);
    ok(res.error === undefined, "no error for a valid response without texts");
  } finally {
    await server.close();
  }
});

// ─── 12. Conflict rule: same-kind only (documented row=field limit) ─────────

test("cross-kind reading on a row with a valid primary of another kind → accepted", async () => {
  const doc = makeDoc(
    [
      { text: "TOTAL 38.40", conf: 0.9, y: 20 },
      { text: "CASH", conf: 0.7, y: 20 },
      { text: "Ref 607021830113216", conf: 0.9, y: 90 },
      { text: "Num 5890043307984222", conf: 0.9, y: 124 },
      { text: "hello", conf: 0.7, y: 158 },
      { text: "world", conf: 0.7, y: 192 },
    ]
  );
  // CASH is a label region on the same row as the valid TOTAL 38.40 (amount).
  // A reference-kind reading on that row has a DIFFERENT kind → the row-conflict
  // rule does not fire; the insertion is gated by validation/presence only.
  const { request } = countingRequest([{ text: "CASH 0114881212", bbox: { x: 10, y: 20, width: 150, height: 18 }, confidence: 1.0 }]);
  const out = await runPaddleRescue(doc, {
    buffer: makePng([10, 50]),
    exif: 1,
    engine: "paddleocr-ar",
    budgetMs: 20_000,
    url: "http://mock",
    request,
  });
  equal(out.record.accepted, 1, "cross-kind reading is not row-conflicted");
  includes(out.doc.text, "CASH 0114881212", "reference inserted on the amount row");
  includes(out.doc.text, "TOTAL 38.40", "valid primary untouched");
});

// ─── 9. Integration: real pipeline + local mock HTTP service ────────────────

// The real PaddleOCR reading captured for the scan-blur fixture (PP-OCRv6_medium).
const SCANBLUR_READING: Array<{ text: string; confidence: number; bbox: { x: number; y: number; width: number; height: number } }> = [
  ["AL RABIH SUPERMARKET", 1.0],
  ["Riyadh, KSA Tel: 011-555-1212", 0.984],
  ["Date: 2025-01-15 15:42", 0.988],
  ["Sugar 1kg", 1.0],
  ["6.50", 1.0],
  ["Milk 1L", 0.998],
  ["7.00", 1.0],
  ["Rice 5kg", 1.0],
  ["24.90", 1.0],
  ["TOTAL", 1.0],
  ["38.40", 1.0],
  ["Cash", 1.0],
  ["50.00", 0.999],
  ["Change", 1.0],
  ["11.60", 1.0],
  ["Thank you for shopping", 0.96],
].map(([text, confidence], i) => ({
  text,
  confidence,
  bbox: { x: 20, y: 26 + 34 * i, width: Math.max(60, text.length * 7), height: 24 },
}));

async function startMockServer(script: typeof SCANBLUR_READING): Promise<{
  url: string;
  requests: () => number;
  close: () => Promise<void>;
}> {
  let count = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      count += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ engine: "paddleocr-en", texts: script, latency_ms: 180 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function renderReceipt(blur = false): Promise<Buffer> {
  const lines: Array<[string, string]> = [
    ["", ""],
    ["AL RABIH SUPERMARKET", "fs22"],
    ["Riyadh, KSA  Tel: 011-555-1212", "fs13"],
    ["Date: 2025-01-15  15:42", "fs13"],
    ["----------------------------", "fs13"],
    ["Sugar 1kg                  6.50", "fs15"],
    ["Milk 1L                    7.00", "fs15"],
    ["Rice 5kg                  24.90", "fs15"],
    ["----------------------------", "fs13"],
    ["TOTAL                     38.40", "fs18"],
    ["Cash                      50.00", "fs15"],
    ["Change                    11.60", "fs15"],
    ["Thank you for shopping", "fs13"],
  ];
  const pt = (s: string) => parseInt(s.slice(2), 10) || 16;
  const lineH = 34;
  const h = lines.length * lineH + 30;
  const canvas = createCanvas(520, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 26;
  for (const [text, fs] of lines) {
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `bold ${pt(fs)}px Arial`;
    ctx.fillText(text, 24, y);
    y += lineH;
  }
  const png = canvas.toBuffer("image/png");
  if (!blur) return png;
  const loaded = await loadImage(png);
  const w = loaded.width;
  const hh = loaded.height;
  const big = createCanvas(w, hh);
  const bctx = big.getContext("2d");
  try {
    bctx.filter = "blur(1.5px)";
    bctx.drawImage(loaded as any, 0, 0, w, hh);
    bctx.filter = "none";
  } catch {
    bctx.filter = "none";
    const small = createCanvas(Math.max(2, Math.round(w / 3)), Math.max(2, Math.round(hh / 3)));
    const sctx = small.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(loaded as any, 0, 0, small.width, small.height);
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "low";
    bctx.drawImage(small as any, 0, 0, w, hh);
  }
  return big.toBuffer("image/png");
}

test("integration: scan-blur-like rescue accepted via mock HTTP service", async () => {
  const png = await renderReceipt(true);
  const server = await startMockServer(SCANBLUR_READING);
  try {
    process.env.PADDLE_OCR_URL = server.url;
    const doc = await recognizeMainThread(png, "ara+eng", {
      recoverRecall: true,
      verifyNumerics: true,
      rescuePaddle: true,
    });
    const rec = rescueRecord(doc);
    ok(rec?.triggered === true, `rescue triggered (got ${rec?.skippedReason ?? "none"})`);
    ok(server.requests() >= 1, "at least one region request hit the mock service");
    includes(doc.text, "38.40", "total recovered");
    includes(doc.text, "50.00", "cash recovered");
    includes(doc.text, "11.60", "change recovered");
  } finally {
    delete process.env.PADDLE_OCR_URL;
    await server.close();
  }
});

test("integration: healthy document makes zero requests", async () => {
  const png = await renderReceipt(false);
  const server = await startMockServer([]);
  try {
    process.env.PADDLE_OCR_URL = server.url;
    const doc = await recognizeMainThread(png, "ara+eng", {
      recoverRecall: true,
      verifyNumerics: true,
      rescuePaddle: true,
    });
    const rec = rescueRecord(doc);
    equal(server.requests(), 0, "no region request for a healthy doc");
    equal(rec?.skippedReason, "recall_not_detected");
  } finally {
    delete process.env.PADDLE_OCR_URL;
    await server.close();
  }
});

test("integration: service unavailable → pipeline continues, no crash", async () => {
  const png = await renderReceipt(true);
  const dead = await startMockServer([]);
  const deadPort = dead.url;
  await dead.close();
  try {
    process.env.PADDLE_OCR_URL = deadPort;
    const doc = await recognizeMainThread(png, "ara+eng", {
      recoverRecall: true,
      verifyNumerics: true,
      rescuePaddle: true,
    });
    includes(doc.text, "AL RABIH", "pipeline continued past the failed rescue");
    const rec = rescueRecord(doc);
    assert(rec !== undefined, "rescue record attached");
    ok(
      rec.attempts.length > 0 && rec.attempts.some((a) => a.error === "paddle_unreachable"),
      "graceful unreachable error recorded"
    );
  } finally {
    delete process.env.PADDLE_OCR_URL;
  }
});