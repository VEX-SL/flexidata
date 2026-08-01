import type {
  ConfidenceResult,
  ConfidenceSignals,
  ExtractionResult,
  ValidationResult,
} from "./types";

/** Inputs the confidence engine needs from the shared state. */
export interface ConfidenceInput {
  sourceText: string;
  textStats?: { length: number; lines: number };
}

/**
 * Confidence Engine — multi-signal, not just the model's self-reported score.
 * Signals: validation success, cross-field consistency, OCR quality,
 * extraction (per-field) confidence, missing-required penalty.
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
  };

  const overall = combine(signals);

  return {
    overall,
    signals,
    summary: [
      { label: "Validation", score: signals.validation },
      { label: "Cross-field consistency", score: signals.consistency },
      { label: "OCR / text quality", score: signals.ocrQuality },
      { label: "Extraction confidence", score: signals.extraction },
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
 * Signal 3 — OCR / text quality heuristic.
 * Short or near-empty text suggests scanned/poor OCR.
 */
function ocrQualitySignal(input: ConfidenceInput): number {
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

function combine(signals: ConfidenceSignals): number {
  // Validation and extraction are the primary signals.
  const weighted =
    signals.validation * 0.35 +
    signals.consistency * 0.15 +
    signals.ocrQuality * 0.1 +
    signals.extraction * 0.3 +
    signals.missing * 0.1;
  return clamp(weighted);
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
