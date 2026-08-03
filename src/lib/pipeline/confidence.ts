import type {
  ConfidenceResult,
  ConfidenceSignals,
  ExtractionResult,
  OcrDocument,
  ValidationResult,
} from "./types";

/** Inputs the confidence engine needs from the shared state. */
export interface ConfidenceInput {
  sourceText: string;
  textStats?: { length: number; lines: number };
  /** Structured OCR input (word-level confidence) when available. */
  ocr?: OcrDocument;
}

/**
 * Confidence Engine — multi-signal, not just the model's self-reported score.
 * Signals: validation success, cross-field consistency, OCR quality,
 * extraction (per-field) confidence, missing-required penalty, evidence
 * coverage/quality, and uncertainty (flagged/ambiguous/recovered fields).
 * The model's own confidence is optional and low-weight.
 */
export function computeConfidence(
  extraction: ExtractionResult,
  validation: ValidationResult,
  input: ConfidenceInput
): ConfidenceResult {
  const signals: ConfidenceSignals = {
    validation: validationSignal(validation),
    consistency: consistencySignal(extraction),
    ocrQuality: ocrQualitySignal(input),
    extraction: extractionSignal(extraction),
    missing: missingSignal(validation),
    evidence: evidenceSignal(extraction),
    uncertainty: uncertaintySignal(extraction),
  };
  if (typeof extraction.modelConfidence === "number") {
    signals.modelConfidence = clamp(extraction.modelConfidence);
  }

  const overall = combine(signals);

  return {
    overall,
    signals,
    summary: [
      { label: "Validation", score: signals.validation },
      { label: "Cross-field consistency", score: signals.consistency },
      { label: "OCR / text quality", score: signals.ocrQuality },
      { label: "Extraction confidence", score: signals.extraction },
      { label: "Evidence grounding", score: signals.evidence },
      { label: "Uncertainty", score: signals.uncertainty },
      { label: "Missing required fields", score: signals.missing },
    ],
  };
}

/** Signal 1 — how well the validation rules passed. */
function validationSignal(validation: ValidationResult): number {
  if (validation.results.length === 0) return 1;
  const totalWeight = validation.results.reduce((s, r) => s + r.weight, 0);
  if (totalWeight === 0) return 1;
  const passed = validation.results
    .filter((r) => r.ok)
    .reduce((s, r) => s + r.weight, 0);
  return clamp(passed / totalWeight);
}

/** Signal 2 — crossCheck fields extracted with high confidence. */
function consistencySignal(extraction: ExtractionResult): number {
  const cross = extraction.fields.filter((f) => f.field.crossCheck);
  if (cross.length === 0) return 1;
  const score =
    cross.reduce((s, f) => s + f.value.confidence, 0) / cross.length;
  return clamp(score);
}

/**
 * Signal 3 — OCR / text quality.
 * When structured OCR is available, prefer real per-word/per-line confidence;
 * fall back to the page mean OCR confidence, then a length heuristic.
 */
function ocrQualitySignal(input: ConfidenceInput): number {
  const confs: number[] = [];
  if (input.ocr) {
    for (const line of input.ocr.lines) {
      if (typeof line.confidence === "number") confs.push(line.confidence);
      for (const word of line.words) {
        if (typeof word.confidence === "number") confs.push(word.confidence);
      }
    }
  }
  if (confs.length > 0) return clamp(mean(confs));
  if (typeof input.ocr?.confidence === "number") {
    return clamp(input.ocr.confidence);
  }

  const length = input.textStats?.length ?? input.sourceText.length;
  if (length <= 0) return 0.2;
  if (length < 100) return 0.4;
  if (length < 1000) return 0.7;
  return 0.95;
}

/** Signal 4 — average per-field confidence, required fields weighted 2x. */
function extractionSignal(extraction: ExtractionResult): number {
  if (extraction.fields.length === 0) return 0;
  const total = extraction.fields.reduce((s, f) => {
    const weight = f.field.required ? 2 : 1;
    return s + f.value.confidence * weight;
  }, 0);
  const weights = extraction.fields.reduce(
    (s, f) => s + (f.field.required ? 2 : 1),
    0
  );
  return clamp(total / weights);
}

/** Signal 5 — penalty per missing required field. */
function missingSignal(validation: ValidationResult): number {
  const penalty = validation.missing.length * 0.2;
  return clamp(1 - penalty);
}

/** Signal 6 — share of kept fields grounded in OCR evidence, × evidence quality. */
function evidenceSignal(extraction: ExtractionResult): number {
  const kept = extraction.fields;
  if (kept.length === 0) return 0;
  let coverage = 0;
  let quality = 0;
  let qualityCount = 0;
  for (const f of kept) {
    const ev = f.value.evidence ?? [];
    if (ev.length > 0) coverage += 1;
    for (const e of ev) {
      if (typeof e.confidence === "number") {
        quality += e.confidence;
        qualityCount += 1;
      }
    }
  }
  coverage = coverage / kept.length;
  if (qualityCount === 0) return clamp(coverage);
  return clamp(coverage * 0.5 + (quality / qualityCount) * 0.5);
}

/** Signal 7 — inverse uncertainty: any flagged/ambiguous/recovered field lowers it. */
function uncertaintySignal(extraction: ExtractionResult): number {
  const kept = extraction.fields;
  if (kept.length === 0) return 0;
  let uncertain = 0;
  for (const f of kept) {
    const status = f.value.status;
    const reasons = f.value.reasons ?? [];
    if (
      status === "flagged" ||
      status === "ambiguous" ||
      (status !== "verified" && reasons.length > 0)
    ) {
      uncertain += 1;
    }
  }
  return clamp(1 - uncertain / kept.length);
}

function combine(signals: ConfidenceSignals): number {
  // Validation and extraction are the primary signals.
  const weighted =
    signals.validation * 0.3 +
    signals.consistency * 0.1 +
    signals.ocrQuality * 0.1 +
    signals.extraction * 0.3 +
    signals.evidence * 0.1 +
    signals.uncertainty * 0.05 +
    signals.missing * 0.05;
  return clamp(weighted);
}

function mean(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
