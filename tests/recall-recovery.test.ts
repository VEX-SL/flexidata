/**
 * Unit tests for OCR Recall Recovery (detector, scorer, planning, budgeted
 * orchestration). Pure deterministic logic — the recognition callback is a
 * fake, so no tesseract engine is loaded.
 */
import {
  MAX_RECOVERY_ATTEMPTS,
  MIN_RECOVERY_BUDGET_MS,
  RECOVERY_WIN_MARGIN,
  computeDocMetrics,
  computeImageStats,
  detectRecallCollapse,
  planRecoveryVariants,
  runRecallRecovery,
  scoreOcrCandidate,
  type ImageStats,
  type RecoveryVariant,
} from "@/lib/ocr/recall";
import { canvasFromImage, type RawImage } from "@/lib/ocr/preprocess";
import type { OcrDocument, OcrLine } from "@/lib/pipeline/types";
import { test, ok, equal, assert } from "./harness.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface LineSpec {
  text: string;
  conf: number;
  y: number;
  height?: number;
  noise?: number;
}

function makeDoc(lineSpecs: LineSpec[], height: number): OcrDocument {
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
      bbox: {
        x: 10,
        y: s.y,
        width: 480,
        height: s.height ?? 18,
      },
      quality: { noiseScore: s.noise ?? 0, arabicRatio: 0, latinRatio: 0, printableRatio: 1, scriptConsistency: 1, ocrConfidence: s.conf, reasons: [] },
    } as OcrLine;
  });
  return {
    text: lines.map((l) => l.text).join("\n"),
    language: "ara+eng",
    confidence: lineSpecs.reduce((s, l) => s + l.conf, 0) / Math.max(1, lineSpecs.length),
    lines,
  } as OcrDocument;
}

function stats(over: Partial<ImageStats>): ImageStats {
  return {
    width: 520,
    height: 438,
    inkTop: 10,
    inkBottom: 420,
    inkSpanRatio: 0.93,
    textDensity: 0.1,
    verticalText: false,
    lowContrast: false,
    ...over,
  };
}

