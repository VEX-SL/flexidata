# M15 Completion Report — grounded free-text fields keep their real OCR evidence

Milestone: prove and close the last evidence-exemption hole in grounding — the
`notes` branch that committed values **without attaching any OCR evidence**, so a
note that was verbatim in the document was still reported as having "no direct
evidence".

Generated: 2026-08-09

## Status

- **DONE.** Root cause proven end-to-end through the real production pipeline on
  the real 24-line SuperPay fixture; a one-line production fix landed; 4 new
  regression tests added; full suite, typecheck, and lint all green.
- Scope honored: no threshold / label-factor / rule / prompt / OCR / schema /
  vendor-exception changes; "never invent" and "never relabel" invariants
  preserved; M13 (real measured confidence) and M14 (tax-id value anchoring)
  behavior untouched; no commit / push.

## Root cause

`src/lib/pipeline/extractor/grounding.ts` handled the `notes` field with a
**noise check that then `continue`d unconditionally**, skipping the shared
evidence ladder (value-match → derived variants → Verify-or-Find → label verdict
→ primary evidence selection) that every other field goes through:

- A clean note that the model copied verbatim from a single OCR line was
  committed with **no evidence** and the reason **`no_direct_evidence`** — even
  though the value is directly in the document.
- Its confidence was composed from the **page-level** OCR factor × the
  label-neutral factor × the no-evidence penalty (0.9) instead of the actual
  evidence line, and the overall confidence engine's *evidence coverage* signal
  counted the note as ungrounded, dragging down the whole document.
- The clean stage later re-proved the note was grounded to a single line
  (`appearsInOcr`) and **threw the anchor away**.

`line_items` has the same exemption; it was deliberately left out of scope (see
Remaining issues) because its relabel semantics differ.

The fix lets a non-garbage note **fall through** to the standard evidence path,
so it is anchored, labeled, and confidence-scored exactly like every other
field. Unverifiable notes (absent from the document, or spread across multiple
lines) are now dropped in grounding with "not found in source text" — the same
final result the clean stage produced, but at the correct stage and with a
truthful reason.

## Evidence

`tests/live/m15-recon.ts` — full production pipeline (`runPipeline` = classify →
extract → ground → clean → recover → validate → confidence) with a realistic
complete candidate set against the real SuperPay fixture.

| | Before | After |
|---|---|---|
| notes value | "عملية ناجحة" | "عملية ناجحة" (unchanged) |
| notes evidence | `(none)` | `L9 [value-match] "عملية ناجحة"` (wordIndices [1,2], context `[ عملية ناجحة`) |
| notes reasons | `[no_direct_evidence, label_not_matched]` | `[label_not_matched]` |
| notes confidence | 0.6480 | 0.7200 |
| overall confidence | 0.8727 | 0.8889 |
| signals.evidence | 0.8571 | 1.0000 |
| all other fields | unchanged | unchanged |

The note "عملية ناجحة" is printed verbatim on OCR line 9 (`[ عملية ناجحة`); the
system now proves it, instead of claiming otherwise. The `label_not_matched`
reason remains — correctly — because that line carries no "ملاحظات" label.

## Files

Modified:
- `src/lib/pipeline/extractor/grounding.ts` — the `notes` branch keeps its noise
  gate (garbage notes are still dropped with "OCR artifacts / non-clean text")
  but no longer `continue`s; clean notes fall through to the standard evidence
  ladder (evidence attachment, label verdict, primary-evidence selection,
  composed confidence).
- `tests/grounding-evidence.test.ts` — 3 new unit tests:
  1. a note verbatim in a single OCR line survives with `value-match` evidence,
     correct `lineIndex`/`quote`, and **no** `no_direct_evidence`;
  2. a note absent from the document is dropped in grounding with a recorded
     reason;
  3. a note verbatim on a line labeled for another field is dropped (never
     relabel).
- `tests/receipt-extraction.test.ts` — 1 new end-to-end test: grounded notes
  carry OCR evidence through the full extraction path.
- `tests/entity-cleaner.test.ts` — updated the end-to-end assertion: line-merged
  notes (glued from two real OCR lines) are now dropped by **grounding** before
  they reach the cleaner; the end-to-end guarantee is unchanged and stronger.

Added:
- `tests/live/m15-recon.ts` — read-only production-path diagnostic (before/after
  evidence for this report).

## Affected fields

- `receipt.notes` (type `text`, label group `notes`).
- Any other profile's `type: "text"` / free-text field flows through the same
  branch, so the fix is generic.

## Safety properties preserved

- **No invention**: a note not present in the document is dropped ("not found in
  source text") — previously it was dropped by the clean stage with a different
  reason; the final output is identical, the drop is just earlier and truthful.
- **No relabeling**: a note that sits on a line labeled for another category is
  dropped via `labelVerdict` "conflict" — the same universal veto every field
  applies.
- **Garbage gate kept**: noise-fragment notes are still dropped in grounding
  with the original reason; existing garbage-note tests are unchanged.
- **Confidence honest, never boosted**: notes now use the actual evidence line's
  OCR confidence instead of the page mean, and lose only the false
  `no_direct_evidence` penalty — M13 invariants preserved (MIN_CONFIDENCE 0.3,
  LABEL_NEUTRAL_FACTOR 0.8 unchanged, no vendor logic).
- **M14 untouched**: the `*_tax_id` evidence ladder is not modified.

## Verification

- `npm test` → **673/673 passed** (was 669; +4 new). All prior regression tests
  green, including the notes/cleaner/grounding suites and the full layout suite.
- `npx tsc --noEmit` → **exit 0**.
- `npx eslint src/lib/pipeline/extractor/grounding.ts tests/grounding-evidence.test.ts
  tests/receipt-extraction.test.ts tests/entity-cleaner.test.ts` → **clean**.
- `tests/live/m15-recon.ts` → notes evidence flips `(none)` → `L9 value-match`;
  reasons lose `no_direct_evidence`; overall 0.8727 → 0.8889; all other fields
  byte-identical.

## Remaining issues (out of scope)

- **`line_items` carries the same evidence exemption** (`grounding.ts` still
  `continue`s after the itemized-list gate). It is not fixed in M15 because its
  relabel semantics differ: `line_items` maps to label group `items`, which is
  not a member of `LABEL_GROUPS`, so a naive fall-through would drop legitimate
  items whose description line carries any other label. That needs a deliberate
  design decision (dedicated `items` label group, or a line-items-specific
  evidence/verdict path) and a real itemized fixture to prove; left for a future
  milestone.
- The date field can carry both a `value-match` and a `derived` evidence on the
  same line; both are true and harmless (noted, not a defect).

## Scope

M13 and M14 remain **CLOSED** and were not re-litigated. No commits, no pushes.
