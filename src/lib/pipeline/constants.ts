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