function makePng(bandY: number[], height = 120): Buffer {
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

// Full-ink-span 300px page: matches a real receipt that occupies most of the
// scan height, so truncation signals resolve correctly for 5-line docs.
function makeTallPng(): Buffer {
  const bands: number[] = [];
  for (let y = 10; y <= 290; y += 40) bands.push(y);
  return makePng(bands, 300);
}

// ─── computeImageStats (pure pixel math) ───────────────────────────────────

test("computeImageStats finds the ink band and flags vertical text", () => {
  const w = 40;
  const h = 100;
  const data = new Uint8ClampedArray(w * h * 4);
  // Vertical text lines: 3 dark columns; rows carry uniform ink.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ink = x === 5 || x === 20 || x === 35;
      const v = ink ? 20 : 245;
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const s = computeImageStats({ data, width: w, height: h });
  ok(s.inkSpanRatio > 0.9, `ink span covers the page (${s.inkSpanRatio})`);
  ok(s.verticalText, "3 thin vertical columns read as vertical text");
});

test("computeImageStats reports low contrast on a flat image", () => {
  const w = 40;
  const h = 60;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 180 + ((y % 2) * 10);
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const s = computeImageStats({ data, width: w, height: h });
  ok(s.lowContrast, "flat gray image is flagged low contrast");
});

// ─── Detector ───────────────────────────────────────────────────────────────

const FULL_DOC = makeDoc(
  [
    { text: "AL RABIH SUPERMARKET", conf: 0.95, y: 20, height: 26 },
    { text: "Riyadh, KSA Tel: 011-555-1212", conf: 0.94, y: 60 },
    { text: "Date: 2025-01-15 15:42", conf: 0.93, y: 94 },
    { text: "Sugar 1kg 6.50", conf: 0.95, y: 128 },
    { text: "Milk 1L 7.00", conf: 0.95, y: 162 },
    { text: "Rice 5kg 24.90", conf: 0.95, y: 196 },
    { text: "TOTAL 38.40", conf: 0.96, y: 230, height: 24 },
    { text: "Cash 50.00", conf: 0.96, y: 264 },
    { text: "Change 11.60", conf: 0.96, y: 298 },
    { text: "Thank you for shopping", conf: 0.94, y: 332 },
  ],
  438
);

const ROT90_LIKE = makeDoc(
  [
    { text: "AL RABIH SUPERMAR", conf: 0.92, y: 20, height: 26 },
    { text: "Riyadh, KSA Tel: 011-555-1212", conf: 0.93, y: 60 },
    { text: "Date: 2025-01-15 15:42", conf: 0.92, y: 94 },
    { text: "Sugar 1kg 6.50", conf: 0.92, y: 128 },
    { text: "Milk 11 7.00", conf: 0.92, y: 162 },
  ],
  438
);

const BLUR_LIKE = makeDoc(
  [{ text: "AL RABIH SUPERMARKET", conf: 0.9, y: 20, height: 26 }],
  438
);

const SHORT_DOC = makeDoc(
  [
    { text: "Note for the driver", conf: 0.95, y: 20 },
    { text: "Please deliver after noon", conf: 0.94, y: 54 },
    { text: "Thanks", conf: 0.95, y: 88 },
  ],
  438
);

test("detector: healthy full document is not suspicious", () => {
  const d = detectRecallCollapse(FULL_DOC, stats({}));
  ok(!d.suspicious, `healthy doc flagged: ${d.signals.join(",")}`);
});

test("detector: rot90-like collapse (5 top lines, high confidence) is suspicious", () => {
  const d = detectRecallCollapse(
    ROT90_LIKE,
    stats({ verticalText: true, lowContrast: true })
  );
  ok(d.suspicious, `rot90-like doc not flagged: ${d.signals.join(",")}`);
  ok(d.signals.includes("truncation"), "confident-truncation signal present");
});

test("detector: slant/layout collapse (5 lines, horizontal) is suspicious", () => {
  const d = detectRecallCollapse(ROT90_LIKE, stats({}));
  ok(d.suspicious, `slant-like doc not flagged: ${d.signals.join(",")}`);
  ok(d.signals.includes("truncation") && d.signals.includes("bottom"), "truncation + bottom signals present");
});

test("detector: blur collapse (1 line, full ink) is suspicious", () => {
  const d = detectRecallCollapse(BLUR_LIKE, stats({ lowContrast: true }));
  ok(d.suspicious, `blur-like doc not flagged: ${d.signals.join(",")}`);
  ok(d.signals.includes("lines"), "few-lines signal present");
});

test("detector: short legitimate document is NOT suspicious", () => {
  const d = detectRecallCollapse(
    SHORT_DOC,
    stats({ inkSpanRatio: 0.2, inkTop: 10, inkBottom: 98 })
  );
  ok(!d.suspicious, `short doc flagged: ${d.signals.join(",")}`);
});

test("detector: low-confidence garbage without truncation is not flagged by conf alone", () => {
  const garbage = makeDoc(
    Array.from({ length: 10 }, (_, i) => ({ text: `g${i} %%% ###`, conf: 0.5, y: 20 + i * 30, noise: 0.9 })),
    438
  );
  const d = detectRecallCollapse(garbage, stats({}));
  // garbage has full coverage → not a truncation; noise dominates → flagged noise
  const m = computeDocMetrics(garbage, stats({}));
  ok(m.noiseLineRatio > 0.4, "garbage lines carry high noise ratio");
  ok(d.suspicious, "noise-dominated doc is flagged");
});

// ─── Scorer ─────────────────────────────────────────────────────────────────

test("scorer: higher useful coverage wins", () => {
  const s = stats({});
  const full = scoreOcrCandidate(FULL_DOC, s);
  const partial = scoreOcrCandidate(ROT90_LIKE, s);
  ok(full > partial, `full doc (${full.toFixed(3)}) must score above partial (${partial.toFixed(3)})`);
});

test("scorer: garbage-heavy candidate loses to a clean primary", () => {
  const s = stats({});
  const primary = makeDoc(
    [
      { text: "AL RABIH SUPERMARKET", conf: 0.92, y: 20, height: 26 },
      { text: "Date: 2025-01-15 15:42", conf: 0.92, y: 60 },
      { text: "Sugar 1kg 6.50", conf: 0.92, y: 94 },
      { text: "Milk 1L 7.00", conf: 0.92, y: 128 },
      { text: "TOTAL 38.40", conf: 0.92, y: 162, height: 24 },
    ],
    438
  );
  const garbage = makeDoc(
    [
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 20, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 54, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 88, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 122, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 156, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 190, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 224, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 258, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 292, noise: 0.9 },
      { text: "aa aaa aaaa aaaaa aaaaaa", conf: 0.55, y: 326, noise: 0.9 },
    ],
    438
  );
  const p = scoreOcrCandidate(primary, s);
  const g = scoreOcrCandidate(garbage, s);
  ok(p > g, `clean primary (${p.toFixed(3)}) must beat garbage (${g.toFixed(3)})`);
});

