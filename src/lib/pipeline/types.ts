/**
 * FlexiData AI — Document Intelligence Pipeline: core types.
 *
 * The pipeline is fully additive and plugin-based. Each document profile is an
 * independent "package" (schema + prompt template + validation rules + export
 * config + version), so new document types can be added without refactoring.
 *
 * Stages communicate ONLY through `PipelineState` (typed interface). The
 * pipeline depends on the `AIClient` abstraction — never on a concrete
 * provider. See ai.ts for the default wiring.
 */

import type { AIRequest, AIResponse } from "@/types";

// ─── Field schema (declarative, JSON-serializable) ────────────────────────

export type FieldType =
  | "string"
  | "number"
  | "currency"
  | "date"
  | "boolean"
  | "enum"
  | "object"
  | "array"
  | "text";

export interface FieldSchema {
  /** Field key, snake_case (e.g. "invoice_number"). */
  key: string;
  type: FieldType;
  /** Array element type when type === "array". */
  itemsType?: FieldType;
  /** Allowed values when type === "enum". */
  enum?: string[];
  label?: string;
  description?: string;
  /**
   * Semantic category used for evidence grounding (e.g. "tax", "date",
   * "total"). Derived from `key` by default; override when the key naming
   * convention doesn't capture the document semantics.
   */
  labelGroup?: string;
  /** When true, the validator flags the field as missing if absent. */
  required?: boolean;
  /** When true, contributes to the consistency signal if present. */
  crossCheck?: boolean;
}

export interface ProfileSchema {
  version: number;
  fields: FieldSchema[];
  /** Optional ordered field groups used by the review UI. */
  groups?: Array<{ id: string; label: string; keys: string[] }>;
}

// ─── Validation rules (declarative) ───────────────────────────────────────

export type FieldValueKind =
  | "string"
  | "number"
  | "currency"
  | "date"
  | "boolean"
  | "enum";

export interface ValidationRule {
  key: string;
  kind: FieldValueKind;
  required?: boolean;
  /** Regex source string; applied to the raw string value. */
  pattern?: string;
  /** E.g. "yyyy-mm-dd" for dates, "{amount} {currency}" for currency. */
  format?: string;
  min?: number;
  max?: number;
  /** For enum kind: allowed values. */
  allowed?: string[];
}

export interface ValidationOutcome {
  key: string;
  ok: boolean;
  message: string;
  /** 0..1 contribution of this field to the validation signal. */
  weight: number;
}

export interface ValidationResult {
  ok: boolean;
  /** Per-field outcomes. */
  results: ValidationOutcome[];
  /** Fields defined in the schema but missing from the extraction. */
  missing: string[];
}

// ─── Extracted values ─────────────────────────────────────────────────────

export type FieldSource = "ai" | "ocr" | "rule" | "user" | "verified";

export type FieldStatus = "extracted" | "verified" | "edited" | "flagged" | "ambiguous";

/**
 * Machine-readable reasons why a field's value is uncertain. Set by the
 * grounding and recovery stages, consumed by the review UI (P4) and the agent
 * context (P1) so uncertainty is always explained, never a bare percentage.
 */
export type UncertaintyReason =
  | "recovered_from_ocr"
  | "ambiguous_candidates"
  | "ocr_confidence_low"
  | "label_not_matched"
  | "no_direct_evidence"
  | "ocr_near_duplicate"
  | "inferred_by_position"
  | "entity_cleaned";

/** Axis-aligned box in the processed-image coordinate space (pixels). */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a field's value came from in the source document. */
export interface FieldEvidence {
  /** Exact source span (best-guess OCR line, verbatim). */
  quote: string;
  /** Index into the OcrDocument lines (when structured OCR is available). */
  lineIndex?: number;
  /** Indices (into that line's `words`) that make up the quoted span. */
  wordIndices?: number[];
  /** Union bounding box of the quoted span's words (processed-image space). */
  bbox?: BBox;
  /** How the evidence was established. */
  role: "value-match" | "label-match" | "derived" | "semantic";
  /** Where the evidence came from (mirrors the reading pipeline). */
  source?: "ocr" | "text" | "ai" | "derived";
  /** Mean OCR word confidence over the quoted span (0..1), when known. */
  confidence?: number;
  /** The full OCR line for human review. */
  context?: string;
}

/** A plausible-but-not-chosen reading, exposed for human review. */
export interface FieldAlternative {
  value: unknown;
  /** Verbatim source reading of the alternative. */
  raw?: unknown;
  /** Why this reading was plausible (OCR near-duplicate, model candidate). */
  reason: string;
  /** OCR word confidence of the alternative span (0..1), when known. */
  confidence?: number;
}

