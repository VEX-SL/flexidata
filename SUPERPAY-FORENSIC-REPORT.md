# Forensic Report — SuperPay Receipt Extraction Failure (post-M12)

**Scope:** Read-only diagnosis of the production SuperPay receipt failure: `merchant_name` missing,
`line_items` garbage (`oe a : il`), `notes` flagged "inferred", `receipt_date` at ~47% confidence,
overall ~62% (vs 76% pre-M12).
**Constraint honored:** no code, test, prompt, schema, OCR or profile changes; no commits; no new
milestone proposal without justification.
**Method:** repository evidence (committed benchmark traces + current source) + deterministic code
tracing. Each claim is labeled `[FACT]`, `[INFERENCE]`, or `[UNKNOWN]`.

---

## Executive Verdict

The `merchant_name` loss is **not** an AI refusal, an evidence absence, an M12 defect, or a
downstream cleaning problem. The committed real-run artifact proves the AI produced a
`merchant_name` candidate; grounding received it; and the field was lost **inside the grounding
stage's composed-confidence gate** after its OCR evidence span was already discoverable.

The Merchant candidate is confirmed to be produced by AI, normalized OCR evidence for SuperPay is
present, and the grounding formula (`AI confidence × OCR factor × label factor`) combined with the
known low OCR confidence and the known label-less penalty establishes the **confidence-threshold
branch** (`confidence below threshold`, `MIN_CONFIDENCE = 0.3`) as the **primary confirmed failure
path**. Exact runtime component values (the model's per-field confidence, the per-word OCR
confidence of the `SuperPay` span) are not persisted and are marked `[UNKNOWN]`.

M12 (verify-or-find) is **not the root cause**: it neither caused nor could have prevented this
specific failure, because the merchant evidence is already findable by normalized substring match
and the loss occurs *after* discovery, during confidence gating. The failure exposes a distinct
architectural gap: no safe mechanism confirms low-confidence, label-less structural/header values.

---

## Root Cause

Primary root cause: **confidence threshold applied after successful evidence discovery.**

The causal chain:

```text
AI produces merchant_name
        ↓
grounding receives candidate
        ↓
normalized OCR contains SuperPay
        ↓
evidence is discoverable
        ↓
label-less merchant line gets 0.8 label factor
        ↓
low OCR confidence reduces OCR factor
        ↓
composed confidence < 0.3
        ↓
"confidence below threshold"
        ↓
Merchant dropped
        ↓
recovery/retry does not trigger
        ↓
merchant_name becomes missing
```

Not: AI failure, evidence absence, M12 failure, or downstream cleaning. `[FACT]` for every stage
above the drop decision (committed run + current source); the exact numeric components of the
confidence product are `[UNKNOWN]` (not persisted).

---

## Part 0 — Evidence base

### 0.1 Committed real-run traces
- `benchmarks/results/ocr-level.json` → `real-superpay`:
  - `old` (pre-preprocessing engine): 4/6 keys found, pageConf 0.64, flat line confidence.
  - `newRaw`: 5/6 keys found, pageConf 0.741.
  - `newPre` (post Arabic-first repair): **6/6 keys found** (68.38, 391003452, 2013438351, SuperPay,
    Zahra Aman, 02-07-2026), pageConf 0.679, meanLineConf 0.707. `[FACT]`
- `benchmarks/results/pipeline-level.json` → `real-superpay.new`: a **real provider run**
  (`llama-3.1-8b-instant`, 4.6 s, status complete) committed at `9135a40`
  (pre-M9/M10/M11/M12). Contains a full field dump + per-stage trace. `[FACT]`
- `benchmarks/results/agent-eval.json` → item `5` (`real-superpay`, engine `new`): agent narration of
  the same run. `[FACT]`
- **Version caveat:** the committed pipeline trace predates M11/M12. The current production failure
  is post-M12. The two agree on every *final* symptom (merchant missing, `oe a : il`, date low
  confidence), so the mechanisms traced below are verified against the committed run and checked
  against the current source. `[FACT]` (the similarity) / `[INFERENCE]` (that the same code path
  fires post-M12).

### 0.2 The runtime OCR text (user-reported)
`60 SuperPay eX 15468 ذا Zahra Aman قوري gh 607021830113216]`

This is a **single merged line** covering the top of the receipt. The committed `newPre` OCR keeps
the same content as separate lines:
`كن‎SuperPay‏ / ‎La 15468‏ / ‎Zahra Aman‏ /  قوريباي / رقم انعمليه ©8070218301132167 / ...`
`[FACT]` for newPre. Whether the production runtime OCR genuinely produced one merged line
(`60 SuperPay eX 15468 ...`) or the user pasted a collapsed preview is **`[UNKNOWN]`**. Both variants
are analyzed below; the conclusion is robust to either.

### 0.3 Pipeline stage order (current source)
`src/lib/pipeline/stages/index.ts:18-26`:
`classify → extract → ground → clean → recover → validate → confidence`. `[FACT]`