test("scorer: low-confidence garbage does not beat a clean primary", () => {
  const s = stats({});
  // Clean primary = the realistic collapse case: few readable lines, high conf.
  const clean = makeDoc(
    [
      { text: "AL RABIH SUPERMARKET", conf: 0.92, y: 20, height: 26 },
      { text: "Sugar 1kg 6.50", conf: 0.92, y: 60 },
      { text: "Milk 1L 7.00", conf: 0.92, y: 94 },
      { text: "Rice 5kg 24.90", conf: 0.92, y: 128 },
      { text: "TOTAL 38.40", conf: 0.92, y: 162, height: 24 },
    ],
    438
  );
  // Garbage = the binary/sharpen pass on a blurred scan: fragment soup,
  // low confidence, high noise, low diversity.
  const garbage = makeDoc(
    [
      { text: "T 00", conf: 0.42, y: 10, noise: 0.9 },
      { text: "U.", conf: 0.4, y: 40, noise: 0.9 },
      { text: "ne", conf: 0.38, y: 70, noise: 0.9 },
      { text: "U^1", conf: 0.41, y: 100, noise: 0.9 },
      { text: "1f", conf: 0.37, y: 130, noise: 0.9 },
      { text: "%% ##", conf: 0.35, y: 160, noise: 0.95 },
      { text: "T 00", conf: 0.42, y: 190, noise: 0.9 },
      { text: "U.", conf: 0.4, y: 220, noise: 0.9 },
      { text: "ne", conf: 0.38, y: 250, noise: 0.9 },
      { text: "a", conf: 0.3, y: 280, noise: 0.95 },
    ],
    438
  );
  const c = scoreOcrCandidate(clean, s);
  const j = scoreOcrCandidate(garbage, s);
  ok(c > j, `clean primary (${c.toFixed(3)}) must beat garbage soup (${j.toFixed(3)})`);
});

// ─── Planning ───────────────────────────────────────────────────────────────

test("planning: at most MAX_RECOVERY_ATTEMPTS variants, failure-class order", () => {
  const orientation = planRecoveryVariants(
    stats({ verticalText: true }),
    ["vertical", "lowDensity"]
  );
  equal(orientation[0], { kind: "rotate", angle: 90 }, "orientation first");
  ok(orientation.length <= MAX_RECOVERY_ATTEMPTS, `planned ${orientation.length} > ${MAX_RECOVERY_ATTEMPTS}`);

  const preprocessing = planRecoveryVariants(
    stats({ lowContrast: true }),
    ["lowContrast", "lowDensity"]
  );
  const labels = preprocessing.map((v) => (v.kind === "psm" ? "psm" : v.kind));
  ok(labels.indexOf("binary") < labels.indexOf("psm"), "preprocessing before PSM");
  ok(labels.indexOf("binary") < labels.indexOf("sharpen"), "binary before sharpen");
  ok(preprocessing.length <= MAX_RECOVERY_ATTEMPTS, `planned ${preprocessing.length} > ${MAX_RECOVERY_ATTEMPTS}`);
});

test("planning: no signals → no variants", () => {
  equal(planRecoveryVariants(stats({}), []).length, 0);
});

// ─── Orchestration (budget, attempts, early stop, fallback preservation) ───

async function runRecovery(
  doc: OcrDocument,
  opts: {
    budgetMs?: number;
    recognize?: (buf: Buffer, exif: number, psm?: number) => Promise<OcrDocument>;
    variants?: RecoveryVariant[];
  } = {}
) {
  let calls = 0;
  const png = makeTallPng();
  const fakeRecognize = opts.recognize ?? (async () => {
    calls++;
    return doc;
  });
  const out = await runRecallRecovery(doc, { buf: png, exif: 1 }, { budgetMs: opts.budgetMs ?? 20_000, recognize: fakeRecognize });
  return { ...out, calls };
}

test("recovery: healthy primary → 0 attempts, doc unchanged (additive; existing fallback preserved)", async () => {
  const { doc, calls, record } = await runRecovery(FULL_DOC);
  equal(calls, 0, "no recognition passes on a healthy doc");
  ok(!record.detected, "not flagged");
  equal(doc, FULL_DOC, "primary doc returned untouched");
});

test("recovery: insufficient remaining budget → skipped, primary kept, reason recorded", async () => {
  const { doc, calls, record } = await runRecovery(ROT90_LIKE, { budgetMs: MIN_RECOVERY_BUDGET_MS - 1 });
  equal(calls, 0, "no passes under the minimum budget");
  equal(record.skippedReason, "remaining_budget_insufficient");
  equal(record.selected, "primary");
  equal(doc, ROT90_LIKE);
});

