/**
 * Gated PaddleOCR rescue (additive, opt-in).
 *
 * Runs AFTER the primary pass, the raw-image fallback, recall recovery and
 * numeric verification. The outer gate is `doc.meta.recallRecovery.detected
 * === true` — a silently-collapsed document — plus deterministic evidence of
 * a numeric problem in the current document itself (invalid/ambiguous numeric
 * candidates, label-group lines missing their value, or severe numeric
 * collapse). No LLM, no business assumptions, no `meta.numericVerifications`
 * dependency.
 *
 * Hard contract (the corrections that define this layer):
 *  - A VALID primary candidate is never replaced, even when Paddle is more
 *    confident. ("607021830113216" can never become "6070218301132157".)
 *  - Case A: an invalid/ambiguous candidate is re-read from its own bbox and
 *    replaced only when the Paddle reading is deterministically valid,
 *    conf ≥ 0.85, and no valid conflicting primary overlaps the region.
 *  - Case B: a label line missing its value (or a collapsed page) is re-read
 *    from the page/region; recovered "LABEL value" lines are INSERTED (never
 *    overwriting anything) only when valid + conf ≥ 0.85 + value not already
 *    present + no valid conflicting primary. A value-only reading merges with
 *    its label ONLY when spatially adjacent: same visual line (det boxes
 *    side-by-side on one printed line, y centers within PADDLE_SAME_LINE_TOL)
 *    or directly below within PADDLE_PAIR_GAP; otherwise the pair is rejected
 *    whole — no bare numbers, no invented labels (semantic attribution is
 *    preserved).
 *  - No reliable region → no request. Insufficient budget → no request.
 *    Missing PADDLE_OCR_URL → graceful skip. Any failure is recorded in
 *    `doc.meta.paddleRescue` and never fails OCR.
 */