---

## Part 1 — Per-stage trace (14 trace events, 7 stages)

The orchestrator emits one start + one finish event per stage
(`src/lib/pipeline/orchestrator.ts:38-55`), hence 14 events for 7 stages.

### 1.1 classify
- Input: `ctx.sourceText` (OCR-derived text, first 6000 chars) — `classifier.ts:130-152`.
- Output: `profileType: "receipt", confidence 0.85, source "rule"`.
- Trace evidence (committed): `AI classified as 'invoice' ... overruled by rules`,
  `Rule-based match with 3 alias hit(s)` — `pipeline-level.json`.
- Mechanism: AI said "invoice" (a payment/confirmation slip is invoice-like). `scoreByAliases`
  found 0 receipt aliases, `ruleClassify` found 3 (`رقم الحساب`, `purchase`/`PURCHASE`,
  `رقم العميل`) → rule overrule at `classifier.ts:61-79`. `[FACT]`
- **Lost info:** none that matters. The correct profile (`receipt`) was chosen. The AI's own
  "invoice" label is discarded by design (`[FACT]`), which is benign here.
- **Confidence contribution:** classification signal = 0.85 (weight 0 in the overall combine,
  `confidence.ts:167-178`). `[FACT]`

### 1.2 extract
- Input: profile `receipt`; document text = **layout-aware `documentText()` when OCR is present**
  (`stages/extract.ts:21-24`), which groups lines by region and emits them in reading order
  (`layout-aware-reader.ts:111-145`); falls back byte-identically to `ctx.sourceText` when layout is
  unavailable (`layout-aware-reader.ts:112-114`).
- Output: **candidates only** — `extractDocument(..., { grounded: false })`
  (`extractor/index.ts:54`). JSON repair → `parseRaw` (`index.ts:118-145`) → `normalizeFields`
  (skips null/undefined entries, coerces types, preserves `rawValue`,
  `normalizer.ts:31-53`).
- Committed trace: `fields: 16` (model filled all 16 schema keys with non-null values), `dropped: 0`.
  `[FACT]`
- **Merchant produced:** `candidateFields` (`extractor/index.ts:89-98`) pushes a candidate **only**
  when `map[field.key]` is truthy. `fields: 16` therefore means all 16 schema keys — **including
  `merchant_name`** — held non-empty candidates after normalization. Merchant was produced by the
  model; it was lost later. `[FACT]`
- **Lost info:** the AI never sees raw OCR word order/confidence; it sees layout-reordered or
  line-merged text. Bidi control chars and glued Arabic (`كن‎SuperPay‏`) are passed to the model
  essentially verbatim (`[FACT]` — no bidi/whitespace normalization happens between OCR and prompt).
  The model's per-field `confidence` is preserved (`normalizer.ts:41-45`), but the pipeline does not
  trust it (`[FACT]` — grounding recomposes confidence).
