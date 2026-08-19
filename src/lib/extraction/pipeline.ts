/**
 * Comprehensive extraction pipeline — OCR → Rescue → Grounding → Transformer.
 *
 * `processDocumentPipeline(fileBuffer, schema)` runs the full stack over a
 * single image:
 *
 *   OCR        Tesseract (ara+eng) with preprocessing, numeric verification,
 *              recall recovery and the opt-in gated PaddleOCR rescue. The
 *              rescue only fires when recall recovery detected a collapsed
 *              document AND numeric evidence is missing/suspicious, and it
 *              stays inside the OCR timeout budget (additive observability —
 *              it never fails OCR).
 *   Grounding  the Spatial Alignment Engine wraps every schema field with an
 *              explicit VERIFIED / UNCERTAIN / MISSING state plus its spatial
 *              attribution. Values recovered by the rescue (inline
 *              "LABEL value" lines) are grounded under the same calibrated
 *              spatial contract the rescue used.
 *   Transformer the final result: verified fields only in `data`, per-field
 *              state/confidence/attribution in `meta`, and every rejected
 *              field with its raw reading and reasons in `issues`.
 *
 * The whole run is wall-clock-bounded: the OCR stage itself is capped by
 * OCR_TIMEOUT_MS, and the pipeline records `elapsedMs` so callers can enforce
 * their own latency budget.
 */
import { recognizeMainThread } from "@/lib/tesseract-main";
import {
  groundDocument,
  type GroundedDocument,
  type GroundedFieldInput,
} from "./grounding";
import {
  toFinalExtractionResult,
  type FinalExtractionResult,
} from "./transformer";

// ─── Public types ───────────────────────────────────────────────────────────

/** Declarative extraction contract: which fields to ground and verify. */
export interface PipelineSchema {
  fields: GroundedFieldInput[];
}

export interface PipelineOptions {
  /** PaddleOCR service URL (e.g. http://127.0.0.1:8000/v1/ocr). The rescue
   *  silently skips when absent — additive by design. */
  paddleUrl?: string;
  /** Tesseract language pack. Defaults to "ara+eng". */
  langs?: string;
}

export interface PipelineOutput {
  /** The final extraction result (data / meta / issues). */
  result: FinalExtractionResult;
  /** The grounded document (spatial attributions + rescue observability). */
  grounded: GroundedDocument;
  /** Total wall-clock time of the pipeline, in milliseconds. */
  elapsedMs: number;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the full extraction pipeline over an image buffer. The PaddleOCR URL is
 * applied for the duration of the run and restored afterwards, so concurrent
 * callers with different services never clobber each other's env.
 */
export async function processDocumentPipeline(
  fileBuffer: Buffer,
  schema: PipelineSchema,
  opts: PipelineOptions = {}
): Promise<PipelineOutput> {
  const started = Date.now();
  const previousUrl = process.env.PADDLE_OCR_URL;
  if (opts.paddleUrl !== undefined) {
    process.env.PADDLE_OCR_URL = opts.paddleUrl;
  }
  try {
    const doc = await recognizeMainThread(fileBuffer, opts.langs ?? "ara+eng", {
      verifyNumerics: true,
      recoverRecall: true,
      rescuePaddle: true,
    });
    const grounded = groundDocument(doc, schema.fields);
    return {
      result: toFinalExtractionResult(grounded),
      grounded,
      elapsedMs: Date.now() - started,
    };
  } finally {
    if (opts.paddleUrl !== undefined) {
      if (previousUrl === undefined) delete process.env.PADDLE_OCR_URL;
      else process.env.PADDLE_OCR_URL = previousUrl;
    }
  }
}