/**
 * Secondary numeric verification for OCR.
 *
 * Detects numeric field candidates (transaction / reference / account /
 * customer / amount / date) inside an OcrDocument, validates them with
 * deterministic format rules, and — when a candidate is invalid or carries
 * low OCR confidence — re-reads the source image region with a constrained
 * Tesseract configuration (digits whitelist + PSM 7 single line) supplied by
 * the engine layer through the `RegionReader` callback.
 *
 * Hard contract:
 *  - The verifier NEVER invents or replaces a value from business context.
 *    "02-07-2028" and "02-07-2026" are both syntactically valid dates; nothing
 *    in this module decides between them from document/business assumptions —
 *    only the actual verification read (with its own confidence) can.
 *  - Deterministic validation may REJECT an invalid candidate, mark a
 *    candidate ambiguous, or BLOCK replacement — it never fabricates a
 *    replacement value.
 *  - Confidence is never inflated: a verified word carries the verifier's own
 *    read confidence; agreement between primary and verifier keeps the
 *    primary confidence untouched.
 *  - Every verification decision is recorded (kind, bbox, values, both
 *    confidences, decision, reason) for observability, never required by
 *    existing consumers.
 */
import type { BBox, OcrDocument, OcrLine } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import { detectLabelGroup } from "@/lib/pipeline/extractor/label-lexicon";
import {
  applyOrientation,
  canvasFromImage,
  decodeToRgba,
  otsuThreshold,
  rgbaFromGray,
  scaleImage,
  toGray,
  type RawImage,
} from "@/lib/ocr/preprocess";

// ─── Documented thresholds (calibration contract) ──────────────────────────

/** Below this primary confidence a candidate is re-read. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;
/** A verification read below this confidence is never accepted as a replacement. */
export const MIN_VERIFIED_CONFIDENCE = 0.5;
/** "Clearly stronger evidence": verified confidence must reach this… */
export const CLEARLY_STRONGER_CONF = 0.85;
/** …and beat the primary confidence by at least this margin. */
export const CLEARLY_STRONGER_GAP = 0.2;
/** Hard cap on verified candidates per document. */
export const MAX_CANDIDATES = 6;
/** Hard budget for the whole verification pass. */
export const BUDGET_MS = 2000;
/** Padding added around the region box before cropping (pixels). */
export const REGION_PADDING = 8;

export type NumericKind =
  | "transaction"
  | "reference"
  | "account"
  | "customer"
  | "amount"
  | "date"
  | "number";

export type CandidateStatus = "valid" | "invalid" | "ambiguous";

export type NumericDecision = "keep_primary" | "use_verified" | "ambiguous_keep_primary";

export interface NumericCandidate {
  kind: NumericKind;
  lineIndex: number;
  /** Indices (into that line's `words`) covered by the candidate. */
  wordIndices: number[];
  /** Union box of the candidate's words (processed-image space). */
  bbox: BBox;
  /** Joined primary reading. */
  primaryText: string;
  /** Mean word confidence over the candidate's words, when known. */
  primaryConfidence?: number;
}

/** One constrained region read, produced by the engine layer. */
export interface RegionRead {
  text: string;
  /** 0..1 — mean word confidence of the re-read. */
  confidence: number;
}

export type RegionReader = (
  cropPng: Buffer,
  whitelist: string
) => Promise<RegionRead | null>;

/** Machine-readable record of one verification attempt. */
export interface NumericVerificationRecord {
  kind: NumericKind;
  bbox: BBox;
  primaryValue: string;
  primaryConfidence?: number;
  verifiedValue?: string;
  verifiedConfidence?: number;
  /** True when a second independent read produced the same digits. */
  doubleReadAgreed?: boolean;
  decision: NumericDecision;
  reason: string;
}

export interface NumericVerifyReport {
  verifications: NumericVerificationRecord[];
  skipped: Array<{ reason: string; count: number }>;
  budgetMs: number;
  elapsedMs: number;
  stoppedEarly: boolean;
}

