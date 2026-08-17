/**
 * OCR Recall Recovery — deterministic recovery for silently-collapsed OCR.
 *
 * Tesseract (PSM 3) can fail SILENTLY: it returns a clean-looking document
 * that covers only part of the page (a blurry scan yields one line; a layout
 * collapse drops the bottom half of a receipt). Mean confidence is NOT a
 * recall signal — a truncated document can carry 0.92 page confidence, which
 * is exactly why the old isPoorResult/isMediocreResult gates never fired on
 * these cases.
 *
 * This layer is purely additive and runs AFTER the existing raw-image
 * fallback inside recognizeMainThread:
 *
 *   primary → existing raw fallback → recall detector → targeted recovery
 *
 * Contract:
 *  - NO LLM anywhere; NO grounding / extraction as oracle. The detector and
 *    scorer consume ONLY OCR metadata (lines/words/bboxes/confidence) plus
 *    deterministic image statistics (ink span, projection bands, contrast).
 *  - Recovery starts only on a proven suspicion (≥2 deterministic signals).
 *  - At most MAX_RECOVERY_ATTEMPTS passes, ordered by failure class:
 *    orientation → adaptive/binary preprocessing → alternate PSM.
 *  - A candidate REPLACES the primary only when its score beats the primary
 *    by at least RECOVERY_WIN_MARGIN; ties keep the primary (cheapest, and
 *    the preprocessed image is already the safest input).
 *  - The whole pass runs inside the remaining OCR timeout budget
 *    (OCR_TIMEOUT_MS - elapsedPrimary). Insufficient budget → skip, primary
 *    kept, reason recorded in doc.meta.recallRecovery.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import { NOISE_THRESHOLD } from "@/lib/pipeline/text-quality";
import {
  adaptiveThreshold,
  applyOrientation,
  canvasFromImage,
  decodeToRgba,
  downsampleGray,
  inkBandCount,
  otsuThreshold,
  rgbaFromGray,
  rotateImage,
  rowProjectionVariance,
  scaleImage,
  sharpenGray,
  toGray,
  type RawImage,
} from "@/lib/ocr/preprocess";

// ─── Documented thresholds (calibration contract) ──────────────────────────

/** Hard OCR timeout used by file-parser.ts — the recovery budget derives from it. */
export const OCR_TIMEOUT_MS = 25_000;
/** Maximum recovery passes per document/page. */
export const MAX_RECOVERY_ATTEMPTS = 3;
/** A candidate must beat the primary score by at least this margin to win. */
export const RECOVERY_WIN_MARGIN = 0.08;
/** Below this remaining budget recovery is skipped entirely. */
export const MIN_RECOVERY_BUDGET_MS = 2_000;
/** Estimated cost of one recovery pass used for early budget decisions. */
export const ESTIMATED_ATTEMPT_MS = 600;

/** Images whose ink occupies less than this share of the height are "small content". */
export const SMALL_INK_SPAN_RATIO = 0.25;
/** "Confident truncation": recognized span under this share of the ink span… */
export const TRUNCATION_REL_COVERAGE = 0.6;
/** …while the mean confidence is this high (the confident-garbage trap). */
export const TRUNCATION_CONF = 0.7;
/** Bottom-missing signal: empty space after the last text line… */
export const BOTTOM_GAP_RATIO = 0.35;
/** …on documents that are numeric by nature. */
export const NUMERIC_LINE_RATIO = 0.4;
/** Junk line share above which the document is noise-dominated. */
export const NOISE_LINE_RATIO = 0.4;
/** Duplicate line share above which the document repeats itself (OCR stall). */
export const DUPLICATE_LINE_RATIO = 0.3;
/** Below this unique-char share the document is repetitive garbage. */
export const CHAR_DIVERSITY_MIN = 0.3;
/** Recognized lines under this share of the ink-span expectation = layout collapse. */
export const LINE_DENSITY_LAYOUT = 0.5;
/** Std of ink-region gray below this = low contrast (blur/thermal). */
export const LOW_CONTRAST_STD = 25;

