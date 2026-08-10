# M13 — Reconnaissance Report: Why `merchant_name` ("SuperPay") is dropped on the real SuperPay receipt

**Status:** README-ONLY investigation. No production, test, config, prompt, OCR,
schema, threshold, formula, recovery, or layout code was changed. All temporary
instrumentation was reverted; the working tree is clean.

Every conclusion below is tagged **PROVEN** (with `file:line` and/or trace
arithmetic), **INFERRED**, or **UNKNOWN**.

---

## 1. Task and scope

Close the exact-runtime-cause gap for `merchant_name` being dropped by grounding
on the real SuperPay receipt: the exact candidate value, the evidence path
(span/line/scope/layoutRank), the exact `aiConf × ocrFactor × labelFactor`
composition, the `MIN_CONFIDENCE` comparison, and the exact drop branch —
verified by running the real code with real OCR + a real provider-manager AI
client and with a deterministic replay of the committed candidates.

Constraints honored: no threshold/label-factor/rule changes, no
vendor/receipt/merchant/OCR exceptions, no weakening of "never invent" / "never
relabel", no production changes of any kind, no commit/push.

## 2. Method

1. **Fresh real run** — `tests/live/benchmark/run-snapshot.ts --only=real-superpay
   --no-agent` with `M13_TRACE=1` (real OCR via newPre engine + real AI via groq
   through the ProviderManager). Captured the exact OCR line dump, classifier
   behavior, and per-field evidence.
2. **Deterministic replay** — a throwaway script (now deleted) that ran the real
   `groundExtraction` + `createLayoutEvidenceProvider(layoutReaderFor(ocr))` on a
   fresh real OCR pass with the **committed** candidate set from
   `benchmarks/results/pipeline-level.json` (merchant `"SuperPay"`,
   receipt_number `"2013438351"`, date `"02-07-202618:30:12"`, etc.) and swept
   `aiConf ∈ {1.0, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4}`.
3. **Temporary tracing** — a clearly-marked `M13-TEMP` block in
   `src/lib/pipeline/extractor/grounding.ts`, gated by `M13_TRACE=1`, wrote JSONL
   to a temp file outside the workspace (deleted after). It logged Pass 1
   (evidence/kept/drops), Pass 2 (all composition factors), Pass 3 (drop
   branches). Reverted via `git checkout`; `git diff` confirms zero residue.
4. **Verification** — `npm test` (650/650 pass), `npx tsc --noEmit` (exit 0),
   `git status` (only the pre-existing untracked `SUPERPAY-FORENSIC-REPORT.md`).

## 3. Committed baseline (the two subtrees)

`benchmarks/results/pipeline-level.json`, `real-superpay`:

| | `old` (tesseract, OCR-only grounding) | `new` (newPre + layout-aware) |
|---|---|---|
| merchant_name | `"SuperPay"`, **kept**, conf 0.744, reasons `["label_not_matched"]`, evidence `"‏له ‎SuperPay‏ 60"` (pipeline-level.json:1973-1985) | **absent** — dropped (not in `fields`), validation `ok:false, missing:["merchant_name"]` (pipeline-level.json:2093-2097) |
| overall conf | — | 0.7090540027109601 (pipeline-level.json:2100) |
| receipt_number | `"6070218301132167"` | `"La 15468"`, conf 0.389, evidence conf 0.4868 (pipeline-level.json:2114-2128) |

So the SAME value ("SuperPay", which OCR found in both engines — `ocr-level.json`
old:4/6 and newRaw:5/6 and newPre:6/6 GT hits) is grounded by the OCR-only path
and dropped by the layout-aware path. **PROVEN**: the regression is not OCR
availability, not the model, and not the lexicon — it is in the confidence
composition of the layout-aware evidence.

## 4. The exact runtime causal chain (merchant_name = "SuperPay")

From the deterministic replay trace (fresh real OCR, real grounding + layout
provider), candidate `"SuperPay"`, `raw "SuperPay"`:

**Pass 1 — evidence found, kept** (grounding.ts:120-192):
- Provider: `createLayoutEvidenceProvider` → `buildLayoutAwareEvidence`
  (`layout-aware-evidence.ts:109`) — value-match on needle `"SuperPay"`.
- Winning scope: `"document"` (ladder `region → neighbors → block → page →
  document`; SuperPay is a bare header value with no label, so it only matches at
  the outermost scope), `layoutRank: 4`.
- Evidence: `quote "SuperPay"`, `lineIndex 0`, `wordIndices [0]`, `source "ocr"`,
  `confidence 0.1279910151163737`, `context "SuperPay"`, `bbox (x:351,y:246,w:231,h:53)`,
  `role "value-match"`, `scope "document"`, `layoutRank 4`.
- `labelVerdict`: **`neutral`** (no label-group word on the line → not a
  conflict). Not dropped in Pass 1. **PROVEN** (trace entry).
- Note: this same candidate under the same path would drop in Pass 1 only if the
  value were absent from the OCR — it is present (`ocr-level.json` newPre
  `"SuperPay"` found=true).

**Pass 2 — composed confidence** (grounding.ts:194-210):
- `aiConf = clampFieldConfidence(fv)` = **1.0** (model confidence clamped).
- `ocrFactor = ocrConfidenceFactor(fv.evidence, ocrDoc)` (grounding.ts:544-554) =
  mean of evidence confidences = **0.1279910151163737** (single layout evidence
  entry; its `confidence` is the layout `combineConfidence`).
- `labelFactor = labelConfidenceFactor(field, evidence)` (grounding.ts:557-564) =
  **0.8** (`LABEL_NEUTRAL_FACTOR`, no merchant label on the line).
- `hasEvidence = true` → `noEvidenceFactor = 1`.
- `composed = 1.0 × 0.1279910151163737 × 0.8 × 1 = 0.10239281209309897`.
- `reasons = ["ocr_confidence_low", "label_not_matched"]` (ocrFactor 0.128 <
  `LOW_OCR_THRESHOLD` 0.6; labelFactor 0.8 < 1). **PROVEN** (trace + grounding.ts:566-577).

**Pass 3 — dropped** (grounding.ts:212-234):
- `0.10239281209309897 < MIN_CONFIDENCE (0.3)` → branch
  **`confidence_below_threshold`** → field deleted from output.
- **PROVEN** (trace entry: `"pass":3,"branch":"confidence_below_threshold",
  "confidence":0.10239,"minConfidence":0.3`).

**Recovery** (`src/lib/pipeline/stages/recover.ts`): the retry gate only accepts
reasons `"not found in document"` and `"empty value"`. `"confidence below
threshold"` is **not retryable** → merchant is permanently lost. **PROVEN**
(recovery contract).

## 5. Root cause — layout `combineConfidence` dilution, not OCR quality

The layout-aware evidence provider sets `confidence = combineConfidence(entry.confidenceProfile)`
(`layout-aware-evidence.ts:286-292`, `:93-103`), which is the **arithmetic mean
of six component means**: `ocr, geometric, structural, boundary, typological, order`.

The real OCR line 0 is the bare word `SuperPay` with **word confidence 0.768**
(replay OCR dump: `line 0 "SuperPay" conf 0.76794609, wordConfs [0.768]`).
For a standalone, unlabeled header value the other five layout components
(geometric/structural/boundary/typological/order) average ~0, so:

```
combineConfidence = (0.768 + 0 + 0 + 0 + 0 + 0) / 6 = 0.128
```

Trace value **0.1279910151163737** = 0.76794609069822 / 6 exactly. **PROVEN**
(arithmetic reproduces the trace to float precision).

Consequence: `ocrConfidenceFactor` (grounding.ts:544-554) consumes the layout
**combined** confidence (0.128), not the per-word OCR confidence (0.768). The M11
layout path therefore *lowers* the confidence below what the plain OCR path would
use for the same line. The committed `old` (OCR-only) subtree kept merchant at
0.744 precisely because its evidence confidence was the OCR value, not the
six-component average. **PROVEN**.