import type { BBox, OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { detectLabelGroup } from "@/lib/pipeline/extractor/label-lexicon";
import {
  MAX_CANDIDATES,
  applyVerifiedValue,
  canonicalNumeric,
  cropRegionPng,
  detectNumericCandidates,
  validateCandidate,
  type NumericCandidate,
  type NumericKind,
} from "@/lib/ocr/numeric-verify";
import {
  PADDLE_REGION_TIMEOUT_MS,
  paddleUrlFromEnv,
  requestPaddleRescue,
  type PaddleClientOptions,
  type PaddleRescueResult,
  type PaddleTextItem,
} from "./paddle-client";

// ─── Documented thresholds (calibration contract) ──────────────────────────

/** Below this remaining OCR budget the rescue never fires. */
export const PADDLE_MIN_BUDGET_MS = 4000;
/** Hard cap on regions re-read per document. */
export const PADDLE_MAX_REGIONS = 3;
/** A Paddle reading below this confidence is never accepted. */
export const PADDLE_MIN_CONF = 0.85;
/** Cap on inserted "LABEL value" lines per document. */
export const PADDLE_MAX_INSERTIONS = 8;
/**
 * Vertical band overlap (row match) above which two boxes are "the same field
 * region". Fields live on rows — a receipt's TOTAL/CASH/CHANGE differ by y,
 * and a conflicting value on the SAME row is a conflict regardless of the
 * label column offset (word boxes are narrower than full line boxes).
 */
export const PADDLE_CONFLICT_ROW_OVERLAP = 0.8;
/** Overhead accounted per region request (request prep + parse). */
export const PADDLE_REQUEST_OVERHEAD_MS = 200;
/**
 * Max vertical gap (px, processed-image space) between a label line and its
 * value line for a safe "LABEL value" merge — about two rows. A value sitting
 * farther away carries no trustworthy attribution and is rejected whole.
 */
export const PADDLE_PAIR_GAP = 48;
/**
 * Vertical-center tolerance (px, processed-image space) for treating two det
 * boxes as the same visual line. PP-OCRv6 splits a printed receipt line into
 * side-by-side label/value boxes whose y centers match within a few px while
 * their boxes overlap vertically — and the reading order within such a line
 * is not guaranteed (the value box may be read before the label box). Boxes
 * whose centers are within this tolerance are treated as one line (ordered by
 * x, label column first) and may pair even though their boxes overlap. The
 * tolerance stays well below the line pitch of dense receipts (>= ~30px) so
 * distinct rows never merge.
 */
export const PADDLE_SAME_LINE_TOL = 16;

// ─── Observability record ───────────────────────────────────────────────────

export interface PaddleAttemptRecord {
  region: string;
  reason: string;
  paddleTexts: number;
  accepted: number;
  rejected: Array<{ value: string; reason: string }>;
  error?: string;
  latencyMs: number;
}

export interface PaddleRescueRecord {
  triggered: boolean;
  skippedReason?: string;
  regions: Array<{ kind: "full_page" | "candidate" | "label" | "missing_field"; label?: string }>;
  attempts: PaddleAttemptRecord[];
  accepted: number;
  latencyMs: number;
  budgetMs: number;
  elapsedMs: number;
}

export interface PaddleRescueOptions {
  /** Winning image PNG (processed-image space — matches doc bboxes). */
  buffer: Buffer;
  exif: number;
  engine: "paddleocr-en" | "paddleocr-ar";
  /** Remaining OCR timeout budget (dynamic). */
  budgetMs: number;
  /** Override for PADDLE_OCR_URL (tests / benchmark inject the mock). */
  url?: string;
  /** Injectable HTTP layer (tests). Defaults to requestPaddleRescue. */
  request?: (imagePng: Buffer, opts: PaddleClientOptions) => Promise<PaddleRescueResult>;
}

interface PaddleRegion {
  kind: "full_page" | "candidate" | "label" | "missing_field";
  bbox?: BBox;
  label?: string;
  candidate?: NumericCandidate;
  missingKind?: NumericKind;
}

interface InsertionCandidate {
  text: string;
  value: string;
  kind: NumericKind;
  confidence: number;
  bbox: BBox;
}

// ─── Small deterministic helpers ────────────────────────────────────────────

function digitsOf(text: string): number {
  let n = 0;
  for (const c of text) if (c >= "0" && c <= "9") n += 1;
  return n;
}

/** True for a word that plausibly carries a numeric value (mirrors the
 *  verifier's rule: ≥4 digits, digits dominate, few non-separator chars). */
function isNumericWord(text: string): boolean {
  if (!text) return false;
  let digits = 0;
  let others = 0;
  for (const c of text) {
    if (c >= "0" && c <= "9") digits += 1;
    else if (!/[.,:/-]/.test(c)) others += 1;
  }
  if (digits < 4) return false;
  return digits / text.length >= 0.6 && others <= 2;
}

function countNumericWords(doc: OcrDocument): number {
  let n = 0;
  for (const line of doc.lines) {
    for (const w of line.words) if (isNumericWord(w.text)) n += 1;
  }
  return n;
}

/** The token carrying the most digits (the value of a line), if any. */
function numericTokenOf(text: string): string | null {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  let best: string | null = null;
  let bestDigits = 1;
  for (const t of tokens) {
    const d = digitsOf(t);
    if (d > bestDigits) {
      best = t;
      bestDigits = d;
    }
  }
  return best;
}

/** Kind mapping for label groups (mirrors the numeric verifier's private map). */
function kindForGroup(group: string, lineText: string): NumericKind | null {
  if (group === "date") return "date";
  if (group === "total") return "amount";
  if (group === "pos") return "account";
  if (group === "buyer") return "customer";
  if (group === "number") {
    const norm = lineText
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .toLowerCase();
    if (/المرجع|مرجعي|مرجقي|ref/.test(norm)) return "reference";
    if (/المعامله|عمليه|عملية|transaction/.test(norm)) return "transaction";
    return "number";
  }
  return null;
}

/** Kind by value shape when no label group anchors the line. */
function kindForValue(value: string): NumericKind {
  const s = value.replace(/\s+/g, "");
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s)) return "date";
  if (/^\d{1,9}([.,]\d{1,2})?$/.test(s) || /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(s)) {
    return "amount";
  }
  return "number";
}

function boxRowOverlap(a: BBox, b: BBox): number {
  const y0 = Math.max(a.y, b.y);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, y1 - y0);
  const minHeight = Math.min(a.height, b.height) || 1;
  return overlap / minHeight;
}

/** Vertical center of a box (same convention as row matching/insertion). */
function centerY(b: BBox): number {
  return b.y + b.height / 2;
}

