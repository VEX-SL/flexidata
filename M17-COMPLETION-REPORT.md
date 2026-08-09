# M17 Completion Report — recovery/FIND never fabricates values from weak labels

Milestone: close the recovery/FIND label-tokenization defect documented as the
secondary finding in M16 — `receipt_number` was recovered as **`"MILK 3.50"`**
because the label "Receipt number" tokenized to the generic word `receipt`,
which matched the bare header "RECEIPT" on the itemized fixture, and the whole
next OCR line was then borrowed as the value.

Generated: 2026-08-10

## Status

- **DONE.** Root cause proven by code trace and reproduced in the real
  production pipeline; a small, generic, global fix landed in the FIND arm and
  the recover stage; 6 new regression tests added (F6–F9 + 2 M16 end-to-end);
  full suite (**686/686**), `tsc --noEmit`, and `eslint` all green; live
  before/after probe (`tests/live/m17-recon.ts`) shows the fixed behavior.
- Scope honored: no vendor-, fixture-, or receipt-specific exceptions; no
  `MIN_CONFIDENCE` / label-factor / rule / prompt / OCR / schema changes;
  "never invent" and "never relabel" invariants preserved; existing recovery
  behavior (F1–F5, ambiguous, retry, SuperPay total/date/merchant) unchanged;
  M13–M16 behavior untouched; no commit / push.

## Root cause

`src/lib/pipeline/extractor/verify-or-find.ts` (the shared Verify-or-Find FIND
arm) matched labels **word-level, not phrase-level**:

1. `labelWords` split the field label "Receipt number" into single tokens and
   merged them with the whole `number` category lexicon, so bare **`receipt`**
   (not a lexicon word) became matchable.
2. `firstMatchingLabel` accepted **any single token** (`\breceipt\b`).
3. For string/text fields, `textCandidates` fell back to `nextLineText` — the
   **entire following OCR line** ("MILK 3.50") — when nothing followed the label
   on the label's own line.
4. `coerce(string, …)` accepts any non-empty text, and recovered candidates were
   committed by `applyRecovery` **without ever re-passing through grounding's
   relabel veto**.

A second, previously unnoticed defect in the same code: a real
`"Receipt Number: 123456"` matched only the single token `receipt`, so
`valueAfterLabel` left the label's own remaining tokens in the value →
`"number: 123456"` instead of `"123456"`.

## Answers A–L (code evidence)

- **A. Complete label or any token?** Any single token (`labelWords` split the
  label; `firstMatchingLabel` matched one word). Defect.
- **B. "receipt number" vs "receipt" distinguished?** No — both matchable.
  Defect.
- **C. Label/value adjacency?** Same-line preferred, but `nextLineText`
  allowed the whole next line. No adjacency requirement. Defect.
- **D. Label-end / value-start known?** Only `valueAfterLabel` on the single
  matched token → remaining label tokens leaked into the value. Defect.
- **E. Semantic/type verification?** Only `coerce`; a string accepts anything
  (`"MILK 3.50"` passes). Defect for reference categories.
- **F. Label category used?** Yes — lexicon words merged, but polluted by the
  label's own split tokens. Partial.
- **G. Label-conflict veto?** FIND never called `labelVerdict`/`detectLabelGroup`.
  Defect.
- **H. Whole OCR line as value?** Yes for string/text (next-line fallback, and
  same-line remainder). Defect.
- **I. Generic words recover unrelated lines?** Yes — exactly `"MILK 3.50"`.
  Defect.
- **J. Arrays / text?** Arrays excluded from FIND; `text` behaves like `string`
  (only harmful if the field is required). Minor.
- **K. Re-grounded after FIND?** No — `applyRecovery` committed directly; only
  the cross-provider retry path re-grounds. Defect.
- **L. Would re-grounding alone save it?** No — `"MILK 3.50"` is a real
  substring (value-match anchors it) and `labelVerdict` on that line is neutral
  (no label detected). The fix must happen in the FIND arm (A/B/C), with D as
  the consistency layer.

## Failure matrix (10 generic cases)