export interface FieldValue {
  /** Normalized / validated value (what the app commits). */
  value: unknown;
  /**
   * Verbatim value as it appears in the source text. Always preserved so the
   * raw OCR reading is never lost behind normalization.
   */
  rawValue?: unknown;
  /** 0..1 — composed per-field confidence (OCR × extraction × validation). */
  confidence: number;
  source: FieldSource;
  /** Status drives the human-review UI. */
  status: FieldStatus;
  /** Anchors in the source document that support this value. */
  evidence?: FieldEvidence[];
  /**
   * Distinct grounded candidates when the value could not be resolved
   * (status "ambiguous"). Each entry is the coerced candidate value.
   */
  alternatives?: unknown[];
  /** Why the chosen value won over `alternatives` (human-reviewable). */
  chosenReason?: string;
  /**
   * Machine-readable reasons why this value carries uncertainty. Never empty
   * for flagged/ambiguous fields; may also annotate low-confidence extractions.
   */
  reasons?: UncertaintyReason[];
  /** Free-form extra data (e.g. date/time parts, raw match, alternative details). */
  meta?: Record<string, unknown>;
}

export type FieldsMap = Record<string, FieldValue>;

// ─── OCR input (probabilistic, not a text blob) ───────────────────────────

export interface OcrWord {
  text: string;
  /** Tesseract word confidence (0..1). Undefined when unavailable. */
  confidence?: number;
  /** Word box in the processed-image coordinate space, when available. */
  bbox?: BBox;
}

export interface OcrLine {
  text: string;
  /** Mean word confidence for the line. Undefined when unavailable. */
  confidence?: number;
  words: OcrWord[];
  /** Union box of the line's words (processed-image space), when available. */
  bbox?: BBox;
}

/**
 * Structured OCR result. `text` is the best-guess rendering (kept for
 * backward compatibility); `lines`/`words` carry per-token confidence so the
 * pipeline can treat OCR as probabilistic input instead of absolute truth.
 */
export interface OcrDocument {
  text: string;
  lines: OcrLine[];
  language?: string;
  /**
   * Page mean OCR confidence (0..1) from Tesseract's MeanTextConf, when
   * available. Per-word confidences are frequently unavailable from the
   * emscripten core, so this page-level signal is the fallback.
   */
  confidence?: number;
}

// ─── Classification ───────────────────────────────────────────────────────

export type ProfileType =
  | "invoice"
  | "receipt"
  | "resume"
  | "contract"
  | "unknown";

export type ClassificationSource = "ai" | "rule" | "fallback";

export interface ClassificationResult {
  profileType: ProfileType;
  /** 0..1 classifier confidence. */
  confidence: number;
  source: ClassificationSource;
  reasons: string[];
  /** Candidate profiles from the classifier (AI), best first. */
  candidates: Array<{ profileType: ProfileType; confidence: number }>;
}

// ─── Confidence engine ────────────────────────────────────────────────────

export interface ConfidenceSignals {
  validation: number;
  consistency: number;
  ocrQuality: number;
  extraction: number;
  missing: number;
  /**
   * Evidence coverage + quality: share of grounded fields carrying OCR
   * evidence and how confident that evidence is.
   */
  evidence: number;
  /**
   * Inverse uncertainty: 1 when no field is flagged/ambiguous/recovered,
   * falling as uncertainty appears.
   */
  uncertainty: number;
  /** Optional model-provided confidence (0..1). */
  modelConfidence?: number;
  /** Optional classification confidence (0..1), when available. */
  classification?: number;
}

export interface ConfidenceResult {
  overall: number;
  signals: ConfidenceSignals;
  /** Human-readable breakdown for the review UI. */
  summary: Array<{ label: string; score: number; detail?: string }>;
}

// ─── Extraction output ────────────────────────────────────────────────────

export interface RawExtraction {
  /** Raw fields as returned by the AI (pre-normalization). */
  data: Record<string, unknown>;
  /** Optional model-provided per-field confidence. */
  confidence?: Record<string, number>;
  /** Optional model-provided overall confidence (0..1). */
  modelConfidence?: number;
}

export interface NormalizedField {
  field: FieldSchema;
  value: FieldValue;
}

export interface ExtractionResult {
  profileType: ProfileType;
  profileVersion: number;
  fields: NormalizedField[];
  /** Map view of the same fields, keyed by field key. */
  fieldsMap: FieldsMap;
  /** Fields that survived all post-processing filters. */
  cleanFields: Record<string, unknown>;
  /** Fields dropped by post-processing (e.g. PII scrubbing). */
  droppedFields: Record<string, string>;
  model?: string;
  provider?: string;
  /** Optional model-provided overall confidence (0..1). */
  modelConfidence?: number;
}

export interface JobResult {
  classification: ClassificationResult;
  extraction: ExtractionResult;
  validation: ValidationResult;
  confidence: ConfidenceResult;
}

// ─── Document profile plugin ──────────────────────────────────────────────