function canonicalOf(text: string): string {
  return canonicalNumeric(text);
}

// ─── Gate: evidence of a numeric problem in the document ────────────────────

interface Evidence {
  candidates: NumericCandidate[];
  problemCandidates: NumericCandidate[];
  labelLines: OcrLine[];
  severeCollapse: boolean;
  missingFields: Array<{ kind: NumericKind; expectedPattern: string }>;
}

function collectEvidence(doc: OcrDocument): Evidence {
  const candidates = detectNumericCandidates(doc, MAX_CANDIDATES);
  const problemCandidates = candidates.filter(
    (c) => validateCandidate(c.kind, c.primaryText) !== "valid"
  );
  const labelLines = doc.lines.filter(
    (l) =>
      l.words.length > 0 &&
      l.bbox !== undefined &&
      detectLabelGroup(l.text) !== null &&
      !l.words.some((w) => isNumericWord(w.text))
  );
  const severeCollapse =
    doc.lines.length <= 5 || countNumericWords(doc) < 3;
  
  // Detect missing expected fields that are common in receipts
  const missingFields: Array<{ kind: NumericKind; expectedPattern: string }> = [];
  
  // Check for common receipt fields that might be missing
  const docText = doc.text.toLowerCase();
  const hasTotal = /total|جملة/.test(docText);
  const hasCash = /cash|نقداً|نقدي/.test(docText);
  const hasChange = /change|باقي/.test(docText);
  
  if (hasTotal && !candidates.some(c => c.kind === "amount")) {
    missingFields.push({ kind: "amount", expectedPattern: "\\d+(?:\\.\\d{2})?" });
  }
  if (hasCash && !candidates.some(c => c.kind === "amount")) {
    missingFields.push({ kind: "amount", expectedPattern: "\\d+(?:\\.\\d{2})?" });
  }
  if (hasChange && !candidates.some(c => c.kind === "amount")) {
    missingFields.push({ kind: "amount", expectedPattern: "\\d+(?:\\.\\d{2})?" });
  }
  
  return { candidates, problemCandidates, labelLines, severeCollapse, missingFields };
}

function planRegions(ev: Evidence): PaddleRegion[] {
  const regions: PaddleRegion[] = [];
  if (ev.severeCollapse) {
    regions.push({ kind: "full_page" });
  }
  for (const c of ev.problemCandidates) {
    if (regions.length >= PADDLE_MAX_REGIONS) break;
    regions.push({
      kind: "candidate",
      bbox: c.bbox,
      label: c.primaryText,
      candidate: c,
    });
  }
  for (const l of ev.labelLines) {
    if (regions.length >= PADDLE_MAX_REGIONS) break;
    regions.push({ kind: "label", bbox: l.bbox, label: l.text });
  }
  // Add regions for missing expected fields
  for (const missing of ev.missingFields) {
    if (regions.length >= PADDLE_MAX_REGIONS) break;
    // For missing fields, we'll search the full page since we don't have a bbox
    regions.push({ 
      kind: "missing_field", 
      missingKind: missing.kind,
      label: `missing_${missing.kind}`
    });
  }
  return regions.slice(0, PADDLE_MAX_REGIONS);
}

// ─── Insertion candidates from a page/label reading ─────────────────────────

/**
 * Turn a Paddle line reading into insertion candidates: label-anchored lines
 * carry their value inline ("Date: 2025-01-15 15:42"), and value-only lines
 * pair with the most recent non-numeric line above them ("TOTAL" + "38.40",
 * "Sugar 1kg" + "6.50"). A pair is only merged when the value line is
 * spatially adjacent to its label: same visual line (det boxes side-by-side
 * overlap vertically but their y centers match within PADDLE_SAME_LINE_TOL)
 * or below it by at most PADDLE_PAIR_GAP. A value without a trustworthy
 * attribution is rejected whole, never inserted as a bare number and never
 * merged with a distant label. Every candidate is validated before
 * insertion, so a wrong pairing can only ever be rejected — never written.
 * Rejected pairings are returned for observability.
 */