### Counterfactual (same line, OCR-only path)
`findEvidence`/`makeEvidence` (grounding.ts:248-273, :340-363) would produce an
evidence entry with `confidence = mean(wordConfs)` = **0.768** → `composed =
1.0 × 0.768 × 0.8 = 0.614 > 0.3` → **kept**. **PROVEN** (code path + arithmetic
on the captured word confidence).

## 6. Why neither the AI nor the label factor is the binding constraint

- **AI confidence is irrelevant:** with `aiConf = 1.0` (the maximum) and
  `labelFactor = 0.8`, the composed confidence is 0.102. To pass `MIN_CONFIDENCE`
  the AI would need `aiConf ≥ 0.3 / (0.128 × 0.8) = 2.93` — impossible.
- **The 0.8 label penalty is not decisive:** even if a merchant label had been
  present (`labelFactor = 1.0`), `composed = 1.0 × 0.128 = 0.128 < 0.3` — still
  dropped. **PROVEN** (boundary arithmetic).
- The sweep over `aiConf` 1.0→0.4 all terminate in
  `confidence_below_threshold` (trace entries). **PROVEN**.

The binding constraint is `ocrFactor = 0.128` from the layout `combineConfidence`.

## 7. Ladder provenance

Merchant was matched only at `scope "document"`, `layoutRank 4`. The ladder
(`region → reading-order neighbors → block → page → document`,
`layout-aware-evidence.ts:131-154`) skips SuperPay's bare header line because the
merchant field has no explicit region, no label word, and no structural anchor —
the value survives to the outermost scope, where its layout profile components
are all near zero. **PROVEN** (trace: `layoutRank:4, scope:"document"`).

## 8. OCR nondeterminism caveat

OCR is not bit-for-bit reproducible across engine runs:
- Committed `newPre`: pageConf 0.6788, 18 lines, 307 chars, 6/6 GT hits
  (`ocr-level.json:748-755`); line 0 is `ته‎SuperPay‏`.
- Fresh run used for the replay: pageConf 0.7414278405712497, 20 lines, 303
  chars, 5/6 GT hits; line 0 is the standalone `SuperPay`.

Every numeric claim in this report points at one specific captured instance
(the replay's fresh OCR pass). The **mechanism** (Pass 3 `confidence_below_threshold`
driven by layout `combineConfidence` of a bare-value line) is OCR-instance
independent: in the committed `new` instance the same code path produced the same
outcome (merchant absent, `validation.ok=false`). **PROVEN** outcome,
**UNKNOWN** exact committed-instance evidence confidence (not persisted for
dropped fields).

## 9. Other fields in the same replay instance

All candidate-bearing fields in the fresh OCR instance were also dropped Pass 3
for the same reason (layout evidence confidence ≈ 0.11–0.16 < 0.375 needed):
receipt_number 0.0375, customer_name 0.0511, subtotal 0.0528, total_amount 0.0528,
pos_number 0.0599, notes 0.2135 (all `confidence_below_threshold`); receipt_date
`not_found_in_source_text` (candidate raw `02-07-202618:30:12` does not
normalize-match the fresh OCR's `02-07-2028 18:30:12`), and the rest
`not_found_in_document` (no candidates). **PROVEN** (trace Pass 3 summary).

This mirrors the committed `new` run where the SAME fields were kept — the
difference is the OCR instance's layout profiles (committed lines carry labels /
structure that raise their non-OCR components), not a code-path difference.
**INFERRED**.

## 10. What is NOT the cause (ruled out)

- Not "value absent from OCR": SuperPay is a GT hit in all three OCR subtrees.
- Not the AI/model: real-run candidate was `"SuperPay"` (committed) / `"قوري باي"`
  (a fresh AI run variant); both dropped via the same confidence path, and the
  deterministic replay drops `"SuperPay"` at `aiConf=1.0`.
- Not the merchant lexicon: no SuperPay line contains a merchant label token, so
  `labelFactor=0.8` is applied — but removing it still drops (see §6).