// Scorer weights (calibration contract): prefer USEFUL text, not the longest.
const W_COVERAGE = 0.25;
const W_DENSITY = 0.1;
const W_WORDS = 0.1;
const W_CONF = 0.2;
const W_NUMERIC = 0.1;
const W_NOISE = 0.1;
const W_DUP = 0.05;
const W_DIVERSITY = 0.05;
const W_FRAG = 0.05;

// ─── Image statistics (deterministic, from the winning image) ──────────────

export interface ImageStats {
  width: number;
  height: number;
  /** First/last ink rows in original-image pixel space (0-based). */
  inkTop: number;
  inkBottom: number;
  /** (inkBottom - inkTop) / height — how much of the image actually carries ink. */
  inkSpanRatio: number;
  /** Mean ink density (0..1) inside the ink span. */
  textDensity: number;
  /** Decisive column banding → text lines are vertical (90°/270° rotation). */
  verticalText: boolean;
  /** Low gray std inside the ink span → blur / low contrast. */
  lowContrast: boolean;
}

/**
 * Pure pixel statistics on a RawImage (no canvas, no tesseract). Everything
 * is computed on a ≤200px grayscale downsample, so the cost is ~1ms.
 */
export function computeImageStats(img: RawImage): ImageStats {
  const { width: w, height: h } = img;
  const scale = Math.min(1, 200 / Math.max(w, h));
  const dw = Math.max(2, Math.round(w * scale));
  const dh = Math.max(2, Math.round(h * scale));
  const gray = downsampleGray(toGray(img), w, h, dw, dh);
  const th = otsuThreshold(gray);

  const rowBands = inkBandCount(gray, dw, dh, true, th, 0.35);
  const colBands = inkBandCount(gray, dw, dh, false, th, 0.35);
  const rowVar = rowProjectionVariance(gray, dw, dh, true);
  const colVar = rowProjectionVariance(gray, dw, dh, false);

  const minInk = Math.max(1, Math.round(dw * 0.02));
  let inkTop = -1;
  let inkBottom = -1;
  let inkSum = 0;
  let inkRows = 0;
  const rowInk = new Float64Array(dh);
  for (let y = 0; y < dh; y++) {
    let c = 0;
    const base = y * dw;
    for (let x = 0; x < dw; x++) if (gray[base + x] <= th) c++;
    rowInk[y] = c;
    if (c >= minInk) {
      if (inkTop === -1) inkTop = y;
      inkBottom = y;
    }
  }

  let mean = 0;
  let count = 0;
  for (let y = 0; y < dh; y++) {
    if (y < inkTop || y > inkBottom) continue;
    mean += gray[y * dw];
    count++;
  }
  mean /= Math.max(1, count);
  let variance = 0;
  let densitySum = 0;
  let densityRows = 0;
  for (let y = inkTop; y <= inkBottom && y >= 0; y++) {
    if (y < 0 || y >= dh) continue;
    variance += (gray[y * dw] - mean) * (gray[y * dw] - mean);
    if (rowInk[y] > 0) {
      densitySum += Math.min(1, rowInk[y] / dw);
      densityRows++;
    }
  }
  variance /= Math.max(1, count);
  inkSum = inkBottom - inkTop + 1;

  const inkSpanRatio = inkTop === -1 ? 0 : inkSum / dh;
  return {
    width: w,
    height: h,
    inkTop: inkTop === -1 ? 0 : Math.round((inkTop / dh) * h),
    inkBottom: inkBottom === -1 ? 0 : Math.round(((inkBottom + 1) / dh) * h),
    inkSpanRatio,
    textDensity: densityRows > 0 ? densitySum / densityRows : 0,
    verticalText: colBands >= rowBands + 1 && colBands >= 2 && colVar > rowVar,
    lowContrast: Math.sqrt(variance) < LOW_CONTRAST_STD,
  };
}

// ─── Document metrics (deterministic, from OCR metadata only) ───────────────