function insertionCandidates(texts: PaddleTextItem[]): {
  candidates: InsertionCandidate[];
  rejected: Array<{ text: string; reason: string }>;
} {
  const items = texts
    .filter((t) => t.bbox !== undefined && t.confidence > 0)
    .map((t) => ({ ...t, bbox: t.bbox! }));
  // Cluster boxes whose vertical centers match within PADDLE_SAME_LINE_TOL:
  // the detector splits one printed line into side-by-side label/value boxes
  // whose reading order is arbitrary, so order each line's boxes by x (label
  // column first) and keep rows in center order.
  const byCenter = items
    .slice()
    .sort((a, b) => centerY(a.bbox) - centerY(b.bbox) || a.bbox.x - b.bbox.x);
  const buckets: Array<Array<(typeof items)[number]>> = [];
  for (const t of byCenter) {
    const last = buckets[buckets.length - 1];
    if (
      last &&
      Math.abs(centerY(t.bbox) - centerY(last[0].bbox)) <= PADDLE_SAME_LINE_TOL
    ) {
      last.push(t);
    } else {
      buckets.push([t]);
    }
  }
  const lines = buckets
    .map((b) => b.slice().sort((a, b) => a.bbox.x - b.bbox.x))
    .flat();
  const candidates: InsertionCandidate[] = [];
  const rejected: Array<{ text: string; reason: string }> = [];
  let pending: { text: string; confidence: number; bbox: BBox } | null = null;
  for (const line of lines) {
    const group = detectLabelGroup(line.text);
    const value = numericTokenOf(line.text);
    if (value === null) {
      // Non-numeric line — becomes the pairing context for a following value.
      pending = { text: line.text, confidence: line.confidence, bbox: line.bbox };
      continue;
    }
    const kind =
      (group !== null ? kindForGroup(group, line.text) : null) ??
      kindForValue(value);
    if (group === null && pending === null) {
      rejected.push({ text: line.text, reason: "value_without_label" });
      continue;
    }
    if (group !== null) {
      candidates.push({
        text: line.text,
        value,
        kind,
        confidence: line.confidence,
        bbox: line.bbox,
      });
      pending = null;
      continue;
    }
    const sameLine =
      Math.abs(centerY(line.bbox) - centerY(pending!.bbox)) <= PADDLE_SAME_LINE_TOL;
    const gap = line.bbox.y - (pending!.bbox.y + pending!.bbox.height);
    if ((!sameLine && gap < 0) || gap > PADDLE_PAIR_GAP) {
      rejected.push({
        text: `${pending!.text} ${line.text}`,
        reason: "pair_not_adjacent",
      });
      continue;
    }
    candidates.push({
      text: `${pending!.text} ${line.text}`,
      value,
      kind,
      confidence: Math.min(pending!.confidence, line.confidence),
      bbox: line.bbox,
    });
    pending = null;
  }
  return { candidates, rejected };
}

// ─── Application ────────────────────────────────────────────────────────────

function conflictsWithValidPrimary(
  candidates: NumericCandidate[],
  kind: NumericKind,
  value: string,
  bbox: BBox
): boolean {
  const canonical = canonicalNumeric(value);
  for (const c of candidates) {
    if (validateCandidate(c.kind, c.primaryText) !== "valid") continue;
    if (c.kind !== kind) continue;
    if (canonicalNumeric(c.primaryText) === canonical) continue;
    if (boxRowOverlap(c.bbox, bbox) >= PADDLE_CONFLICT_ROW_OVERLAP) return true;
  }
  return false;
}

function insertRescuedLine(
  doc: OcrDocument,
  text: string,
  bbox: BBox,
  confidence: number
): OcrDocument {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const totalChars = tokens.reduce((s, t) => s + t.length, 0) || 1;
  let before = 0;
  const words: OcrWord[] = tokens.map((t) => {
    const w: OcrWord = {
      text: t,
      confidence,
      bbox: {
        x: bbox.x + (before / totalChars) * bbox.width,
        y: bbox.y,
        width: (t.length / totalChars) * bbox.width,
        height: bbox.height,
      },
    };
    before += t.length;
    return w;
  });
  const line: OcrLine = { text, confidence, words, bbox };
  const lines = doc.lines.slice();
  let idx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].bbox;
    if (!b || b.y + b.height / 2 <= bbox.y + bbox.height / 2) idx = i + 1;
    else break;
  }
  lines.splice(idx, 0, line);
  return { ...doc, lines, text: lines.map((l) => l.text).join("\n") };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Run the gated rescue. Returns the updated document plus the observable
 * record; the caller attaches it to `doc.meta.paddleRescue` when it fired
 * (triggered or skipped). Never throws.
 */
