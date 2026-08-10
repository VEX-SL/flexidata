# M16 Completion Report — grounded line_items keep their real OCR evidence

Milestone: prove and close the last evidence-exemption hole in grounding — the
`line_items` branch that committed itemized values **without attaching any OCR
evidence**, so items whose descriptions were verbatim on their own OCR lines were
still reported as having "no direct evidence" and were unfairly confidence-penalized.

Generated: 2026-08-09

## Status

- **DONE.** Root cause proven end-to-end through the real production pipeline on
  an itemized receipt; a small production fix landed; 8 new regression tests
  added; full suite (680/680), typecheck, and lint all green.
- Scope honored: no threshold / label-factor / rule / prompt / OCR / schema /
  vendor-exception changes; "never invent" and "never relabel" invariants
  preserved; M13, M14 and M15 behavior untouched; no commit / push.
- A secondary FIND-arm finding was documented but deliberately **not** fixed
  (see Remaining issues) — it is not the proven target and needs its own design
  decision.

## Root cause

`src/lib/pipeline/extractor/grounding.ts` handled the `line_items` field with a
**`continue` immediately after the itemized-list gate check**, skipping the shared
evidence ladder (value-match → derived variants → Verify-or-Find → label verdict →
primary evidence selection) that every other field goes through:

- For a list candidate, `valueNeedles` returned an empty needle set (it only knew
  scalars), so the evidence search never ran; each committed item carried **no
  evidence** and the reason **`no_direct_evidence`** — even when every description
  sat verbatim on its own OCR line.
- Its confidence was composed from the gate's low-confidence branch (0.9 × 0.48 ×
  0.8 = **0.3456**) plus the no-evidence penalty, instead of the actual evidence
  lines; the overall confidence engine's *evidence coverage* signal counted the
  items as ungrounded, dragging down the whole document.
- The clean stage later re-grounded the descriptions and **threw the anchors away**.

The fix makes array/object fields flow into the standard evidence path:

- `valueNeedles` now returns the itemized **descriptions** for array/object
  values, and the `line_items` branch calls the shared `findEvidence` with a
  bounded per-item search window (`{ maxWords: 10 }`) so multi-word descriptions
  anchor to a single real OCR line instead of gluing adjacent words.
- Committed items are then anchored, labeled, and confidence-scored exactly like
  every other field. Fabricated items whose descriptions appear nowhere in the
  document are now dropped in grounding with "not found in source text" — the
  same final result the clean stage produced, but at the correct stage and with a
  truthful reason.
- The item-description **garbage gate is unchanged**: noise fragments are still
  pruned by the clean stage.

## Evidence

`tests/live/m16-recon.ts` — full production pipeline (`runPipeline` = classify →
extract → ground → clean → recover → validate → confidence) with a fake AI
against a small realistic itemized receipt (`CORNER STORE / RECEIPT / MILK 3.50 /
BREAD 2.00 / TOTAL 5.50 / Date: 2025-01-15`).

| | Before | After |
|---|---|---|
| line_items value | (dropped by clean stage) | 2 items (MILK, BREAD) |
| line_items evidence | `(none)` | `L2 [value-match] "MILK"` \| `L3 [value-match] "BREAD"` |
| line_items reasons | `[no_direct_evidence, label_not_matched]` | `[label_not_matched]` |
| line_items confidence | 0.3456 (gate low-confidence branch) | 0.7200 (0.9 × 1.0 × 0.8) |
| all other fields | unchanged | unchanged |

`tests/live/m16-layout-probe.ts` — the same check through the **layout evidence
provider** (production shape: structured OCR with per-word boxes and confidence
0.768): line_items keep `L1 [document] "MILK"` \| `L2 [document] "BREAD"`,
reasons `[label_not_matched]`, confidence 0.5530 (0.9 × 0.768 × 0.8) — no
`no_direct_evidence`, no penalty.

The `label_not_matched` reason remains — correctly — because description lines
carry no "items" label. A description found on a line labeled for another
category is still vetoed by the universal `labelVerdict` "conflict" rule (never
relabel).

## Files

Modified:
- `src/lib/pipeline/extractor/grounding.ts` — `valueNeedles` surfaces item
  descriptions for array/object fields; the `line_items` branch no longer
  `continue`s before evidence search and now runs the shared ladder with a
  bounded per-item search window; fabricated items are dropped in grounding with
  a truthful reason.
