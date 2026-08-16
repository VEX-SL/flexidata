/**
 * Pipeline version — bumped only when the pipeline contract changes.
 * Persisted per extraction as immutable metadata.
 *
 * v1 → v2: the OCR contract changed. `source_text` is now the Arabic-first
 * repaired surface (bidi/RTL fixed, fragments split, Arabic normalized) and
 * every line carries per-line quality + `sourceLine` provenance. Records at
 * version < 2 were built from unrepaired OCR and must be re-run to reflect
 * the OCR layer.
 */
export const PIPELINE_VERSION = 2;

/** Max accepted source text length for a single run. */
export const MAX_SOURCE_TEXT = 500_000;

/**
 * Statuses that mean "still running". A row stuck in one of these longer than
 * STALE_JOB_MS was likely interrupted (process crash / platform timeout / DB
 * unreachable) — `finally` cannot cover process death, so read paths
 * opportunistically reconcile such rows to `error` (PIPELINE_INTERRUPTED).
 * Terminal statuses ("complete"/"error") are deliberately excluded: phase
 * updates are guarded against ever overwriting them.
 */
export const INTERMEDIATE_STATUSES = [
  "queued",
  "classifying",
  "extracting",
  "validating",
];

/**
 * Stale-run threshold, derived from the current execution limits (not guessed).
 *
 * Worst case = every provider configured (8), every request hitting its
 * per-provider timeout (20s, BaseAIProvider.TIMEOUT_MS) with a rate-limit
 * backoff (3s) between attempts:
 *
 *   per chatCompletion call = 8 providers × 3 attempts × (20s + 3s) = 552s
 *     (3 attempts = retryAttempts 2 + 1; backoff runs between attempts)
 *
 *   classify = 1 call  (classifier.ts)                        = 552s
 *   extract  = 1 call  (extractor/index.ts — exactly one)      = 552s
 *   recover  = 1 retryProviders call (recover.ts, only when the
 *              extraction failed) = 7 providers × 2 attempts ×
 *              (20s + 3s)  (retryAttempts 1, used provider skipped) = 322s
 *   ground/clean/validate/confidence: deterministic, no AI calls.
 *   AI worst-case total                                          ≈ 1426s ≈ 24 min
 *
 * OCR (25s/page, sequential, file-parser.ts): page count is UNBOUNDED, but OCR
 * runs in readFileText BEFORE the extraction row is inserted (service.ts), so
 * OCR time is NOT part of the intermediate-status window — a stalled OCR
 * leaves no row behind to mark stale.
 *
 * → STALE_JOB_MS = 60 min = 3600s ≈ 2.5× the known AI worst case. The extra
 * headroom is an operational safety margin for DB latency, platform scheduling
 * and load. Any live run can still exceed a fixed threshold only via
 * pathological inputs (uncapped OCR is pre-row, so it cannot), and the
 * stale-mark is non-destructive by design: the terminal "complete"/"error"
 * write is unguarded and always wins over a stale-mark.
 */
export const STALE_JOB_MS = 60 * 60 * 1000;