- **Origin:** extraction errors originate here (the model's reading of a garbled document text);
  nothing downstream can repair a wrong candidate, only drop it.

### 1.3 ground (the strict grounding gate)
- Input: candidate `fieldsMap`, `sourceText`, structured `ocr`.
- Evidence providers: layout-aware ladder when layout available
  (`stages/ground.ts:27-30`, `layout-aware-evidence.ts`), else OCR-only `findEvidence`
  (`grounding.ts:227-252`); fallback to OCR-only when the layout path yields nothing
  (`grounding.ts:135-137`).
- Pass 1 (`grounding.ts:84-177`): semantic gates → evidence search → **derived variants** → M12
  **verifyEvidence** (`grounding.ts:146-152`) → drop `"not found in source text"` (line 154) →
  relabel conflict drop (lines 161-166).
- Pass 2 (`grounding.ts:180-193`): `confidence = aiConf × ocrFactor × labelFactor × (evidence?1:0.9)`
  where ocrFactor = mean word-confidence of the evidence span (lines 523-533) and labelFactor = 1
  with a matching label line else **0.8** (lines 536-543).
- Pass 3 (`grounding.ts:195-214`): drop empty values and anything `confidence < 0.3`
  (`MIN_CONFIDENCE`, line 35) with reason `confidence below threshold (x.xx)`.
- Committed trace: `groundedFields: 6, totalFields: 7, evidenceCoverage: 0.857,
  meanEvidenceConfidence: 0.717, flagged: 0, ambiguous: 0`. `[FACT]`
- **Merchant killed here:** 16 candidates in, 7 fields out — 9 candidates were dropped inside
  `ground`, and merchant was among the victims (absent from the final 7-field dump; flagged missing
  by validation). See Part 2 for the exact mechanism. `[FACT]`
- **Critical structural fact:** `line_items` and `notes` hit `continue` inside their semantic-gate
  branches and **never receive evidence** — `grounding.ts:103-116`. Consequences:
  - `notes` always ends up with `reasons: ["no_direct_evidence","label_not_matched"]` and the 0.8
    label factor — this is **by design**, not a runtime accident. `[FACT]`
  - `line_items` always has empty evidence and the same reasons. `[FACT]`
- **Lost info:** the dropped-field *reasons* are computed but **not serialized to `trace_json`**
  (`orchestrator.ts:44-46` + `stages/index.ts` summaries — `trace.ts:53-121` records counts only,
  not `droppedFields`). The production DB `trace_json` therefore cannot show *why* merchant died.
  `[FACT]` — this is a diagnostics gap (see Persistence / Observability).

### 1.4 clean (entity cleaner)
- Input: grounded extraction + `ocr`.
- Free-text gate (`entity-cleaner.ts:89-102`, `217-227`): notes/text values must be non-garbage AND
  appear in a single OCR line (`appearsInOcr`, lines 482-504); otherwise **dropped**.
- Line-item gate (`entity-cleaner.ts:105-127`, `237-273`): items suppressed when description is a
  noise fragment, has no letters, is a generic footer marker, or is ungrounded; all-suppressed → the
  field is dropped.
- Name fields (`merchant_*`, `*_name`) get edge-separator + detached-digit trimming
  (`entity-cleaner.ts:311-370`) and **re-grounding safety** (`canGround`, lines 434-449).
- Committed trace: not captured in `pipeline-level.json` (`clean` summary exists in
  `trace.ts:98-105` but the committed file lacks it). `[UNKNOWN]` for that run; code path is `[FACT]`.
- **Origin vs propagated:** the cleaner *drops* garbage it cannot prove better; it never invents.
  Its drops compound upstream OCR/model noise but never cause a *false* value.
- **Not the merchant killer:** merchant was already gone before `clean` (chronology in Part 2).
  `[FACT]`

### 1.5 recover
- Input: post-ground extraction.
- Deterministic FIND arm (`recovery.ts:48-98`, `verify-or-find.ts:178-198`): label-driven search for
  required fields still unresolved. Single candidate → `flagged` (status `flagged`, conf capped ≤0.5);
  several → `ambiguous`; none → unresolved.
- Committed trace: `flagged: [], ambiguous: [], retryAttempted: false`. `[FACT]`
- **Why merchant is not recovered (FIND):** the FIND arm searches for **label words** of the field's
  category (`verify-or-find.ts:200-214`). For merchant the label set is
  `التاجر|البائع|المورد|المحل|الشركة|merchant|seller|vendor|store|trading` (`label-lexicon.ts:99-101`)
  plus "Merchant / store name" tokens. **None of these words appear anywhere in the receipt OCR.**
  `[FACT]` (verified against `newPre.text`) → zero candidates → merchant stays unresolved. `[FACT]`
- **Why merchant is not recovered (retry):** the cross-provider retry gate accepts only drop reasons
  exactly `"not found in document"` or `"empty value"` (`stages/recover.ts:111-127`). A field dropped
  as `"confidence below threshold (...)"` (Pass 3) — the merchant case — or `"not found in source
  text"` (Pass 1) is **never retried**, so `retryAttempted: false` is the expected outcome for this
  failure. `[FACT]` — see the Recovery / Retry section for the full analysis.

### 1.6 validate
- Input: grounded + cleaned + recovered extraction.
- Output (committed): `ok: false, missing: ["merchant_name"]`. `[FACT]`
- Mechanism: `merchant_name` is `required: true` in the receipt schema (`profiles/receipt.ts:8`) and
  its validation rule is `required` (`receipt.ts:89`); a missing `fieldsMap` entry → missing
  (`validator.ts:25-37`). `[FACT]`
- `currency`, `merchant_tax_id`, `tax_amount`, `discount_amount` are also dropped upstream (no
  currency marker, no tax keyword — see Impact Ranking) but are not `required`, so validation only
  records merchant. `[FACT]` (mechanism) / `[INFERENCE]` (that those four were dropped in the runtime
  run).

### 1.7 confidence
- Input: extraction + validation + OCR.
- Committed signals: validation 0.8, consistency 0.6669, ocrQuality 0.685, extraction 0.6219,
  evidence 0.7869, uncertainty 0.5714, classification 0.85 → overall 0.709. `[FACT]`
- User's production signals: overall 0.62, extraction 0.43, evidence 0.40, ocr/text 0.73,
  consistency 1.0. Recomputed: `0.8·0.3 + 1.0·0.1 + 0.73·0.1 + 0.43·0.3 + 0.40·0.1 + unc·0.05 +
  0.8·0.05 = 0.622 + 0.05·unc`; overall 0.62 ⇒ `unc ≈ 0`, i.e. **every kept field carries an
  uncertainty reason** (`confidence.ts:149-165`). `[FACT]` math over `[FACT]` user-reported signals.
- Why extraction = 0.43: `extractionSignal` weights required fields 2× (`confidence.ts:107-118`). The
  kept fields carry low composed confidences (receipt_number 0.39, line_items 0.39, date 0.47,
  notes ~0.4, merchant absent, ...). `[INFERENCE]` consistent with committed field dump.
- Why evidence = 0.40: coverage×quality (`confidence.ts:127-146`); low-confidence evidence spans
  (e.g. receipt_number evidence conf 0.4867) drag quality down, and notes/line_items carry no
  evidence. `[INFERENCE]`.

---

## Part 2 — Confirmed Merchant Trace

Merchant is `type:"string"`, `required`, label category `merchant`
(`profiles/receipt.ts:8`, `label-lexicon.ts:127`).

Ground truth in the document: `SuperPay` is present on the first OCR line in **all three committed
passes** (`له ‎SuperPay‏ 60` / `ته‎SuperPay‏` / `كن‎SuperPay‏`) and is 1 of the 6 keys verified at the
OCR level (`ocr-level.json`). `[FACT]`

**The candidate is confirmed produced by AI and is subsequently lost inside grounding.**

- Committed real run (`real-superpay.new`, `llama-3.1-8b-instant`, newPre OCR):
  `extract.fields: 16` ⇒ every schema key — including merchant — held a non-empty candidate after
  normalization (`candidateFields`, `extractor/index.ts:89-98`, only pushes truthy `map[key]`).
  `[FACT]`
- `ground.groundedFields: 6, totalFields: 7` ⇒ only 7 of 16 candidates survived the ground stage;
  9 were dropped, merchant among them (absent from the final 7-field dump). `[FACT]`
- Final validation: `merchant_name` flagged `missing`. `[FACT]`
- **Conclusion: Branch A (AI never proposed it) is ruled out.** The model produced the value; the
  grounding stage killed it. `[FACT]`

Branch enumeration against the **current** grounding code (letters C/E below follow the
root-cause lettering used in this report):

- **A — AI never proposed it.** **Refuted.** `extract.fields: 16` proves the candidate existed.
  `[FACT]`
- **B — normalization removed it.** `coerce` for `string` just trims (`normalizer.ts:93`); merchant
  is dropped only if the model value were whitespace-only. Not applicable. `[INFERENCE]`
- **C — grounding rejected it as `"not found in source text"`** (`grounding.ts:154`). **Secondary
  possibility, not the leading one.** For the known candidate represented by the OCR evidence
  (`SuperPay`), the repository proof in Evidence Match Proof below establishes that normalized
  substring evidence **exists** in the document, so C cannot be the primary explanation. C remains
  only *hypothetically* possible for a different, non-persisted candidate value that happens not to
  be a normalized substring of the OCR (e.g. a hallucinated or translated merchant name).
  `[INFERENCE]` — exact candidate value not independently persisted.
- **D — relabel conflict.** The merchant evidence line has no label at all (`كن‎SuperPay‏` → no
  lexicon word) → verdict `neutral`, not `conflict` → not the cause. `[FACT]`
- **E — confidence below threshold (Pass 3).** **Primary confirmed branch.** Evidence is
  discoverable (see Evidence Match Proof), `labelFactor = 0.8` (label-less line), the OCR factor is
  low for the garbled header line, and the composed confidence falls below `MIN_CONFIDENCE = 0.3`
  → drop `"confidence below threshold (x.xx)"` (`grounding.ts:208-211`). See Confidence Trace.
  `[FACT]` for formula/mechanism; exact runtime components `[UNKNOWN]`.
- **F — entity cleaner removed it.** The cleaner never removes non-garbage grounded name values; it
  only trims edge digits and re-grounds (`entity-cleaner.ts:129-154`, `311-370`). Since merchant was
  already gone before `clean`, F did not act. `[FACT]` (chronology).
- **G — other.** `merchant_address`/`merchant_tax_id` are separate fields (killed by the tax keyword
  gate / no label); they do not explain merchant. No other mechanism exists in code. `[FACT]`

### Evidence Match Proof

For the merchant header line of the relevant OCR pass:

```
كن‎SuperPay‏   (newPre line 1, verbatim)
```

`normalizeText` (`src/lib/pipeline/ocr.ts`) removes bidi/control marks and lowercases, so:

```
كن‎SuperPay‏  →  كنsuperpay
SuperPay      →  superpay
```

And:

```
كنsuperpay .includes( superpay )  ===  true
```

Therefore the ordinary OCR-only `findEvidence` path (`grounding.ts:246`, `normalizeText(line.text)
.includes(norm)`) **can find the merchant span** on that line; the span resolution
(`findWordSpan`, `grounding.ts:345-369`) operates on normalized word tokens and finds the `SuperPay`
word within `كن‎SuperPay‏` (one glued token normalizes to `كنsuperpay`, containing `superpay`).

Implications:
- `"not found in source text"` (C) is **not the leading explanation** for the known candidate —
  the normalized substring evidence exists in the document. `[FACT]` (normalization behavior) +
  `[FACT]` (substring relation) + `[FACT]` (code path).
- The same holds under the user's merged runtime line variant: `60 SuperPay eX 15468 ...`
  normalized still contains `superpay`. The conclusion is robust to both line shapes. `[FACT]`
- C is not *absolutely* impossible only because the exact candidate value is not independently
  persisted — but for the known SuperPay candidate the proof above holds. Do not overstate
  uncertainty: the primary confirmed branch is **E**. `[FACT]` (primary) / `[INFERENCE]` (residual
  C caveat).

### Confidence Trace

The composed confidence formula (Pass 2, `grounding.ts:180-193`):

```
confidence = aiConf × ocrFactor × labelFactor
```

For the merchant line:

- **AI confidence (`aiConf`):** the model's per-field confidence, preserved from the AI response
  (`normalizer.ts:41-45`). **Not persisted in any committed artifact** for a dropped field → marked
  **`[UNKNOWN]`**.
- **OCR factor (`ocrFactor`):** mean word confidence over the evidence span
  (`grounding.ts:316-332`, `523-533`). **Known low** for the merchant/header line: the `SuperPay`
  word sits on a bidi-garbled, low-quality thermal-photo line (pageConf 0.64–0.74 across passes,
  `ocr-level.json`), every surviving header field in the committed run carried `ocr_confidence_low`,
  and the structurally adjacent `receipt_number` evidence span had conf 0.487. Exact per-word value
  for the `SuperPay` span **`[UNKNOWN]`** (not persisted).
- **Label factor (`labelFactor`):** **0.8, known.** The line is label-less — it contains no merchant
  lexicon word (`label-lexicon.ts:99-101`) — so `labelConfidenceFactor` returns `LABEL_NEUTRAL_FACTOR
  = 0.8` (`grounding.ts:536-543`).
- **Threshold:** `MIN_CONFIDENCE = 0.3` (`grounding.ts:35`, applied at `:208-211`).

With `aiConf ≤ 1`, `ocrFactor` low (≈0.3–0.5 range by surrounding evidence), and `0.8` label-neutral
penalty, the product falls below 0.3 (e.g. `0.7 × 0.45 × 0.8 = 0.25`; `0.5 × 0.6 × 0.8 = 0.24`).
The field is dropped with reason `confidence below threshold (x.xx)`. `[FACT]` for formula, known low
OCR confidence, known neutral/label-less penalty, and known threshold; **exact component values
`[UNKNOWN]`** (not stored) — do not fabricate them.

---

## Recovery / Retry

**Gate (fact):** the cross-provider retry (`stages/recover.ts:111-127`) accepts exactly two drop
reasons:

```
"not found in document"      → eligible
"empty value"                → eligible
```

It does **not** accept:

```
"confidence below threshold (…)"   → NOT eligible
"not found in source text"         → NOT eligible
```

`retryAttempted: false` is therefore the **expected** outcome for this failure — not an anomaly. It
matches both committed runs (`real-superpay.new` recover trace: `retryAttempted: false`). `[FACT]`

**Consequence:** once grounding drops Merchant specifically for low confidence, the current
recovery/retry architecture has **no path to rescue it**:
- the deterministic FIND arm needs a label word that does not exist anywhere in the document
  (`verify-or-find.ts:178-198`, `label-lexicon.ts:99-101`) → zero candidates;
- the cross-provider retry arm is gated off by the drop-reason string set above → never fires.

The recovery stage does not cause the failure; it is structurally incapable of fixing it. `[FACT]`

---

## M12 Assessment

**M12 is NOT the root cause.**

M12 (verify-or-find) does not solve this specific merchant failure because:

- Merchant is a **string field**; the M12 `verifyEvidence` arm only covers separator-free reference
  numbers and alternative ISO date layouts (`verify-or-find.ts:65-84`), and returns `[]` for
  merchant. `[FACT]`
- The merchant evidence is **already discoverable** by ordinary normalized substring matching
  (Evidence Match Proof) — no verification arm is needed to find it. `[FACT]`
- The failure occurs **after evidence discovery**, during confidence gating (Confidence Trace) —
  outside the scope of any verify/find arm. `[FACT]`
- M12's verification arms target derived date/reference cases and required-field discovery, **not
  low-confidence merchant confirmation**. `[FACT]`

M12 successfully addressed its intended bottlenecks (grounded reference numbers/dates, label-driven
recovery of unresolved required fields). The SuperPay merchant failure exposes a **different
architectural gap** (see Architectural Gap), not a defect in M12. `[FACT]` (scope) / `[INFERENCE]`
(success attribution).

---

## Persistence / Observability

`droppedFields` and per-field grounding reasons are **not persisted** in the production extraction
record. `[FACT]`

Current persistence (`service.ts:190-208`; `trace.ts:53-121` records stage counts only):

- `fields_json` — surviving fields only (a dropped field never appears)
- `validation_json` — `{ ok, missing }` only
- `confidence_json` — overall + signals + summary
- `trace_json` — per-stage summaries, no `droppedFields`
- `ocr_json` — the structured OCR
- `source_text` — the OCR-derived text

Therefore the production UI cannot directly expose the exact drop reason (e.g.
`confidence below threshold (0.25)`) without additional observability. This is why the merchant kill
was invisible in production and required this repo-level forensic trace. `[FACT]`

---

## Part 3 — `line_items` lifecycle (`oe a : il`)

OCR ground truth (newPre): the "line items" block is actually the *footer/signature* region:
`‎Hostinger;Description‏;)0123456788(`, `‎oe   a           : il‏`, `‎x PURCHASE‏`,
`المبلغ ‎welkall‏ : 68.38`. There are **no real product rows** on this receipt (it is a payment
confirmation). `[FACT]`

1. Model reads these three lines and emits `line_items` with descriptions matching the OCR lines and
   `quantity/unit_price/amount = null` (nothing numeric exists). Committed dump confirms
   `raw: ["‎Hostinger;Description‏;)0123456788(", "‎oe   a           : il‏", "‎x PURCHASE‏"]`. `[FACT]`
2. `ground` Pass 1: `looksLikeItemizedList` returns **true immediately** because `items.length >= 2`
   (`grounding.ts:565`) — the "3 items" test passes despite everything else failing, then the branch
   `continue`s so **no evidence is attached**. `[FACT]`
3. `clean`: `cleanLineItems` suppresses:
   - `‎Hostinger;Description‏;)0123456788(` → `isNoiseFragment` true (oversized letter+digit token,
     `text-quality.ts:59-82`) → removed. `[FACT]`
   - `‎x PURCHASE‏` → `isGenericItemDescription` true (`/purchase/`, `grounding.ts:49-59`) →
     removed. `[FACT]`
   - `‎oe   a           : il‏` → has letters, not generic, not noise, and *is* grounded to its single
     OCR line via `appearsInOcr` (`entity-cleaner.ts:482-504`) → **kept**. `[FACT]`
4. Final result: `[{ amount: null, quantity: null, unit_price: null, description: "oe a : il" }]` —
   **exactly** the user's production value. `[FACT]`
5. Confidence: no evidence → reasons `no_direct_evidence` + `label_not_matched`, confidence
   `0.85 × ocrFactor × 0.8 × 0.9` (committed value 0.391). `[FACT]`

**Verdict:** `oe a : il` is verbatim OCR line 12, the single survivor of the entity cleaner's
generic suppression. The user-visible garbage is **faithful OCR**, not model hallucination. `[FACT]`
The design gap: `looksLikeItemizedList` short-circuits at "2+ items" and `line_items` is exempt from
evidence, so three garbage rows pass the gate.

---

## Part 4 — `notes` reasons

- `ground` Pass 1 notes branch (`grounding.ts:110-116`): only `isNoiseFragment` is checked, then
  `continue` — **notes never receives evidence**. `[FACT]`
- Therefore `notes` always has `reasons: ["no_direct_evidence", "label_not_matched"]`
  (`grounding.ts:546-556`) and the UI string "Value does not directly appear in the OCR text and was
  inferred rather than read verbatim" (`i18n/uncertainty.ts:18-19`, `locales/en.json:95`). `[FACT]`
- The user's `notes = "عمليه ناجحه"` (OCR line 8 reads `عمليةناجحة`): `normalizeText` of the OCR
  line is `عمليةناجحه` (ة→ه) which does **not** contain `عمليه ناجحه` (spacing + spelling) →
  `appearsInOcr` would fail → the entity cleaner would drop it as "not grounded to a single OCR
  line" (`entity-cleaner.ts:217-227`). The user **saw** the value, so in the production run the
  runtime OCR must have carried a closer spelling (e.g. with a space), making the cleaner keep it.
  `[UNKNOWN]` on the exact runtime OCR spelling; the surviving value with `no_direct_evidence` is
  guaranteed by the exemption in `grounding.ts:110-116` regardless. `[FACT]`
- In the committed run, notes was dropped (absent from the 7-field dump) — the model's notes value
  there was noise (16 non-null fields, notes not among the 7 survivors). `[INFERENCE]`

**Verdict:** the "inferred" flag on notes is **structural and unconditional**: a free-text field that
bypasses evidence attachment always reports `no_direct_evidence`. It is not a symptom of this
specific document. `[FACT]`

---

## Part 5 — `receipt_date` at ~47%

- Committed run: value `2026-07-02`, raw `تاريخ انلوقت : 02-07-202618:30:12`, confidence **0.746**,
  reasons `[]`, evidence conf 0.829. The label word `تاريخ` matched → `labelFactor 1`, and the OCR
  word confidence was high → grounded with solid confidence. `[FACT]`
- The user's run: `2026-07-02` at **~47%**. The only way confidence falls to ~0.47 given
  `aiConf·ocrFactor·labelFactor·1`:
  - `0.85 × 0.69 × 0.8 ≈ 0.47` ⇒ `labelFactor = 0.8` (`label_not_matched`) plus a moderate OCR
    factor. `[INFERENCE]`
  - i.e. in the production run the date evidence line lost its `تاريخ`/`الوقت`/`التوقيت` label —
    consistent with the OCR misreading the label as `انلوقت` (not a lexicon word) or the merged
    runtime line burying it — and/or the date's word confidence dropped. `[INFERENCE]`
  - Note the **year trap**: `newRaw` and `old` both read `2028` (OCR digit misread); only `newPre`
    reads `2026`. The model normalizes to `YYYY-MM-DD` (`normalizer.ts:120-145`), and grounding
    anchors the ISO form against derived variants (`dd-mm-yyyy`) or M12 ISO-order variants
    (`verify-or-find.ts:101-126`). The committed run grounded `2026-07-02` correctly. The user's run
    also produced `2026-07-02` — good. `[FACT]`
- **Why 47% and not lower:** the date is one of the few fields whose *label* usually matches; when
  the label disappears, the floor is the 0.8 label-neutral factor, not zero. `[INFERENCE]`

**Verdict:** the 47% is `aiConf × ocrFactor × 0.8` — the label-neutral penalty applied because the
date's OCR label line was garbled/missed in the production pass. The value itself is correct
(`2026-07-02`). `[INFERENCE]` (mechanism `[FACT]`, exact factors `[UNKNOWN]`).

---

## Impact Ranking (P0–P4)

| Pri | Failure | Mechanism (exact) | Documents | Evidence | Confidence |
|-----|---------|-------------------|-----------|----------|-----------|
| **P0** | `merchant_name` missing on label-less, low-OCR-confidence lines | **Primary: confidence threshold after successful evidence discovery** — evidence IS findable (normalized substring, Evidence Match Proof) but `aiConf · ocrFactor(low) · 0.8(label-less) < 0.3` → drop `confidence below threshold` (`grounding.ts:208-211`); residual `:154` path only if the candidate value is not a normalized substring. Recovery cannot help (no label word; retry gate excludes the drop reason). | every low-quality label-less header (SuperPay, thermal receipts, logos rendered as words) | pipeline-level `new` trace + dump (`extract.fields:16` proves candidate; `ground` drops it); ocr-level (SuperPay present, 6/6) | high — branch E primary confirmed; exact runtime components UNKNOWN |
| **P0** | `line_items` accepts footer garbage (`oe a : il`) | `looksLikeItemizedList` short-circuit `items.length>=2` (`grounding.ts:565`) + evidence exemption (`:103-109`) + cleaner keeps the one grounded-but-empty fragment (`entity-cleaner.ts:263-273`) | receipts whose "items" region is actually a signature/footer | committed dump (exact same value) | high |
| **P1** | `notes` always "inferred" | unconditional `continue` skips evidence (`grounding.ts:110-116`) → permanent `no_direct_evidence` | every document with notes | code + i18n mapping | certain |
| **P1** | recovery cannot rescue the commonest drops | retry gated to `"not found in document"/"empty value"` (`stages/recover.ts:121-122`); `"not found in source text"` and `"confidence below threshold"` excluded | any required field dropped in Pass 1/3 (incl. this merchant) | code + committed `retryAttempted: false` | certain |
| **P2** | `receipt_date` ~47% on label-garbled lines | `labelFactor 0.8` (`grounding.ts:536-543`) when `تاريخ`/`الوقت` misread (`انلوقت`) | Arabic RTL receipts with weak OCR labels | user run + committed 0.746 with intact label | medium |
| **P2** | diagnostic blindness | `droppedFields` never persisted (`trace.ts:53-121`, `service.ts:190-208`), so kill branches are invisible in production | all docs | code + trace shape | certain |
| **P3** | OCR year misread `2028` vs `2026` | upstream OCR (`newRaw`/`old`); pipeline preserves the *wrong* verbatim year when grounded (old run kept `2028-07-02`) — value is correct only when OCR reads right (`newPre`) | low-quality dates | ocr-level old/newRaw vs newPre | certain (mechanism) |
| **P3** | classifier noise (AI "invoice" overruled) | cosmetic; overruled correctly (`classifier.ts:61-79`) | any payment slip | trace reasons | certain (benign) |
| **P4** | UX noise: `label_not_matched` on every unlabeled value | label-neutral 0.8 factor is a floor, but surfaces as scary reasons | all docs | committed dump | certain (intended) |

---

## Part 8 — Test-gap analysis (why 650/650 pass)

The suite (650 passing) is built around **unit tests with synthetic/golden documents**, the exact
M11/M12 contract tests, and `tests/live/*` trace tools. Gaps:

- **No end-to-end real-document fixture that asserts *merchant on a label-less low-confidence line***
  survives grounding. Existing fixtures either include the label or high-confidence words, so
  `label_not_matched`→0.8→threshold-drop never triggers. `[INFERENCE]` (no such fixture found in
  the test tree this session).
- **No assertion that `line_items` must contain a *grounded, priced* row** — the committed dump
  proves garbage passes and no test pins it. `[FACT]`
- **No regression test that `notes` carries evidence or that `no_direct_evidence` is *only* for
  genuinely unverifiable values** — the exemption makes the reason unconditional, and tests that
  assert reasons were written to match the exemption. `[INFERENCE]`
- **No test for the recovery gate string set** — `"not found in source text"` vs
  `"not found in document"` mismatch is untested; a field dropped in Pass 1 silently skips retry.
  `[FACT]` (code) — no test observed this session.
- **Live tools exist but are gated on real providers/env** (`tests/live/trace-extraction-e2e.ts`,
  `verify-milestone.ts`) and were not run (no env access this session). They are the correct
  instrument for the next pass. `[FACT]`

Net: the suite validates *machinery* (normalize, ground, clean, recover, confidence each in
isolation) but not *real-world recovery behavior* on the failing document class. A single committed
end-to-end trace over `benchmarks/corpus/real-superpay.jpg` with a pinned stub model would have
caught the merchant drop at M11/M12 time. `[INFERENCE]`

---

## Architectural Gap

Reconnaissance conclusion only — not an implementation.

The missing capability is **not another evidence-search tier**. The evidence is already findable for
this case (normalized substring match proves it). The missing capability is a **safe mechanism for
confirming low-confidence, label-less structural/header values without treating low OCR confidence as
equivalent to incorrect content.**

Potential architectural direction (do not prescribe the exact implementation):

- preserve strict grounding — no fuzzy string matching, nothing invented;
- use the **existing** layout/geometry/reading-order evidence (M10/M11 layers: region type, reading
  order, block membership, layout-derived confidence) to **independently confirm a discovered span**,
  rather than relying solely on word-level OCR confidence;
- reconsider whether a label-less structural/header line should **always** receive the same neutral
  label penalty (`0.8`), when geometry already places the value in the field's expected region;
- improve observability so **every dropped field has an explicit persisted reason**, so the next
  forensic cycle is data-driven rather than code-driven.

The gap is in grounding-confidence policy and observability — not in evidence search. `[FACT]`
(evidence is findable) / `[INFERENCE]` (direction).

---

## Recommended Next Step

Observability first, then a justification-driven milestone decision — both out of scope for this
read-only report:

1. **Persist the drop reasons:** serialize `droppedFields` (with per-field reasons like
   `confidence below threshold (0.25)`) into `trace_json` (`service.ts:190-208` +
   `trace.ts:53-121`). This converts the next forensic cycle from code-tracing to reading the DB
   row, and lets production UI explain *why* a field is missing.
2. **Re-run the committed end-to-end trace** over `benchmarks/corpus/real-superpay.jpg` with a
   pinned stub model returning merchant `"SuperPay"`, to confirm the confidence-drop numerically on
   current code (this session's evidence is static + committed-artifact based; exact runtime
   components remain `[UNKNOWN]`).
3. Only then evaluate the Architectural Gap direction (geometry-assisted confirmation for label-less
   header/name categories) under the project's own milestone process — this report does not name or
   authorize a milestone.

---

## Unknowns / Limitations

1. Exact drop reason for the production run (`droppedFields` is not persisted) — the repo proof
   establishes branch E as primary (Evidence Match Proof + Confidence Trace) but the literal runtime
   reason string is not stored. `[UNKNOWN]`
2. The model's per-field confidence (`aiConf`) for merchant in the failing run — not persisted.
   `[UNKNOWN]`
3. The per-word OCR confidence of the `SuperPay` span in the runtime pass — not persisted; inferred
   low from surrounding committed evidence (pageConf 0.64–0.74, `ocr_confidence_low` on header
   fields, receipt_number evidence conf 0.487). `[UNKNOWN]` (exact value) / `[INFERENCE]` (low).
4. Whether the production OCR genuinely produced the single merged header line
   (`60 SuperPay eX 15468 ...`) — conclusion robust to both variants. `[UNKNOWN]`
5. The exact AI raw response JSON for the production run (not stored in repo). `[UNKNOWN]`
6. Whether the M11 layout path succeeded on the runtime image (`isLayoutAvailable`) — either way the
   OCR-only fallback keeps the same evidence-match behavior for this line. `[UNKNOWN]`
7. Residual C caveat: if a *different* merchant candidate value (not a normalized substring of the
   OCR) existed at runtime, `"not found in source text"` could fire instead — secondary, unobserved,
   and contradicted by the substring proof for the known SuperPay candidate. `[UNKNOWN]`