export interface DocMetrics {
  lines: number;
  chars: number;
  words: number;
  lineSpanTop: number;
  lineSpanBottom: number;
  /** Recognized text span / image height. */
  coverage: number;
  /** Recognized text span / ink span (the collapse signal). */
  relativeCoverage: number;
  /** Recognized lines / expected lines from ink span × median line height. */
  lineDensity: number;
  /** Empty image space below the last recognized line (share of ink span). */
  bottomGap: number;
  meanConf: number | undefined;
  numericLineRatio: number;
  noiseLineRatio: number;
  duplicateRatio: number;
  charDiversity: number;
  /** Share of lines that are ≤2 chars (fragmentation). */
  fragmentation: number;
}

function medianLineHeight(doc: OcrDocument): number | undefined {
  const hs = doc.lines
    .map((l) => l.bbox?.height)
    .filter((v): v is number => typeof v === "number" && v >= 4 && v <= 200);
  if (hs.length === 0) return undefined;
  hs.sort((a, b) => a - b);
  const mid = hs.length >> 1;
  return hs.length % 2 === 1 ? hs[mid] : (hs[mid - 1] + hs[mid]) / 2;
}

function lineSpan(doc: OcrDocument): { top: number; bottom: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  let found = false;
  for (const l of doc.lines) {
    if (l.bbox && l.bbox.height > 0) {
      found = true;
      top = Math.min(top, l.bbox.y);
      bottom = Math.max(bottom, l.bbox.y + l.bbox.height);
    }
  }
  return found ? { top, bottom } : null;
}

function normalizedLines(doc: OcrDocument): string[] {
  return doc.lines.map((l) =>
    l.text
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  );
}

function duplicateRatioOf(normLines: string[]): number {
  const nonEmpty = normLines.filter((t) => t.length > 0);
  if (nonEmpty.length < 4) return 0;
  let dup = 0;
  for (let i = 0; i < nonEmpty.length; i++) {
    for (let j = i + 1; j < nonEmpty.length; j++) {
      const a = nonEmpty[i];
      const b = nonEmpty[j];
      const as = new Set(a.split(" "));
      const bs = new Set(b.split(" "));
      if (as.size === 0 || bs.size === 0) continue;
      let inter = 0;
      for (const t of as) if (bs.has(t)) inter++;
      const jaccard = inter / (as.size + bs.size - inter);
      if (a === b || jaccard >= 0.9) {
        dup++;
        break;
      }
    }
    if (dup > 0) break;
  }
  return Math.min(1, dup / nonEmpty.length);
}

export function computeDocMetrics(doc: OcrDocument, stats: ImageStats): DocMetrics {
  const lines = doc.lines.length;
  const chars = doc.text.replace(/\s+/g, "").length;
  const words = doc.lines.reduce((s, l) => s + l.words.length, 0);

  const span = lineSpan(doc);
  const coverage = span && stats.height > 0 ? (span.bottom - span.top) / stats.height : 0;
  const inkSpanPx = Math.max(1, stats.inkBottom - stats.inkTop);
  const relativeCoverage = span && inkSpanPx > 0 ? (span.bottom - span.top) / inkSpanPx : 0;
  const bottomGap =
    span && inkSpanPx > 0
      ? Math.max(0, (stats.inkBottom - span.bottom) / inkSpanPx)
      : 0;

  const mh = medianLineHeight(doc);
  const expectedLines = mh ? Math.max(1, Math.floor(inkSpanPx / (mh * 1.8))) : 8;
  const lineDensity = lines / expectedLines;

  const confs = doc.lines
    .map((l) => l.confidence)
    .filter((c): c is number => typeof c === "number");
  const meanConf = confs.length > 0 ? confs.reduce((s, c) => s + c, 0) / confs.length : undefined;

  let numericLines = 0;
  let noiseLines = 0;
  let fragLines = 0;
  for (const l of doc.lines) {
    if (/\d/.test(l.text)) numericLines++;
    if ((l.quality?.noiseScore ?? 0) > NOISE_THRESHOLD) noiseLines++;
    if (l.text.replace(/\s+/g, "").length <= 2) fragLines++;
  }

  const nonSpaceChars = chars;
  const unique = new Set(
    doc.text.replace(/\s+/g, "").split("")
  ).size;
  const charDiversity = nonSpaceChars > 0 ? unique / nonSpaceChars : 0;

  const norm = normalizedLines(doc);
  const nonEmpty = norm.filter((t) => t.length > 0);

  return {
    lines,
    chars,
    words,
    lineSpanTop: span?.top ?? 0,
    lineSpanBottom: span?.bottom ?? 0,
    coverage,
    relativeCoverage,
    lineDensity,
    bottomGap,
    meanConf,
    numericLineRatio: lines > 0 ? numericLines / lines : 0,
    noiseLineRatio: lines > 0 ? noiseLines / lines : 0,
    duplicateRatio: duplicateRatioOf(norm),
    charDiversity,
    fragmentation: lines > 0 ? fragLines / lines : 0,
  };
}