export interface NumericVerifyOptions {
  buffer: Buffer;
  exif: number;
  reread: RegionReader;
  maxCandidates?: number;
  budgetMs?: number;
  lowConfidenceThreshold?: number;
}

// ─── 1. Candidate detection ────────────────────────────────────────────────

/** A word that plausibly carries a numeric value (digits dominate). */
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

/**
 * Pattern-based fallback: an unlabeled numeric token that plausibly is a field
 * value — a long digit run (8+ digits). Deliberately conservative: phone/
 * quantity tokens ("(0123456789);", "15468") never match (digit ratio / run
 * length guards). A token counts as value-positioned when it is the last word
 * on the line OR sits adjacent to a ":" separator — the structural mirror of
 * "label : value" that RTL visual-order lines ("607021830113216] : رقم …")
 * produce when the Arabic repair could not reorder them. Neither is a business
 * assumption: the shape of the line decides, never its meaning.
 */
function isStandaloneNumericToken(line: OcrLine, wi: number): boolean {
  const text = line.words[wi].text;
  if (!text) return false;
  let digits = 0;
  let others = 0;
  for (const c of text) {
    if (c >= "0" && c <= "9") digits += 1;
    else if (!/[.,:/-]/.test(c)) others += 1;
  }
  if (digits < 8) return false;
  if (digits / text.length < 0.85) return false;
  if (others > 3) return false;
  const isLast = wi === line.words.length - 1;
  const colonAdjacent =
    (wi > 0 && line.words[wi - 1].text === ":") ||
    (wi < line.words.length - 1 && line.words[wi + 1].text === ":");
  if (!isLast && !colonAdjacent && line.words.length > 2) return false;
  return true;
}

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

function joinWords(line: OcrLine, idxs: number[]): string {
  return idxs.map((i) => line.words[i].text).join(" ");
}

function meanConf(line: OcrLine, idxs: number[]): number | undefined {
  const confs = idxs
    .map((i) => line.words[i].confidence)
    .filter((c): c is number => typeof c === "number");
  return confs.length > 0 ? mean(confs) : undefined;
}

/**
 * Detect numeric candidates: label-anchored (the line carries a known label
 * group — date/total/pos/buyer/number) or pattern-based (terminal long digit
 * token on an unlabeled line). One candidate per line; capped at
 * `maxCandidates` in document order.
 */
export function detectNumericCandidates(
  doc: OcrDocument,
  maxCandidates = MAX_CANDIDATES
): NumericCandidate[] {
  const out: NumericCandidate[] = [];
  for (let li = 0; li < doc.lines.length && out.length < maxCandidates; li++) {
    const line = doc.lines[li];
    if (!line.words.length) continue;

    const numIdx: number[] = [];
    for (let wi = 0; wi < line.words.length; wi++) {
      if (isNumericWord(line.words[wi].text)) numIdx.push(wi);
    }
    if (numIdx.length === 0) continue;

    // Every numeric word needs a box: cropping is only valid in bbox space.
    const boxes = numIdx
      .map((wi) => line.words[wi].bbox)
      .filter((b): b is BBox => b !== undefined);
    if (boxes.length !== numIdx.length) continue;

    const group = detectLabelGroup(line.text);
    const kind = group ? kindForGroup(group, line.text) : null;

    if (!kind) {
      for (const wi of numIdx) {
        if (!isStandaloneNumericToken(line, wi)) continue;
        if (out.length >= maxCandidates) break;
        const w = line.words[wi];
        out.push({
          kind: "number",
          lineIndex: li,
          wordIndices: [wi],
          bbox: w.bbox!,
          primaryText: w.text,
          primaryConfidence: w.confidence,
        });
      }
      continue;
    }

    out.push({
      kind,
      lineIndex: li,
      wordIndices: numIdx,
      bbox: unionBoxes(boxes)!,
      primaryText: joinWords(line, numIdx),
      primaryConfidence: meanConf(line, numIdx),
    });
  }
  return out.slice(0, maxCandidates);
}

// ─── 2. Deterministic validation ───────────────────────────────────────────