test("recovery: max 3 attempts when nothing wins", async () => {
  const { calls, record } = await runRecovery(ROT90_LIKE);
  ok(record.detected, "suspicious doc flagged");
  ok(calls <= MAX_RECOVERY_ATTEMPTS, `calls=${calls} exceeded ${MAX_RECOVERY_ATTEMPTS}`);
  equal(calls, record.attempts);
  equal(record.selected, "primary", "no candidate won by margin");
});

test("recovery: early stop when the first candidate clearly wins", async () => {
  let calls = 0;
  const winner = makeDoc(
    [
      { text: "AL RABIH SUPERMARKET", conf: 0.97, y: 20, height: 26 },
      { text: "Date: 2025-01-15 15:42", conf: 0.96, y: 60 },
      { text: "Sugar 1kg 6.50", conf: 0.96, y: 94 },
      { text: "Milk 1L 7.00", conf: 0.96, y: 128 },
      { text: "Rice 5kg 24.90", conf: 0.96, y: 162 },
      { text: "TOTAL 38.40", conf: 0.97, y: 196, height: 24 },
      { text: "Cash 50.00", conf: 0.97, y: 230 },
      { text: "Change 11.60", conf: 0.97, y: 264 },
      { text: "Thank you for shopping", conf: 0.96, y: 298 },
    ],
    438
  );
  const { doc, record } = await runRecovery(ROT90_LIKE, {
    recognize: async () => {
      calls++;
      return winner;
    },
  });
  equal(calls, 1, "early stop after the first clearly-better candidate");
  equal(record.selected, "candidate");
  equal(doc, winner);
});

test("recovery: tie/weak candidate keeps the primary (margin enforced)", async () => {
  let calls = 0;
  const { doc, record } = await runRecovery(ROT90_LIKE, {
    recognize: async () => {
      calls++;
      return ROT90_LIKE; // identical doc → identical score → tie
    },
  });
  equal(record.selected, "primary", "tie keeps primary");
  equal(doc, ROT90_LIKE);
  ok(calls > 0, "candidate was actually evaluated");
  const margin = (record.margin ?? 0);
  ok(margin < RECOVERY_WIN_MARGIN, `margin ${margin.toFixed(3)} must stay under ${RECOVERY_WIN_MARGIN}`);
});

test("recovery: garbage candidate never replaces a clean primary", async () => {
  const garbage = makeDoc(
    Array.from({ length: 15 }, (_, i) => ({ text: `junk${i} %% $$ ##`, conf: 0.4, y: 10 + i * 24, noise: 0.95 })),
    438
  );
  const primary = makeDoc(
    [
      { text: "AL RABIH SUPERMARKET", conf: 0.92, y: 20, height: 26 },
      { text: "Date: 2025-01-15 15:42", conf: 0.92, y: 60 },
      { text: "Sugar 1kg 6.50", conf: 0.92, y: 94 },
      { text: "Milk 1L 7.00", conf: 0.92, y: 128 },
      { text: "TOTAL 38.40", conf: 0.92, y: 162, height: 24 },
    ],
    438
  );
  const { doc, record } = await runRecovery(primary, {
    recognize: async () => garbage,
  });
  equal(record.selected, "primary", "garbage must lose");
  equal(doc, primary);
});

test("recovery: PSM variants reuse the winning image (no render)", async () => {
  let psmSeen: number | undefined;
  let calls = 0;
  const winner = makeDoc(
    [
      { text: "AL RABIH SUPERMARKET", conf: 0.96, y: 20, height: 26 },
      { text: "Date: 2025-01-15 15:42", conf: 0.96, y: 60 },
      { text: "Sugar 1kg 6.50", conf: 0.96, y: 94 },
      { text: "Milk 1L 7.00", conf: 0.96, y: 128 },
      { text: "Rice 5kg 24.90", conf: 0.96, y: 162 },
      { text: "TOTAL 38.40", conf: 0.97, y: 196, height: 24 },
      { text: "Cash 50.00", conf: 0.97, y: 230 },
      { text: "Change 11.60", conf: 0.97, y: 264 },
      { text: "Thank you for shopping", conf: 0.96, y: 298 },
    ],
    438
  );
  const out = await runRecallRecovery(ROT90_LIKE, { buf: makeTallPng(), exif: 1 }, {
    budgetMs: 20_000,
    recognize: async (_buf, _exif, psm) => {
      calls++;
      psmSeen = psm;
      return winner;
    },
  });
  equal(calls, 1);
  equal(psmSeen, 11, "first layout-class attempt is PSM 11 on the same image");
  equal(out.record.selected, "candidate");
});