// ─── Detector ───────────────────────────────────────────────────────────────

export interface RecallDetection {
  suspicious: boolean;
  signals: string[];
}

/**
 * Decide whether the OCR result silently collapsed. Deterministic, metadata +
 * image stats only. Requires ≥2 signals on normal documents; small-ink images
 * (legit short documents) are only flagged on the strongest signals.
 */
export function detectRecallCollapse(
  doc: OcrDocument,
  stats: ImageStats,
  metrics?: DocMetrics
): RecallDetection {
  const m = metrics ?? computeDocMetrics(doc, stats);
  const signals: string[] = [];

  const r1 = m.lines <= 2 || m.chars < 25;
  const r2 =
    m.relativeCoverage < TRUNCATION_REL_COVERAGE &&
    m.meanConf !== undefined &&
    m.meanConf >= TRUNCATION_CONF;
  const r3 = m.bottomGap > BOTTOM_GAP_RATIO && m.numericLineRatio >= NUMERIC_LINE_RATIO;
  const r4 = m.noiseLineRatio > NOISE_LINE_RATIO;
  const r5 = m.duplicateRatio > DUPLICATE_LINE_RATIO && m.lines >= 5;
  const r6 = m.charDiversity < CHAR_DIVERSITY_MIN && m.chars >= 40;

  if (r1) signals.push("lines");
  if (r2) signals.push("truncation");
  if (r3) signals.push("bottom");
  if (r4) signals.push("noise");
  if (r5) signals.push("duplicates");
  if (r6) signals.push("garbage");
  if (stats.verticalText) signals.push("vertical");
  if (stats.lowContrast) signals.push("lowContrast");
  if (m.lineDensity < LINE_DENSITY_LAYOUT) signals.push("lowDensity");

  if (stats.inkSpanRatio < SMALL_INK_SPAN_RATIO) {
    // Genuinely small content: only the strongest signals may trigger.
    const strong = r1 || r4 || r6;
    return { suspicious: strong, signals: strong ? signals : [] };
  }

  const strongCount = [r1, r2, r3, r4, r5, r6].filter(Boolean).length;
  return { suspicious: strongCount >= 2, signals };
}

// ─── Scorer ─────────────────────────────────────────────────────────────────

/**
 * Deterministic candidate score (0..1). Prefers USEFUL text: coverage of real
 * content, sane line density, numeric tokens (receipts are numeric), word
 * confidence — and penalizes noise lines, duplicates, low character diversity
 * and fragmentation. Length alone never wins.
 */
export function scoreOcrCandidate(
  doc: OcrDocument,
  stats: ImageStats,
  metrics?: DocMetrics
): number {
  const m = metrics ?? computeDocMetrics(doc, stats);
  const conf = m.meanConf ?? 0;
  return clamp(
    W_COVERAGE * m.coverage +
      W_DENSITY * Math.min(1, m.lineDensity) +
      W_WORDS * Math.min(1, m.words / 40) +
      W_CONF * conf +
      W_NUMERIC * m.numericLineRatio +
      W_NOISE * (1 - m.noiseLineRatio) +
      W_DUP * (1 - m.duplicateRatio) +
      W_DIVERSITY * m.charDiversity +
      W_FRAG * (1 - m.fragmentation)
  );
}

