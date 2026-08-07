# M12 Completion Report — Verify-or-Find

Milestone: deterministic evidence tier that verifies model values against the
document and finds grounded candidates for required fields the model missed —
sharing one engine between the grounding stage (VERIFY) and the recovery stage
(FIND), resolving the amount-due label collision.

Generated: 2026-08-08

## Status

- **DONE.** All four user-approved decisions implemented and verified.
  - Recovery absorbed via a **shared engine with the contract preserved** —
    Verify-or-Find is a new evidence tier inside grounding (VERIFY arm), and
    the recovery stage's label-driven search was refactored onto the same
    engine (`findFieldCandidates`). `recoverMissingFields` + the recover stage
    keep producing `flagged` / `ambiguous` + cross-provider retry exactly as
    before.
  - **20 scenarios derived** from the milestone invariants and the verified
    bottleneck, plus the four no-invention cases (Amazon/Amzon,
    999999/123456, John Smith/John, $100/$1000). Intent of each scenario is
    documented below.
  - No commit / push / tag. M13 not started.

## Root cause

The verified bottleneck: **grounding treated "the model's value appears in the
document" as a verbatim-string or first-match problem**, so three real cases
failed while two unsafe cases slipped through:

1. **Derived forms were not verified.** A reference printed `REF 2013438351`
   while the model returned `2013 438351`, or a date printed `2026/07/02` for
   `2026-07-02` — the value tier searched for the exact string, found nothing,
   and the field was dropped even though the value was plainly in the document.
2. **Amount matching anchored on substrings.** `$100` could ground against a
   printed `$1000` and `38.40` could fail against `38.4`, because the matcher
   compared raw strings instead of numeric value equality.
3. **Label collision.** `AMOUNT DUE 38.40` — the classic receipt total — was
   classified as a *date* line: the `date` group's bare word `due` matched
   before the `total` group's longer phrase `amount due` (first-match-wins), so
   a legitimate total was vetoed as "value labeled for a different field".

## Files

Added:
- `src/lib/pipeline/extractor/verify-or-find.ts` — the shared engine:
  `verifyEvidence` (VERIFY arm: separator-free references, ISO-order date
  layouts, digit-family normalization) and `findFieldCandidates` (FIND arm:
  label-driven discovery). Owns `RecoveryCandidate` and the flag-confidence
  machinery.
- `tests/verify-or-find.test.ts` — the 20 scenarios.

Modified:
- `src/lib/pipeline/extractor/label-lexicon.ts` — `detectLabelGroup` now
  **longest-match-wins** (ties by group order): `amount due` beats `due`, while
  `due date` stays a date.
- `src/lib/pipeline/extractor/grounding.ts` — new Verify tier in the evidence
  ladder (exact layout → exact OCR/source → derived variants → **verify** →
  drop); numeric value-equality matching with a magnitude guard; derived-variant
  search uses the same numeric equality; `makeEvidence` accepts an explicit span.
- `src/lib/pipeline/extractor/recovery.ts` — refactored onto
  `findFieldCandidates`; `RecoveryCandidate` re-exported (public API intact);
  `RecoverResult` and stage wiring untouched.
- `tests/grounding-evidence.test.ts` — single expectation update (see
  Regression Safety).
- `tests/_entry.ts` — registers `verify-or-find.test.ts`.

Untouched (per scope): OCR, AI providers, prompts, profiles, DTO/DB, M1–M11
layout, entity-cleaner, post-processor, normalizer, types.

## Architecture flow

The evidence ladder in `groundExtraction` is now:

1. **Layout-aware evidence** (M11 provider: explicit region → reading-order
   neighbors → same block → same page → whole document).
2. **Exact OCR / source match** — verbatim string search; **numeric fields
   anchor on value equality** (`findNumericSpan`), never raw substring.
3. **Derived variants** — day-first regional date layouts and thousands
   separators; numeric variants use the same equality guard.
4. **Verify-or-Find (M12)** — only when 1–3 yield nothing:
   - *Date fields:* `yyyy/mm/dd`, `yyyy.mm.dd`, `yyyymmdd` (ISO order) plus the
     Arabic-Indic/Persian digit families via the shared `normalizeText`.
   - *Reference/tax fields* (`number`/`tax` label categories, string type):
     separator-free verification (`REF 2013438351` ⇔ `2013 438351`) with a
     digit-count guard on the anchored span.
   - *Amounts:* owned by tiers 2–3; the VERIFY arm intentionally returns
     nothing so a bare value is never invented.
5. **Drop** — unchanged reason strings (`not found in source text`, …).

Verification is strict grounding: everything returned is a real OCR span, and
`labelVerdict` / `choosePrimaryEvidence` / confidence composition run
unchanged on it.

## Candidate discovery (FIND arm)