export interface ExtractionProfile {
  id: string;
  label: string;
  /** Aliases/markers used by rule-based classification (multilingual). */
  docTypes: string[];
  schema: ProfileSchema;
  /** Prompt template rendered by the PromptBuilder. `{{document}}` etc. */
  promptTemplate: string;
  validationRules: ValidationRule[];
  /** Configured exporters for this profile (JSON/CSV/Excel/pdf/xlsx). */
  exportConfig: {
    formats: ExportFormat[];
    csvColumns?: string[];
    filename?: string;
  };
  version: number;
}

/** Metadata describing a registered profile plugin. */
export interface ProfileInfo {
  id: string;
  label: string;
  version: number;
  docTypes: string[];
  enabled: boolean;
}

export interface ProfilePlugin {
  /** Metadata persisted in extraction_profiles. */
  info: ProfileInfo;
  /** The actual profile definition used by the pipeline. */
  build: () => ExtractionProfile;
}

// ─── Pipeline orchestration ───────────────────────────────────────────────

/**
 * Shared, typed in-memory state. Stages read what they need and write their
 * own slot. Adding a future stage = adding one optional slot here (additive,
 * non-breaking) and registering it in the stage list.
 */
export interface PipelineState {
  input: RunJobInput;
  readonly sourceText: string;
  readonly textStats: { length: number; lines: number };
  /** Structured OCR input when available (else derived from sourceText). */
  readonly ocr?: OcrDocument;
  classification?: ClassificationResult;
  profile?: ExtractionProfile;
  extraction?: ExtractionResult;
  validation?: ValidationResult;
  confidence?: ConfidenceResult;
  /** Recovery-stage outcome (observability: what was flagged/ambiguous + retries). */
  recovery?: RecoveryStageStats;
}

/** JSON-safe summary of the recovery stage for trace/analytics. */
export interface RecoveryStageStats {
  flagged: string[];
  ambiguous: string[];
  retryAttempted: boolean;
  retryProviders: string[];
}

/**
 * Stage contract. A stage is a self-contained unit: it receives the shared
 * state, does its job, and returns nothing but its writes to the state.
 * Replacing a stage never touches the orchestrator — swap the instance.
 */
export interface PipelineStage {
  readonly id: string;
  run(ctx: PipelineState): Promise<void>;
}

export type TraceEventKind = "start" | "finish" | "error";

/** One granular execution trace event (JSON-safe, analytics-ready). */
export interface TraceEvent {
  stage: string;
  event: TraceEventKind;
  ts: string;
  durationMs?: number;
  message: string;
  data?: unknown;
}

export type PipelineStatus =
  | "queued"
  | "classifying"
  | "extracting"
  | "validating"
  | "complete"
  | "error";

export interface RunJobInput {
  sourceText: string;
  fileName?: string;
  mimeType?: string;
  fileId?: string;
  /** Pin a profile (skip/override classification). */
  profileType?: ProfileType;
  /** Structured OCR input (word-level confidence) when available. */
  ocr?: OcrDocument;
}

export interface RunJobOutput {
  status: PipelineStatus;
  trace: TraceEvent[];
  job?: JobResult;
  /** Structured stage error (never a raw exception). */
  error?: StructuredError;
}

// ─── AI abstraction (dependency inversion) ────────────────────────────────
// The pipeline depends on this interface; a concrete provider is wired in
// ai.ts. ProviderManager is never imported by pipeline stages.

export interface AIClient {
  chatCompletion(request: AIRequest): Promise<AIResponse>;
  /**
   * Optional: re-issue a request while skipping providers already known to be
   * weak for this document (used by the recovery stage's cross-provider retry).
   * Not implemented by test fakes — absent means "no provider rotation".
   */
  retryProviders?(
    request: AIRequest,
    skipProviders: string[]
  ): Promise<AIResponse>;
}

// ─── Structured errors ────────────────────────────────────────────────────
// Every stage failure maps to this shape: stable codes, retryability, optional
// stage context and details. Raw exceptions are never returned to callers.

export type PipelineErrorCode =
  | "STAGE_FAILED"
  | "CLASSIFICATION_FAILED"
  | "EXTRACTION_FAILED"
  | "AI_PROVIDER_ERROR"
  | "FILE_READ_ERROR"
  | "EMPTY_DOCUMENT"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "UNSUPPORTED_FORMAT"
  | "UNKNOWN_ERROR";

export interface StructuredError {
  /** The pipeline stage that failed, when applicable. */
  stage?: string;
  code: PipelineErrorCode;
  message: string;
  retryable: boolean;
  /** Optional machine-readable context (JSON-safe). */
  details?: unknown;
}

// ─── Export ───────────────────────────────────────────────────────────────

export type ExportFormat = "json" | "csv" | "xlsx" | "pdf";

export interface ExportOptions {
  format: ExportFormat;
  includeFlags?: boolean;
  includeMeta?: boolean;
}

export interface ExportResult {
  format: ExportFormat;
  /** Raw bytes for binary formats (xlsx/pdf). */
  buffer?: Uint8Array;
  /** Text payload for json/csv. */
  content?: string;
  mimeType: string;
  fileName: string;
}