// ─── Recovery variants ──────────────────────────────────────────────────────

export type RecoveryVariant =
  | { kind: "rotate"; angle: 90 | 180 | 270 }
  | { kind: "binary" }
  | { kind: "sharpen" }
  | { kind: "psm"; psm: 6 | 11 };

/**
 * Plan at most MAX_RECOVERY_ATTEMPTS variants, ordered by failure class:
 * orientation (vertical evidence) → adaptive/binary preprocessing
 * (low contrast) → alternate PSM (layout collapse).
 */
export function planRecoveryVariants(stats: ImageStats, signals: string[]): RecoveryVariant[] {
  const want = (s: string) => signals.includes(s);
  const out: RecoveryVariant[] = [];

  if (want("vertical")) {
    out.push({ kind: "rotate", angle: 90 });
    out.push({ kind: "rotate", angle: 270 });
  }
  if (want("lowContrast")) {
    out.push({ kind: "binary" });
    out.push({ kind: "sharpen" });
  }
  if (want("lowDensity") || want("truncation") || want("lines") || want("bottom")) {
    out.push({ kind: "psm", psm: 11 });
    out.push({ kind: "psm", psm: 6 });
  }
  return out.slice(0, MAX_RECOVERY_ATTEMPTS);
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export interface RecallRecoveryRecord {
  detected: boolean;
  signals: string[];
  attempts: number;
  budgetMs: number;
  elapsedMs: number;
  selected: "primary" | "candidate";
  winnerVariant?: string;
  primaryScore?: number;
  bestScore?: number;
  margin?: number;
  skippedReason?: string;
  /** One entry per executed recovery pass (observability, never required). */
  attemptResults?: Array<{ variant: string; score: number; margin: number }>;
}

/** Render a variant image to PNG bytes (null = reuse the current image, e.g. PSM). */
export async function renderVariantImage(
  base: RawImage,
  v: RecoveryVariant
): Promise<Buffer | null> {
  try {
    if (v.kind === "rotate") {
      const rotated = await rotateImage(base, v.angle);
      return Buffer.from(canvasFromImage(rotated).toBuffer("image/png"));
    }
    if (v.kind === "binary") {
      const bin = adaptiveThreshold(toGray(base), base.width, base.height);
      const rgba = rgbaFromGray(base.width, base.height, Float32Array.from(bin));
      return Buffer.from(canvasFromImage(rgba).toBuffer("image/png"));
    }
    if (v.kind === "sharpen") {
      // Blur rescue: upscale 2× then strong unsharp mask. The page pipeline
      // already sharpens at amount 0.7 at native resolution — this variant is
      // deliberately different (bigger pixels, sharper edges) so low-contrast
      // scans get a second chance without touching the primary path.
      const scaled = await scaleImage(base, 2);
      const gray = sharpenGray(toGray(scaled), scaled.width, scaled.height, 1.4);
      const rgba = rgbaFromGray(scaled.width, scaled.height, gray);
      return Buffer.from(canvasFromImage(rgba).toBuffer("image/png"));
    }
    return null;
  } catch {
    return null;
  }
}

export interface RecallRecoveryOptions {
  /** Remaining OCR timeout budget (dynamic). */
  budgetMs: number;
  /** One recognition pass; psm overrides the engine segmentation mode. */
  recognize: (buf: Buffer, exif: number, psm?: number) => Promise<OcrDocument>;
}

/**
 * Run the additive recovery layer:
 *
 *   primary → detect → healthy: keep primary (0 attempts, no meta noise)
 *            → suspicious: run ≤3 ordered attempts, score each, early-stop
 *              on a clear win (≥ RECOVERY_WIN_MARGIN), keep primary on tie.
 *
 * Budget: attempts run only while the remaining budget can host another pass;
 * insufficient budget → primary kept, reason recorded.
 */
export async function runRecallRecovery(
  primaryDoc: OcrDocument,
  image: { buf: Buffer; exif: number },
  opts: RecallRecoveryOptions
): Promise<{ doc: OcrDocument; image: { buf: Buffer; exif: number }; record: RecallRecoveryRecord }> {
  const started = Date.now();
  const base = {
    detected: false,
    signals: [],
    attempts: 0,
    budgetMs: opts.budgetMs,
    elapsedMs: 0,
    selected: "primary" as const,
  };

  if (opts.budgetMs < MIN_RECOVERY_BUDGET_MS) {
    return {
      doc: primaryDoc,
      image,
      record: { ...base, elapsedMs: Date.now() - started, skippedReason: "remaining_budget_insufficient" },
    };
  }

  let img: RawImage;
  let stats: ImageStats;
  try {
    img = applyOrientation(await decodeToRgba(image.buf), image.exif);
    stats = computeImageStats(img);
  } catch {
    return {
      doc: primaryDoc,
      image,
      record: { ...base, elapsedMs: Date.now() - started, skippedReason: "image_unavailable" },
    };
  }

  const metrics = computeDocMetrics(primaryDoc, stats);
  const detection = detectRecallCollapse(primaryDoc, stats, metrics);
  if (!detection.suspicious) {
    return { doc: primaryDoc, image, record: { ...base, elapsedMs: Date.now() - started } };
  }

  const variants = planRecoveryVariants(stats, detection.signals);
  const primaryScore = scoreOcrCandidate(primaryDoc, stats, metrics);

  let bestDoc = primaryDoc;
  let bestImage = image;
  let bestScore = primaryScore;
  let bestVariant: string | undefined;
  let attempts = 0;
  const attemptResults: Array<{ variant: string; score: number; margin: number }> = [];

  for (const v of variants) {
    const remaining = opts.budgetMs - (Date.now() - started);
    if (remaining < ESTIMATED_ATTEMPT_MS) break;

    let buf: Buffer;
    let exif: number;
    let psm: number | undefined;
    if (v.kind === "psm") {
      buf = image.buf;
      exif = image.exif;
      psm = v.psm;
    } else {
      const rendered = await renderVariantImage(img, v);
      if (!rendered) continue;
      buf = rendered;
      exif = 1;
    }

    const candidate = await opts.recognize(buf, exif, psm);
    attempts++;
    const candScore = scoreOcrCandidate(candidate, stats);
    attemptResults.push({ variant: variantLabel(v), score: candScore, margin: candScore - primaryScore });

    if (candScore > bestScore) {
      bestScore = candScore;
      bestDoc = candidate;
      bestImage = { buf, exif };
      bestVariant = variantLabel(v);
    }
    if (candScore >= primaryScore + RECOVERY_WIN_MARGIN) break; // early stop: clear win
  }

  const margin = bestScore - primaryScore;
  const selected: RecallRecoveryRecord["selected"] =
    bestDoc !== primaryDoc && margin >= RECOVERY_WIN_MARGIN ? "candidate" : "primary";
  const finalDoc = selected === "candidate" ? bestDoc : primaryDoc;
  const finalImage = selected === "candidate" ? bestImage : image;

  const record: RecallRecoveryRecord = {
    detected: true,
    signals: detection.signals,
    attempts,
    budgetMs: opts.budgetMs,
    elapsedMs: Date.now() - started,
    selected,
    winnerVariant: selected === "candidate" ? bestVariant : undefined,
    primaryScore,
    bestScore,
    margin,
    skippedReason:
      attempts === 0 ? (Date.now() - started > opts.budgetMs - ESTIMATED_ATTEMPT_MS ? "budget_exhausted" : "no_variants") : undefined,
    attemptResults,
  };

  return { doc: finalDoc, image: finalImage, record };
}

function variantLabel(v: RecoveryVariant): string {
  if (v.kind === "rotate") return `rotate${v.angle}`;
  if (v.kind === "binary") return "binary";
  if (v.kind === "sharpen") return "sharpen";
  return `psm${v.psm}`;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