`findFieldCandidates(field, ocrDoc)` uses **only profile metadata** — the
field's semantic label category (label-lexicon), the field label text, the
field type's expected value pattern (`coerce`), and the OCR spans. Per type:
date-pattern capture, number/currency match after the label, enum members,
boolean words (Arabic/English), and string value-after-label with a
label-line guard for next-line values. Deterministic: words sorted longest
first, lines in OCR order. This is the same engine the recovery stage calls, so
**recovery and grounding cannot disagree about what a field means.**

## Label collision resolution

`detectLabelGroup("AMOUNT DUE  38.40")` now returns `"total"` (longest label
phrase wins), and `"DUE DATE  12.00"` still returns `"date"`. Consequences:
- `total_amount` printed only on an AMOUNT DUE line survives grounding (it was
  previously vetoed as a date-conflict).
- Entity-cleaner's relabel guard and grounding's `labelVerdict` /
  `labelConfidenceFactor` / `choosePrimaryEvidence` scoring all see the correct
  category.
- `recovery.ts` already sorted label words by length, so its path was correct
  before the fix.

## Recovery interaction

`recovery.ts` now delegates to `findFieldCandidates`; `recoverMissingFields`
keeps its contract byte-for-byte:
- exactly one grounded candidate → `flagged` (source `ocr`, confidence ≤ 0.5,
  reasons `recovered_from_ocr` [± `ocr_confidence_low`]);
- several distinct candidates → `ambiguous` with `alternatives`, value null;
- none → field stays unresolved;
- the recover stage's retry gating (cross-provider retry only for
  required-null fields with no deterministic candidate) is unchanged.

## Entity cleaner interaction

No code changes in `entity-cleaner.ts`. Its guards now behave correctly purely
because `detectLabelGroup` classifies AMOUNT DUE lines as totals, and the
cleaner re-grounds cleaned values through `groundExtraction`, so it inherits
the new tiers automatically.

## No-invention guarantees

Four committed cases prove the engine never invents:
- `Amazon` never verifies as `Amzon` (no fuzzy similarity anywhere).
- `999999` never verifies as `123456` (exact equality only).
- `John Smith` never verifies as `John` (substring ≠ verification).
- `$100` never verifies as `$1000` (magnitude guard on numeric equality).

## Verification (exact counts)

- **Baseline:** 630/630 tests passing; `tsc --noEmit` clean; lint issues
  pre-existing only (live tools, `tests/preprocess.test.ts`, agent-context,
  unrelated app routes).
- **After M12:** **650/650 tests passing** — 630 unchanged-region tests (incl.
  all 8 recovery contract tests) + **20 new M12 tests**.
- **`tsc --noEmit`: clean.**
- **Lint:** 145 problems — all pre-existing in untouched files; **0 in M12
  files** (`verify-or-find.ts`, `grounding.ts`, `recovery.ts`,
  `label-lexicon.ts`, `verify-or-find.test.ts`).

## Regression safety

- The **only** expectation change across the whole suite is the one
  user-approved collision-fix test: `grounding-evidence.test.ts` ("identical
  duplicate spans …"), which previously passed *only because of the bug*. Its
  expected primary confidence moved 0.6 → 0.99 (the label-matched AMOUNT DUE
  span now wins over the low-confidence TOTAL span). Grep confirmed it was the
  only test touching AMOUNT DUE.
- All 8 `recovery.test.ts` tests (flagged/ambiguous/retry-gating/drop-reason)
  pass unchanged after the shared-engine refactor — the strongest evidence the
  contract was preserved.
- Layout-aware path, entity-cleaner, Arabic OCR, export/DTO, agent-context,
  and all M1–M11 suites: untouched and green.

## Integration impact

- `extractDocument` / `runPipeline` / `defaults` wiring: no signature changes;
  the new tier lives entirely inside `groundExtraction`, so every caller (M11
  layout path, direct calls, clean stage re-grounding) gets it.
- `RecoveryCandidate` re-exported from `recovery.ts`; `RecoverResult` shape
  unchanged; export DTOs unchanged.
- Deterministic: identical inputs → identical evidence and decisions (no
  randomness, no provider dependence in either arm).

## Remaining limitations

- Verify tiers are intentionally narrow (references + ISO date layouts); other
  derived forms (e.g. spelled-out amounts, currency-code prefixes) are out of
  scope and still drop — by design, never guess.
- The digit-count guard on separator-free references requires the *exact* digit
  sequence; a reference OCR'd with a misread digit will not verify (correct
  behavior — flagged rather than invented).
- `dateVariants` (derived) covers day-first regional layouts; VERIFY covers
  ISO-order layouts. A document printing *both* keeps honest `alternatives`.
- Recovery confidence stays capped at 0.5; flagged values still require review
  (no threshold tuning done in M12).