- Not `MIN_CONFIDENCE` semantics per se: `0.102` is genuinely low by design; the
  anomaly is that the layout path *understates* a 0.768-word-confidence line as
  0.128.
- Not the classifier: AI said `invoice`, rules deferred to `receipt`; the drop is
  downstream of classification.

## 11. Persistence / observability gap

- `run-pipeline-level.ts:83` persists evidence as `{quote, confidence}` only —
  `layoutRank`/`scope` are stripped, and dropped fields persist nothing at all.
  The committed `new` run therefore contains **no trace** of why merchant was
  dropped; only `validation.missing` records the symptom. **PROVEN**.
- This gap is why the exact committed-instance drop reason was unknowable from
  artifacts alone and required runtime instrumentation.

## 12. Architectural direction (README only — NOT a proposal to implement)

The evidence layer could stop conflating "how confident is the layout model about
this span" with "how confident is OCR about this span." `combineConfidence`
averages six heterogeneous components so that a strong OCR signal (0.768) is
divided by five near-zero layout signals. Options for future exploration (no
code changes made): keep component means separate so OCR-only confidence survives
on bare-value lines; treat a non-OCR component's absence (not its low mean) as a
neutral 1.0; or consume per-word OCR confidence for the OCR factor when layout
offers no stronger signal. Any change must stay global (no merchant/receipt
exceptions) and must not reintroduce the never-invent/never-relabel hazards.

## 13. Recovery-gate gap

`recover.ts` retries only `not found in document` / `empty value`; a field that
has solid evidence but a sub-threshold composed confidence is never reattempted,
so a confidence-only miss is unrecoverable by the existing M12 find arm. Merchant
is exactly such a case. **PROVEN** (recovery contract).

## 14. Verification performed

- `npm test` → **650/650 passed** (includes grounding N1–N4 never-invent,
  verify-or-find V-series, label C1, recovery F-series).
- `npx tsc --noEmit` → **exit 0**.
- `git diff` after reversion → empty; `git status` → only pre-existing untracked
  `SUPERPAY-FORENSIC-REPORT.md`.
- Temp trace/snapshot/replay artifacts deleted (outside workspace).

## 15. Artifacts referenced

- `benchmarks/results/pipeline-level.json` — committed `old`/`new` subtrees.
- `benchmarks/results/ocr-level.json` — committed OCR subtrees (pageConf, hits).
- `src/lib/pipeline/extractor/grounding.ts` — Pass 1/2/3 + factors (reverted).
- `src/lib/extraction/layout-aware-evidence.ts` — ladder + `combineConfidence`.
- `src/lib/extraction/layout-aware-reader.ts`, `layout-aware-selector.ts`,
  `src/lib/pipeline/stages/{ground,recover}.ts`.
- `benchmarks/corpus/real-superpay.jpg` — the real image.
- Temp artifacts (`m13-ground-trace.jsonl`, `m13-snapshot.json`,
  `m13-replay.ts`) — deleted after analysis.

## 16. Open questions (UNKNOWN)

- Exact committed-`new`-instance evidence confidence / drop reason for merchant
  (not persisted; not reproducible because OCR is nondeterministic).
- Whether other documents' dropped fields share the bare-value-line dilution
  pattern (only this corpus was instrumented).
- The precise intended semantics of the non-OCR layout component means for
  standalone value lines (whether "no signal" should read as 0 or neutral).

## 17. Bottom line

`merchant_name="SuperPay"` is dropped because the layout-aware evidence provider
reports `confidence = 0.128` for a line whose OCR word confidence is 0.768, by
averaging six component means where five are ~0 for a bare header value.
Grounding then composes `1.0 × 0.128 × 0.8 = 0.102 < 0.3` and drops at Pass 3
`confidence_below_threshold`; recovery cannot retry that reason, so the field is
lost and validation reports `missing:["merchant_name"]`. The 0.8 label factor and
the AI confidence are **not** the binding constraint. **PROVEN** by instrumented
trace + replay arithmetic; the root is in M11 layout evidence confidence
composition, not in OCR quality, the model, or the lexicon.
