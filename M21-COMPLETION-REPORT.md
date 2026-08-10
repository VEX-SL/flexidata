# M21 Completion Report — Dynamic Extraction Lifecycle (first-class mode)

## Objective
Make `extractionMode: "legacy" | "dynamic"` a first-class, persisted, editable,
exportable, re-runnable mode across the full extraction lifecycle. Dynamic
fields are never reconstructed from a static profile schema after extraction;
legacy mode stays byte-identical; dynamic stays explicitly opt-in.

## Deliverables

### Contract
- `src/lib/pipeline/types.ts` — `ExtractionResult.extractionMode?: ExtractionMode`
  (defaults to legacy). Set by `candidatesFromAICall` in
  `src/lib/pipeline/extractor/index.ts:99` and preserved through grounding
  (`groundExtraction` spreads the result) and recovery.
- `src/lib/pipeline/dto.ts` — `FieldDTO.type?: string`, `FieldDTO.label?: string`
  (persisted per-field metadata), `JobDTO.extractionMode`, and `ExtractionRow.extraction_mode`.

### Persistence
- `src/lib/pipeline/service.ts` — `run()` persists `extraction_mode`
  (`extraction.extractionMode ?? "legacy"`).
- `serializeFields` persists `type` + `label` for every field.
- `rebuildExtraction` sets the mode from the row and rebuilds each field from the
  profile schema when the key exists (legacy byte-identical) or from the
  persisted discovered `type`/`label` otherwise (dynamic never degrades to a
  generic untyped string).
- `supabase/pipeline.sql` — `extractions.extraction_mode TEXT NOT NULL DEFAULT
  'legacy' CHECK (extraction_mode IN ('legacy','dynamic'))` in the CREATE TABLE
  and an idempotent `ALTER ... ADD COLUMN IF NOT EXISTS` upgrade path.

### PATCH / edit (the M20 gap)
- `service.updateFields` now branches on the stored mode:
  - legacy → only profile-schema keys (unchanged).
  - dynamic → only fields the extraction actually produced, gated by
    `safeFieldKey(k) === k` (prototype-pollution defence). Editing never creates
    arbitrary keys → the no-invention contract holds.
  - The persisted `type` drives value coercion; `type`/`label` are preserved on
    edit.
- `src/app/api/pipeline/extractions/[id]/route.ts` PATCH handler is
  schema-neutral (delegates to the service); stale doc comment updated.

### Export
- `src/lib/pipeline/exporter.ts` — dynamic CSV columns = the produced fields in
  extraction order (deduped), not the profile's static `csvColumns`. JSON was
  already dynamic; with persisted labels the exported `label` is the
  AI-discovered one instead of the key.

### Rerun / replace
- `service.replace` passes the stored `extraction_mode` back into `run()`, so a
  dynamic job re-run in place stays dynamic (and legacy stays legacy).

### Validation / confidence neutrality
- `src/lib/pipeline/validator.ts` — dynamic mode returns a schema-neutral
  `{ ok: true, results: [], missing: [] }`: no profile rule applies, so a dynamic
  job is never falsely penalized for missing schema-required keys.
- Confidence is then driven purely by grounding/evidence/uncertainty signals
  (the "schema" for a dynamic extraction IS what the document produced).

### UI
- `src/lib/hooks/use-documents.ts` — client `FieldDTO.type/label`,
  `JobDTO.extractionMode`.
- `src/app/(dashboard)/documents/page.tsx` — review UI labels dynamic fields from
  the persisted label (fallback: schema label → humanize) and edits them with
  their persisted type (number/boolean/currency parsing works for dynamic fields).

## Tests
- `tests/m21-dynamic-lifecycle.test.ts` (new, 12 tests, registered in
  `tests/_entry.ts`): persistence/reload (exportJob JSON labels + CSV columns +
  `toJobDTO` mode), PATCH dynamic edit coercion, unknown/unsafe key rejection,
  legacy regression (non-schema key rejected, schema key accepted), replace mode
  preservation (dynamic + legacy default), validator neutrality, and dynamic-vs-
  legacy CSV column differential.
- `tests/live/m21-dynamic-lifecycle-probe.ts` (new): drives the real production
  `PipelineService.run` → ground → clean → recover → validate → confidence with a
  fake AI through run/export/edit/reload against an in-memory `extractions`
  table. **PROBE PASSED.**

## Verification
- `npm run test` → 705/705 passed (was 693 before M21; +12 new).
- `npx tsc --noEmit` → clean.
- `npx eslint` on all touched files → 0 errors, 0 warnings introduced (pre-existing
  repo warnings in `use-documents.ts`/`page.tsx` untouched).
- No commit, no push.

## Scope guard (unchanged)
- No change to `MIN_CONFIDENCE`, label factors, OCR behavior, or legacy prompts.
- No vendor/receipt-specific exceptions; no weakening of no-invention /
  no-relabeling for legacy schema fields or of evidence requirements.
- Dynamic remains strictly opt-in (`extractionMode: "dynamic"` on the run input).
- No field registry; no schema inference from arbitrary field names.
- M13–M17 behavior untouched (layout-aware evidence, grounding, recovery, tax
  gate, confidence) — all legacy tests still pass.