const ID_KINDS: ReadonlySet<NumericKind> = new Set([
  "transaction",
  "reference",
  "account",
  "customer",
  "number",
]);

/**
 * Deterministic format validation. NEVER consults business context: a date
 * year is checked for format only (no "must not be in the future"), and the
 * verdict is one of valid / invalid / ambiguous — ambiguous blocks
 * replacement, invalid may be replaced by a valid verification read.
 */
export function validateCandidate(kind: NumericKind, text: string): CandidateStatus {
  const s = text.replace(/\s+/g, "");
  if (!s) return "invalid";

  if (ID_KINDS.has(kind)) {
    if (/[^0-9]/.test(s)) return "invalid";
    const len = s.length;
    if (len >= 6 && len <= 20) return "valid";
    if ((len >= 3 && len <= 5) || (len >= 21 && len <= 25)) return "ambiguous";
    return "invalid";
  }

  if (kind === "amount") {
    if (/[a-z]/i.test(s)) return "invalid";
    if (/^\d{1,9}([.,]\d{1,2})?$/.test(s)) return "valid";
    if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(s)) return "valid";
    return /\d/.test(s) ? "ambiguous" : "invalid";
  }

  if (kind === "date") {
    const m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!m) return "ambiguous";
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return "valid";
    return "invalid";
  }

  return "ambiguous";
}

/** Canonical digit form used for agreement comparison ("68,38" ≡ "68.38"). */
export function canonicalNumeric(text: string): string {
  return text.replace(/[^0-9]/g, "");
}

// ─── 3. Decision table ─────────────────────────────────────────────────────

export interface PrimaryReading {
  text: string;
  confidence?: number;
  status: CandidateStatus;
}

export interface VerifiedReading {
  text: string;
  confidence: number;
  status: CandidateStatus;
}

/**
 * Deterministic decision table (documented):
 *  1. no verification read            → keep primary
 *  2. verifier invalid                → keep primary
 *  3. primary valid + verifier valid + agree → keep primary (confidence untouched)
 *  4. verifier ambiguous              → keep primary
 *  5. verifier confidence < 0.5       → keep primary (never accept a weak read)
 *  6. primary invalid + verifier valid → use verifier
 *  7. primary valid + verifier valid + different:
 *       verifier clearly stronger (≥ 0.85 and ≥ primary + 0.2) → use verifier
 *       otherwise                     → ambiguous, keep primary
 *  8. primary ambiguous               → keep primary (no replacement)
 */
export function decideVerification(
  primary: PrimaryReading,
  verified: VerifiedReading | null
): { decision: NumericDecision; reason: string } {
  if (!verified) return { decision: "keep_primary", reason: "verifier_unusable" };
  if (verified.status === "invalid") {
    return { decision: "keep_primary", reason: "verifier_invalid" };
  }
  if (
    primary.status === "valid" &&
    verified.status === "valid" &&
    canonicalNumeric(primary.text) === canonicalNumeric(verified.text)
  ) {
    return { decision: "keep_primary", reason: "primary_valid_verifier_agrees" };
  }
  if (verified.status === "ambiguous") {
    return { decision: "keep_primary", reason: "verifier_ambiguous" };
  }
  if (verified.confidence < MIN_VERIFIED_CONFIDENCE) {
    return { decision: "keep_primary", reason: "verifier_low_confidence" };
  }
  if (primary.status === "invalid" && verified.status === "valid") {
    return { decision: "use_verified", reason: "primary_invalid_verifier_valid" };
  }
  if (primary.status === "valid" && verified.status === "valid") {
    const pc = typeof primary.confidence === "number" ? primary.confidence : 0;
    if (
      verified.confidence >= CLEARLY_STRONGER_CONF &&
      verified.confidence >= pc + CLEARLY_STRONGER_GAP
    ) {
      return {
        decision: "use_verified",
        reason: "verifier_clearly_stronger_evidence",
      };
    }
    return { decision: "ambiguous_keep_primary", reason: "no_decisive_evidence" };
  }
  if (primary.status === "ambiguous") {
    return { decision: "keep_primary", reason: "primary_ambiguous_no_replacement" };
  }
  return { decision: "keep_primary", reason: "no_decision" };
}