- `tests/grounding-evidence.test.ts` — 7 new unit tests: grounded items attach
  `value-match` evidence per description (correct `lineIndex`/`quote`, no
  `no_direct_evidence`); multi-word descriptions anchor to a single line (no word
  glue); absent descriptions are dropped with a recorded reason; item field stays
  uncommitted when the list gate rejects it; a description on a line labeled for
  another category is dropped (never relabel); recovered `receipt_number` keeps
  `recovered_from_ocr` without `no_direct_evidence`; noise-only descriptions are
  still dropped.
- `tests/receipt-extraction.test.ts` — 1 new end-to-end test: grounded line_items
  carry OCR evidence through the full extraction path.
- `tests/entity-cleaner.test.ts` — updated the end-to-end assertion: fabricated
  items are now dropped by **grounding** before they reach the cleaner; the
  end-to-end guarantee (empty output + recorded reason) is unchanged and
  stronger.

Added:
- `tests/live/m16-recon.ts` — read-only production-path diagnostic (before/after
  evidence for this report).
- `tests/live/m16-layout-probe.ts` — read-only layout-path (structured OCR)
  diagnostic proving the production shape is covered.

## Affected fields

- `receipt.line_items` (type `list`).
- Any other profile's array/list field flows through the same branch, so the fix
  is generic.

## Safety properties preserved

- **No invention**: items whose descriptions appear nowhere in the document are
  dropped ("not found in source text") — previously dropped by the clean stage
  with a different reason; the final output is identical, the drop is just
  earlier and truthful.
- **No relabeling**: an item description found on a line labeled for another
  category is dropped via `labelVerdict` "conflict" — the same universal veto
  every field applies.
- **Garbage gate kept**: noise-fragment descriptions are still pruned by the
  clean stage with its original semantics; the noise-only test is unchanged.
- **Confidence honest, never boosted**: items now use the actual evidence lines'
  OCR confidence instead of the gate's low-confidence branch, and lose only the
  false `no_direct_evidence` penalty — M13 invariants preserved (MIN_CONFIDENCE
  0.3, LABEL_NEUTRAL_FACTOR 0.8 unchanged, no vendor logic).
- **M14 untouched**: the `*_tax_id` evidence ladder is not modified.
- **M15 untouched**: the `notes` branch, its garbage gate, and its relabel veto
  are not modified.

## Verification

- `npm test` → **680/680 passed** (was 673; +7 net: +7 grounding-evidence, +1
  receipt-extraction, −1 entity-cleaner). All prior regression tests green,
  including the notes/cleaner/grounding suites and the full layout suite.
- `npx tsc --noEmit` → **exit 0**.
- `npx eslint src/lib/pipeline/extractor/grounding.ts tests/grounding-evidence.test.ts
  tests/receipt-extraction.test.ts tests/entity-cleaner.test.ts tests/live/m16-recon.ts
  tests/live/m16-layout-probe.ts` → **clean**.
- `tests/live/m16-recon.ts` → line_items evidence flips `(none)` →
  `L2 "MILK" | L3 "BREAD"`; reasons lose `no_direct_evidence`; confidence 0.3456
  → 0.7200; all other fields byte-identical.
- `tests/live/m16-layout-probe.ts` → same outcome through the layout provider.
- `tests/live/m15-recon.ts` → notes evidence/reasons/confidence byte-identical
  (M15 regression check).
- `tests/live/m14-prod.ts` → all four PROD checks keep the same final outcomes;
  PROD B (fabricated 2-item list) still DROPPED, now with the earlier, truthful
  reason (M14 regression check).

## Secondary finding (documented, NOT fixed)

`findFieldCandidates` (the recovery/FIND arm) recovered `receipt_number` as
`"MILK 3.50"` on the itemized fixture: the label "Receipt number" tokenizes
weakly to the literal word "receipt", which matched the header word "RECEIPT" on
line 2, and the whole line's text was then returned as the candidate value
(reasons `[recovered_from_ocr]`, label-match evidence on that line). This is a
label-tokenization false positive in the FIND arm, not part of the proven M16
target; it needs its own design decision (label-token anchoring rules or a
receipt-number-specific pattern) and a real fixture, so it is left unfixed here.

## Remaining issues (out of scope)

- The recovery/FIND arm has no item-aware path for `line_items`; a list recovered
  via Find would still lack the itemized evidence ladder. Requires its own
  design decision.
- The label-tokenization false positive above (FIND arm recovering a whole OCR
  line for "receipt").
- The date field can carry both a `value-match` and a `derived` evidence on the
  same line; both are true and harmless (noted, not a defect).

## Scope

M13, M14 and M15 remain **CLOSED** and were not re-litigated. No commits, no
pushes.