export async function runPaddleRescue(
  doc: OcrDocument,
  opts: PaddleRescueOptions
): Promise<{ doc: OcrDocument; record: PaddleRescueRecord }> {
  const started = Date.now();
  const request = opts.request ?? requestPaddleRescue;
  const record: PaddleRescueRecord = {
    triggered: false,
    regions: [],
    attempts: [],
    accepted: 0,
    latencyMs: 0,
    budgetMs: opts.budgetMs,
    elapsedMs: 0,
  };

  if (opts.budgetMs < PADDLE_MIN_BUDGET_MS) {
    record.skippedReason = "budget_too_small";
    record.elapsedMs = Date.now() - started;
    return { doc, record };
  }

  const rec = doc.meta?.recallRecovery as { detected?: unknown } | undefined;
  if (!rec || rec.detected !== true) {
    record.skippedReason = "recall_not_detected";
    record.elapsedMs = Date.now() - started;
    return { doc, record };
  }

  const url = opts.url ?? paddleUrlFromEnv();
  if (!url) {
    record.skippedReason = "paddle_unavailable";
    record.elapsedMs = Date.now() - started;
    return { doc, record };
  }

  const ev = collectEvidence(doc);
  if (!ev.severeCollapse && ev.problemCandidates.length === 0 && ev.labelLines.length === 0) {
    record.skippedReason = "no_numeric_problem";
    record.elapsedMs = Date.now() - started;
    return { doc, record };
  }

  const regions = planRegions(ev);
  if (regions.length === 0) {
    record.skippedReason = "no_regions";
    record.elapsedMs = Date.now() - started;
    return { doc, record };
  }
  record.regions = regions.map((r) => ({
    kind: r.kind,
    ...(r.label !== undefined ? { label: r.label } : {}),
  }));

  let out = doc;
  for (const region of regions) {
    const remaining = opts.budgetMs - (Date.now() - started);
    if (remaining < PADDLE_REGION_TIMEOUT_MS + PADDLE_REQUEST_OVERHEAD_MS) {
      break; // keep the already-recorded attempts; budget governs execution
    }
    const attempt = await executeRegion(out, region, { ...opts, url, request }, ev.candidates);
    out = attempt.doc;
    record.attempts.push(attempt.attempt);
    record.accepted += attempt.attempt.accepted;
  }

  record.triggered = record.attempts.length > 0;
  record.latencyMs = Date.now() - started;
  record.elapsedMs = record.latencyMs;
  if (!record.triggered && record.regions.length > 0) {
    record.skippedReason = "budget_exhausted";
  }
  return { doc: out, record };
}