// ─── 4. Apply + orchestration ──────────────────────────────────────────────

/** Whitelist per kind — digits plus the separators the kind may print. */
export function whitelistFor(kind: NumericKind): string {
  if (kind === "date") return "0123456789./:- ";
  if (kind === "amount") return "0123456789., ";
  return "0123456789 ";
}

/**
 * Replace the candidate's words with the verified reading (single word),
 * recompute the line text/confidence/bbox, and rebuild the page text. Runs
 * only when the decision table said `use_verified`.
 */
export function applyVerifiedValue(
  doc: OcrDocument,
  candidate: NumericCandidate,
  value: string,
  confidence: number
): OcrDocument {
  const line = doc.lines[candidate.lineIndex];
  const words = line.words.slice();
  const first = candidate.wordIndices[0];
  words[first] = { text: value, confidence, bbox: candidate.bbox };
  for (const i of [...candidate.wordIndices.slice(1)].sort((a, b) => b - a)) {
    words.splice(i, 1);
  }
  const confs = words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  const boxes = words
    .map((w) => w.bbox)
    .filter((b): b is BBox => b !== undefined);
  const newLine: OcrLine = {
    ...line,
    words,
    text: words.map((w) => w.text).join(" "),
    confidence: confs.length > 0 ? mean(confs) : line.confidence,
    bbox: boxes.length > 0 ? unionBoxes(boxes) ?? line.bbox : line.bbox,
  };
  const lines = doc.lines.map((l, i) => (i === candidate.lineIndex ? newLine : l));
  return { ...doc, lines, text: lines.map((l) => l.text).join("\n") };
}

function mkRecord(
  cand: NumericCandidate,
  verified: { text: string; confidence: number } | null,
  decision: NumericDecision,
  reason: string,
  agreed?: boolean
): NumericVerificationRecord {
  return {
    kind: cand.kind,
    bbox: cand.bbox,
    primaryValue: cand.primaryText,
    primaryConfidence: cand.primaryConfidence,
    verifiedValue: verified?.text,
    verifiedConfidence: verified?.confidence,
    doubleReadAgreed: agreed,
    decision,
    reason,
  };
}

/**
 * Run the verification pass: detect candidates, re-read the regions that are
 * invalid or low-confidence (within budget), decide deterministically, apply
 * accepted corrections, and return the updated document plus the report. The
 * report is attached to `doc.meta.numericVerifications` when non-empty —
 * additive, JSON-safe, never required by consumers.
 */
export async function verifyNumericCandidates(
  doc: OcrDocument,
  opts: NumericVerifyOptions
): Promise<{ doc: OcrDocument; report: NumericVerifyReport }> {
  const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES;
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const lowConfidence = opts.lowConfidenceThreshold ?? LOW_CONFIDENCE_THRESHOLD;
  const started = Date.now();

  const candidates = detectNumericCandidates(doc, maxCandidates);
  const verifications: NumericVerificationRecord[] = [];
  const skipped = new Map<string, number>();
  let stoppedEarly = false;

  const skip = (reason: string) => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  };

  for (const cand of candidates) {
    const elapsed = Date.now() - started;
    if (elapsed > budgetMs) {
      stoppedEarly = true;
      skip("budget_exhausted");
      continue;
    }

    const status = validateCandidate(cand.kind, cand.primaryText);
    const conf = cand.primaryConfidence;
    // Nothing to verify: valid + not low-confidence. Honest — not recorded.
    if (status === "valid" && (conf === undefined || conf >= lowConfidence)) {
      continue;
    }

    const crop = await cropRegionPng(opts.buffer, opts.exif, cand.bbox);
    if (!crop) {
      verifications.push(mkRecord(cand, null, "keep_primary", "verifier_unusable"));
      continue;
    }

    const read = await opts.reread(crop, whitelistFor(cand.kind));
    if (!read) {
      verifications.push(mkRecord(cand, null, "keep_primary", "verifier_unusable"));
      continue;
    }

    // Second independent read (cheap): digits agreement is recorded as a
    // supporting signal; it never inflates confidence and never overrides
    // the decision table.
    let agreed = false;
    const readB = await opts.reread(crop, "");
    if (readB && readB.confidence >= MIN_VERIFIED_CONFIDENCE) {
      agreed = canonicalNumeric(read.text) === canonicalNumeric(readB.text);
    }

    const verifiedStatus = validateCandidate(cand.kind, read.text);
    const { decision, reason } = decideVerification(
      { text: cand.primaryText, confidence: conf, status },
      { text: read.text, confidence: read.confidence, status: verifiedStatus }
    );

    let out = doc;
    if (decision === "use_verified") {
      out = applyVerifiedValue(out, cand, read.text, read.confidence);
    }
    doc = out;

    verifications.push(
      mkRecord(
        cand,
        { text: read.text, confidence: read.confidence },
        decision,
        reason,
        agreed
      )
    );
  }

  const report: NumericVerifyReport = {
    verifications,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    budgetMs,
    elapsedMs: Date.now() - started,
    stoppedEarly,
  };

  if (verifications.length > 0) {
    doc = {
      ...doc,
      meta: { ...(doc.meta ?? {}), numericVerifications: verifications },
    };
  }
  return { doc, report };
}

