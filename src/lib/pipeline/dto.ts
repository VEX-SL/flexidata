import type {
  OcrDocument,
  ProfileType,
  StructuredError,
  UncertaintyReason,
} from "./types";

/**
 * Stable DTOs — the public API contract. Frontends depend ONLY on these
 * shapes; internal PipelineState / stage objects are never exposed.
 */

/** One extracted field, as stored and returned to clients. */
export interface FieldDTO {
  key: string;
  value: unknown;
  /** Verbatim source value (raw OCR reading), when preserved. */
  raw?: unknown;
  /**
   * Per-field type (dynamic mode) or the profile schema type (legacy).
   * Persisted so dynamic fields reload with their discovered type instead of
   * degrading to an untyped string.
   */
  type?: string;
  /**
   * Human-readable label: the AI-discovered label (dynamic) or the schema
   * label (legacy). Persisted so dynamic fields never lose their label on
   * reload.
   */
  label?: string;
  /** Source-document anchors supporting the value. */
  evidence?: Array<{
    quote: string;
    lineIndex?: number;
    role?: string;
    confidence?: number;
    context?: string;
  }>;
  confidence: number;
  source: string;
  status: string;
  /** Distinct grounded candidates when status is "ambiguous". */
  alternatives?: unknown[];
  /** Why this value is uncertain (flagged/ambiguous/low confidence). */
  reasons?: UncertaintyReason[];
}

/** HTTP status / stage error — same stable shape everywhere. */
export interface ErrorDTO {
  stage?: string;
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface JobDTO {
  id: string;
  status: string;
  fileId: string | null;
  profileType: ProfileType | string;
  profileVersion: number;
  pipelineVersion: number;
  /** Extraction contract mode: "legacy" (default) or "dynamic". */
  extractionMode?: string | null;
  provider?: string | null;
  model?: string | null;
  processingTimeMs?: number | null;
  overallConfidence?: number | null;
  createdAt: string;
  completedAt?: string | null;
  error?: ErrorDTO | null;
  fields: FieldDTO[] | null;
  validation: { ok: boolean; missing: string[] } | null;
  confidence: { overall: number; signals: Record<string, number>; summary?: ConfidenceSummaryDTO[] } | null;
  /** Truncated source text preview for the review UI. */
  sourceText: string | null;
  /** Original file URL (for the review UI's OCR preview panel). */
  fileUrl?: string | null;
  /** Structured OCR input (line-level) for the readable OCR preview. */
  ocr?: OcrDocument | null;
  /** Resource URL for polling (REST-friendly). */
  url: string;
}

export interface ConfidenceSummaryDTO {
  label: string;
  score: number;
  detail?: string;
}

export interface ExtractionListDTO {
  items: JobDTO[];
  total: number;
}

export interface ProfileDTO {
  id: string;
  label: string;
  version: number;
  docTypes: string[];
  enabled: boolean;
}

/** Row shape as selected from the extractions table. */
export interface ExtractionRow {
  id: string;
  status: string;
  file_id?: string | null;
  profile_type: ProfileType | string;
  profile_version: number;
  pipeline_version: number;
  extraction_mode?: string | null;
  provider?: string | null;
  model?: string | null;
  processing_time_ms?: number | null;
  overall_confidence?: number | null;
  created_at: string;
  completed_at?: string | null;
  error_json?: StructuredError | null;
  fields_json?: FieldDTO[] | null;
  validation_json?: { ok: boolean; missing: string[] } | null;
  confidence_json?: {
    overall: number;
    signals: Record<string, number>;
    summary?: ConfidenceSummaryDTO[];
  } | null;
  ocr_json?: OcrDocument | null;
  source_text?: string | null;
  trace_json?: unknown;
  /** Auto-maintained by the updated_at trigger (used for stale reconciliation). */
  updated_at?: string;
}

const SOURCE_PREVIEW_CHARS = 4_000;

export function toJobDTO(row: ExtractionRow): JobDTO {
  return {
    id: row.id,
    status: row.status,
    fileId: row.file_id ?? null,
    profileType: row.profile_type,
    profileVersion: row.profile_version,
    pipelineVersion: row.pipeline_version,
    extractionMode: row.extraction_mode ?? "legacy",
    provider: row.provider ?? null,
    model: row.model ?? null,
    processingTimeMs: row.processing_time_ms ?? null,
    overallConfidence: row.overall_confidence ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    error: row.error_json ?? null,
    fields: Array.isArray(row.fields_json) ? row.fields_json : null,
    validation: row.validation_json ?? null,
    confidence: row.confidence_json ?? null,
    sourceText: row.source_text
      ? row.source_text.slice(0, SOURCE_PREVIEW_CHARS)
      : null,
    fileUrl: row.file_id ? `/api/files/${row.file_id}` : null,
    ocr: row.ocr_json ?? null,
    url: `/api/pipeline/extractions/${row.id}`,
  };
}

export function toErrorDTO(err: unknown): ErrorDTO {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err
  ) {
    const e = err as StructuredError;
    return {
      stage: e.stage,
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      details: e.details,
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}