| # | Scenario | Before M17 | After M17 |
|---|----------|-----------|-----------|
| 1 | Bare header "RECEIPT" → next line "MILK 3.50" for `receipt_number` | `"MILK 3.50"` | unresolved (A) |
| 2 | `"Receipt Number: 123456"` (multi-token label) | `"number: 123456"` | `"123456"` (A) |
| 3 | `"CORNER STORE"` (merchant word) → next line "RECEIPT" | `"RECEIPT"` | unresolved (A+B) |
| 4 | `"Merchant: ACME Trading"` (label + same-line value) | `"ACME Trading"` | unchanged (A preserves) |
| 5 | Arabic garbled lexicon `"انرقم المرجقي : 2013438351"` | `"2013438351"` | unchanged (lexicon) |
| 6 | Bare "TOTAL" header, no amount on the line | unresolved | unchanged (numberCandidates) |
| 7 | Date header with date on same line | recovered | unchanged (dateCandidates) |
| 8 | `"Merchant\nACME"` (label on own line) | `"ACME"` (next-line) | unresolved → cross-provider retry |
| 9 | Number-labeled line borrowed as a tax id | committed | vetoed by relabel verdict (D) |
| 10 | Next line already contains a label word | unresolved (anyLabel guard) | unresolved (B makes it moot) |

## Fix (smallest global correction, 2 files)

`src/lib/pipeline/extractor/verify-or-find.ts`:

- **A — phrase-anchored labels.** `labelWords` keeps the full normalized label
  phrase + the category lexicon; the label is no longer tokenized into single
  words, so generic fragments (`receipt`, `number`, `name`, `date`, `store`)
  can never anchor a match by themselves. Lexicon anchors (`ref`, `due`,
  `total`, `الاجمالي`, `المرجقي`, `receipt no`, …) are unchanged.
- **B — same-line adjacency.** `textCandidates` requires the value to follow the
  label on the same line; the `nextLineText` / `evidenceForNextLine` fallback
  (whole next line as a value) is removed.
- **C — reference-shape gate.** For string/text fields in the `number`/`tax`
  categories, the value must contain a digit and every whitespace token must
  carry digits (`"123456"`, `"2013 438351"` ok; `"MILK 3.50"`, `"code A100"` not).

`src/lib/pipeline/stages/recover.ts`:

- **D — verdict pass.** Flagged FIND candidates are re-anchored through the
  shared `groundExtraction` ladder (Pass 1) before being committed, so the
  relabel veto and universal checks (tax keyword, currency stated, noise) apply
  to recovery exactly as they do to grounding. Survivors keep their `flagged`
  status and the low FIND confidence (0.3–0.5 window) — the verdict is the only
  gate, so a real `"Receipt Number: 123456"` still recovers.

## Verification

- **Unit (FIND arm)** — `tests/verify-or-find.test.ts`: F6 phrase-no-leak,
  F7 header-never-recovers, F8 same-line-only, F9 reference-shape gate.
- **End-to-end (full pipeline)** — `tests/recovery.test.ts`: the M16 itemized
  fixture leaves `receipt_number` missing (never `"MILK 3.50"`); a real
  `"Receipt Number: 20134"` label recovers `"20134"` flagged at 0.49.
- **Live probe** — `tests/live/m17-recon.ts` on the real production pipeline:

  ```
  A) M16 itemized fixture, generic "RECEIPT" header (before M17: "MILK 3.50")
     receipt_number = MISSING (drop: not found in document)
  B) real label "Receipt Number: 20134" (before M17: "number: 20134")
     receipt_number = "20134" conf=0.4900 source=ocr status=flagged
       reasons=[recovered_from_ocr] evidence=[L1 [label-match] "Receipt Number: 20134"]
  ```
- **Regression**: full suite 686/686 (SuperPay total 0.3–0.49–0.5 window, date
  raw `02-07-2028`, merchant, ambiguous, retry, grounding-dropped-never-retried,
  tax gate, line-items, confidence UX all unchanged), `tsc --noEmit`, `eslint`.

## Remaining issues (out of scope)

- The FIND arm still has no item-aware path for `line_items`; a list recovered
  via Find would lack the itemized evidence ladder (needs its own design).
- Label-on-own-line string layouts (`Merchant\nACME`) are no longer recovered by
  FIND; the cross-provider retry fills them, and nothing is fabricated.
- Recovery verdicts (D) only gate commitment; the retry-eligibility rule
  ("candidates existed → no retry") is unchanged, so a relabel-vetoed candidate
  is final, consistent with grounding-dropped values being final.

## Scope

M13, M14, M15 and M16 remain **CLOSED** and were not re-litigated. No commits,
no pushes.