// ─── Region image processing (winning-buffer space) ─────────────────────────

function subImage(
  img: RawImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): RawImage {
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcBase = (y0 + y) * img.width * 4 + x0 * 4;
    const dstBase = y * w * 4;
    for (let x = 0; x < w * 4; x++) data[dstBase + x] = img.data[srcBase + x];
  }
  return { data, width: w, height: h };
}

/**
 * Crop the region (bbox + padding) from the winning image, upscale small
 * regions, optionally binarize with Otsu (a different threshold path than the
 * page-level adaptive threshold, so the re-read is independent), and encode as
 * PNG. `binarize: false` keeps the grayscale crop — faint thermal digits can
 * be erased by a second threshold pass on top of the page-level one.
 * Returns null when the crop is unusable.
 */
export async function cropRegionPng(
  buffer: Buffer,
  exif: number,
  bbox: BBox,
  pad = REGION_PADDING,
  opts: { binarize?: boolean } = {}
): Promise<Buffer | null> {
  try {
    let img = await decodeToRgba(buffer);
    img = applyOrientation(img, exif);

    const x0 = Math.max(0, Math.floor(bbox.x - pad));
    const y0 = Math.max(0, Math.floor(bbox.y - pad));
    const x1 = Math.min(img.width, Math.ceil(bbox.x + bbox.width + pad));
    const y1 = Math.min(img.height, Math.ceil(bbox.y + bbox.height + pad));
    if (x1 - x0 < 4 || y1 - y0 < 4) return null;

    let crop = subImage(img, x0, y0, x1, y1);

    // Upscale small regions to a readable height (cap 3x).
    const scale = Math.min(3, Math.max(1, 48 / crop.height));
    if (scale > 1.01) crop = await scaleImage(crop, scale);

    // Otsu binarization: ink = 0, paper = 255. Expand to RGBA — canvasFromImage
    // interprets the array as RGBA, and a 1-channel buffer would render as
    // transparent black (G/B/A = 0), which Tesseract cannot read.
    let gray = toGray(crop);
    if (opts.binarize === false) {
      const plain: RawImage = rgbaFromGray(crop.width, crop.height, gray);
      return Buffer.from(canvasFromImage(plain).toBuffer("image/png"));
    }
    const th = otsuThreshold(gray);
    const bin = new Uint8ClampedArray(crop.width * crop.height);
    for (let i = 0; i < gray.length; i++) bin[i] = gray[i] <= th ? 0 : 255;
    const binarized: RawImage = rgbaFromGray(crop.width, crop.height, Float32Array.from(bin));

    const png = canvasFromImage(binarized).toBuffer("image/png");
    return Buffer.from(png);
  } catch {
    return null;
  }
}

function mean(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}