async function executeRegion(
  doc: OcrDocument,
  region: PaddleRegion,
  opts: PaddleRescueOptions & { url: string; request: NonNullable<PaddleRescueOptions["request"]> },
  candidates: NumericCandidate[]
): Promise<{ doc: OcrDocument; attempt: PaddleAttemptRecord }> {
  let attempt: PaddleAttemptRecord = {
    region: region.kind === "candidate" ? "candidate" : region.kind,
    reason: region.label ?? region.kind,
    paddleTexts: 0,
    accepted: 0,
    rejected: [],
    latencyMs: 0,
  };
  const reject = (value: string, reason: string): { doc: OcrDocument; attempt: PaddleAttemptRecord } => {
    attempt.rejected.push({ value, reason });
    return { doc, attempt };
  };

  let imagePng: Buffer | null = null;
  if (region.kind === "full_page") {
    imagePng = opts.buffer;
  } else if (region.bbox) {
    imagePng = await cropRegionPng(opts.buffer, opts.exif, region.bbox);
  } else if (region.kind === "missing_field") {
    // For missing fields, use the full page since we don't have a specific bbox
    imagePng = opts.buffer;
  }
  if (imagePng === null) {
    attempt.error = "crop_unusable";
    return { doc, attempt };
  }

  const res = await opts.request(imagePng, {
    url: opts.url,
    timeoutMs: PADDLE_REGION_TIMEOUT_MS,
    engine: opts.engine,
  });
  attempt.latencyMs = res.latencyMs;
  attempt.paddleTexts = res.texts.length;
  if (res.error) {
    attempt.error = res.error;
    return { doc, attempt };
  }

  if (region.kind === "candidate" && region.candidate) {
    const cand = region.candidate;
    const pick = res.texts.reduce<{ text: string; confidence: number } | null>(
      (best, t) =>
        !best || digitsOf(t.text) > digitsOf(best.text)
          ? { text: t.text, confidence: t.confidence }
          : best,
      null
    );
    if (!pick) return reject(cand.primaryText, "paddle_no_numeric");
    if (pick.confidence < PADDLE_MIN_CONF) {
      return reject(pick.text, "paddle_low_conf");
    }
    if (validateCandidate(cand.kind, pick.text) !== "valid") {
      return reject(pick.text, "paddle_invalid");
    }
    if (
      conflictsWithValidPrimary(
        candidates,
        cand.kind,
        pick.text,
        cand.bbox
      )
    ) {
      return reject(pick.text, "conflict_with_valid_primary");
    }
    attempt.accepted = 1;
    return { doc: applyVerifiedValue(doc, cand, pick.text, pick.confidence), attempt };
  }

  // Handle missing field regions: trustworthy label/value pairs only. A bare
  // numeric reading without an adjacent label is rejected whole — the same
  // pairing contract insertionCandidates enforces for page/label regions.
  if (region.kind === "missing_field" && region.missingKind) {
    let existingCanonical = canonicalOf(doc.text);
    let inserted = 0;
    const { candidates: insCandidates, rejected: insRejected } = insertionCandidates(res.texts);
    for (const r of insRejected) {
      attempt.rejected.push({ value: r.text, reason: r.reason });
    }
    for (const cand of insCandidates) {
      if (inserted >= PADDLE_MAX_INSERTIONS) break;
      if (cand.kind !== region.missingKind) {
        attempt.rejected.push({ value: cand.value, reason: "kind_mismatch" });
        continue;
      }
      const value = cand.value;
      if (cand.confidence < PADDLE_MIN_CONF) {
        attempt.rejected.push({ value, reason: "paddle_low_conf" });
        continue;
      }
      if (validateCandidate(region.missingKind, value) !== "valid") {
        attempt.rejected.push({ value, reason: "paddle_invalid" });
        continue;
      }
      if (existingCanonical.includes(canonicalNumeric(value))) {
        attempt.rejected.push({ value, reason: "value_already_present" });
        continue;
      }
      if (conflictsWithValidPrimary(candidates, region.missingKind, value, cand.bbox)) {
        attempt.rejected.push({ value, reason: "conflict_with_valid_primary" });
        continue;
      }
      doc = insertRescuedLine(doc, cand.text, cand.bbox, cand.confidence);
      existingCanonical = canonicalOf(doc.text);
      inserted += 1;
    }
    attempt.accepted = inserted;
    return { doc, attempt };
  }

  // Page / label region: deterministic insertions only.
  let existingCanonical = canonicalOf(doc.text);
  let inserted = 0;
  const { candidates: insCandidates, rejected: insRejected } = insertionCandidates(res.texts);
  for (const r of insRejected) {
    attempt.rejected.push({ value: r.text, reason: r.reason });
  }
  for (const cand of insCandidates) {
    if (inserted >= PADDLE_MAX_INSERTIONS) break;
    const value = cand.value;
    if (cand.confidence < PADDLE_MIN_CONF) {
      attempt.rejected.push({ value, reason: "paddle_low_conf" });
      continue;
    }
    if (validateCandidate(cand.kind, value) !== "valid") {
      attempt.rejected.push({ value, reason: "paddle_invalid" });
      continue;
    }
    if (existingCanonical.includes(canonicalNumeric(value))) {
      attempt.rejected.push({ value, reason: "value_already_present" });
      continue;
    }
    if (conflictsWithValidPrimary(candidates, cand.kind, value, cand.bbox)) {
      attempt.rejected.push({ value, reason: "conflict_with_valid_primary" });
      continue;
    }
    doc = insertRescuedLine(doc, cand.text, cand.bbox, cand.confidence);
    existingCanonical = canonicalOf(doc.text);
    inserted += 1;
  }
  attempt.accepted = inserted;
  return { doc, attempt };
}