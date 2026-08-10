# M14 Completion Report — Closing the `*_tax_id` no-invention hole

Milestone: prove and fix the last production no-invention gap — tax IDs that the
model invented but that were never verified against the document.

Generated: 2026-08-09

## Status

- **DONE.** Root cause proven end-to-end at both probe levels; a two-line
  production fix landed; a 9-case regression matrix added; full suite, typecheck,
  and lint all green.
- Scope honored: no threshold / label-factor / rule / prompt / OCR / schema /
  vendor-exception changes; "never invent" and "never relabel" invariants
  preserved; no commit / push.

## Root cause

`src/lib/pipeline/extractor/grounding.ts` handled every `*_tax_id` field with a
keyword-only gate that then **`continue`d before value grounding**:

- If the document contained any `TAX_KEYWORD` token (الرقم الضريبي / vat / tin /
  ...), the model's tax-ID value was committed **without checking that the value
  appears in the document at all**. A fabricated `merchant_tax_id` survived
  end-to-end whenever a stray tax keyword line was present.

The fix routes the field through the standard evidence ladder (value-match →
derived variants → Verify-or-Find → drop) **after** the keyword gate, so the
value itself must be anchored to a real OCR span.

## Evidence

Two probe levels against the real 24-line SuperPay fixture:

1. **Ground-only** (`tests/live/m14-recon.ts`, direct `groundExtraction` +
   layout provider): hallucinated notes and fabricated line items survive the
   ground-only path (by design — the production clean stage re-verifies them),
   and fabricated `merchant_tax_id` **survived (BUG)** with a keyword present.
2. **Full production pipeline** (`tests/live/m14-prod.ts`, `runPipeline` +
   fakeAI): the clean stage already drops hallucinated notes and fabricated
   line items — the **only** field still survivable with an invented value was
   `*_tax_id`:

   - PROD A notes → DROPPED (clean stage) — already safe
   - PROD B line_items → DROPPED (clean stage) — already safe
   - PROD C merchant_tax_id → **SURVIVED (BUG)** — the target
   - PROD D baseline real fields → all OK

After the fix, PROD C flips to **DROPPED :: "not found in source text"** while
A, B, D are byte-identical.

## Files

Modified:
- `src/lib/pipeline/extractor/grounding.ts` — the `*_tax_id` branch now keeps
  the semantic gate ("no tax identifier in document") but no longer `continue`s;
  the field falls through to the standard evidence ladder, so an ungrounded
  value is dropped with "not found in source text" and a relabeled one with
  "value labeled for a different field".
- `tests/_entry.ts` — registers the new test file.

Added:
- `tests/tax-gate.test.ts` — 9-case matrix (grounding level + full pipeline):
  1. fabricated value + keyword present → dropped (not found in source)
  2. real value + keyword present → survives with evidence, full confidence
  3. real value + keyword absent → dropped (no tax identifier)
  4. reference number relabeled as tax ID + keyword → dropped (never borrow)
  5. real value printed with separators → survives via the verify tier
  6. invoice `seller_tax_id` / `buyer_tax_id` → same gate on both fields
  7–9. production pipeline: fabricated dropped end-to-end, real kept with
  evidence, baseline real fields intact.

## Affected fields

`*_tax_id` matches by suffix, covering all profile schemas:
- `receipt.merchant_tax_id`
- `invoice.seller_tax_id`, `invoice.buyer_tax_id`

All are `type: "string"`, `crossCheck: true`, label group `tax`.

## Safety properties preserved

- **No invention**: value must be found verbatim, as a derived variant, or
  separator-free via Verify-or-Find (digit-count guard, no fuzzy matching) —
  `9999999999999999` can never verify against `1234567890000003`.
- **No relabeling**: a value on a line labeled for another group (e.g. the
  reference number 2013438351 on a `number` line) is dropped via
  `labelVerdict` "conflict".
- **Semantic gate kept**: a document with no tax keyword at all still drops the
  field, exactly as before.

## Verification

- `npm test` → **669/669 passed** (was 660; +9 new tax-gate tests). All prior
  regression tests green, including `receipt-extraction.test.ts` (tax id never
  borrows the reference number), `entity-cleaner`, `grounding-evidence`,
  `verify-or-find`, and the full layout suite.
- `npx tsc --noEmit` → **exit 0**.
- `npx eslint src/lib/pipeline/extractor/grounding.ts tests/tax-gate.test.ts
  tests/_entry.ts` → **clean**.
- `tests/live/m14-prod.ts` → PROD C flips SURVIVED (BUG) → DROPPED; A/B/D
  unchanged.
- `tests/live/m14-recon.ts` → Probe 3 flips SURVIVED → DROPPED
  ("not found in source text"); baseline probe unchanged (confidence values
  identical).
