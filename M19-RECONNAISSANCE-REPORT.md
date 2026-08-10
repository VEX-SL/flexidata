# M19 — Reconnaissance: Dynamic Field Discovery

**Status:** ⚠️ ANALYSIS COMPLETE — report only, zero production changes
**Milestone:** M19 (continuation of M18; M13–M17 closed invariants preserved)
**Head commit:** `2a3e5a1` — `M13–M16` working-tree changes remain **uncommitted**

> **Executive one-liner:** Dynamic field discovery is **architecturally possible without
> touching the M13–M17 safety invariants**, but it is **not a single-schema change** — it is a
> bounded set of ~6 interlocked contract changes across the AI contract, grounding, recovery,
> persistence, export, and the PATCH/rebuild surface. Every one of those changes is localized,
> additive, and safe for legacy profiles. None of them requires weakening grounding,
> evidence, confidence, or validation.

---

## 1. Status

- **Type:** Read-only forensic architecture reconnaissance (no code, no tests, no config,
  no prompt/schema/OCR/threshold/safety-rule changes).
- **Deliverable:** this report only.
- **Files modified by this milestone:** none except this report (verified — see §24).
- **M18 verdict re-confirmed:** the "dynamic schema variable" alone cannot reach the target
  architecture; three hard blockers identified in M18 were all re-verified in M19 and each has
  a concrete, generic replacement (see §§4, 6, 11–13).

## 2. Objective

Determine exactly what must change to support **genuine dynamic field discovery**: the AI
discovers fields/values itself (label + value + type + evidence), with **no predefined field
list at the contract boundary** — while keeping grounding deterministic, evidence-based, and
M13–M17 safe.

Target architecture:

```
Document → OCR/Parser → Raw structured document text
         → AI field discovery (schema-free)
         → Generic grounding → Generic evidence → Generic confidence
         → Generic validation → Persistence / Export
```

Every section below marks each claim **PROVEN** (file:line) / **INFERRED** / **UNKNOWN**.

## 3. Current Architecture

**PROVEN.** The pipeline is profile-driven end-to-end:

- `parseFileBufferDetailed` (file-parser.ts:43) → `runPipeline` (defaults.ts:21) →
  `Pipeline.run` (orchestrator.ts:23-54, `ocr: input.ocr ?? buildOcrDocument(sourceText)`).
- Stages execute in fixed order — classify → extract → ground → clean → recover → validate →
  confidence (stages/index.ts:15-27).
- **Classify** — closed set of exactly 5 profile ids:
  `KNOWN_TYPES = ["invoice","receipt","resume","contract","unknown"]` (classifier.ts:10-16).
  AI-first with rule validation; `classifyStage` honors `ctx.input.profileType` (pinned).
- **Extract** — the AI contract is rendered from `profile.promptTemplate` +
  `OUTPUT_CONTRACT` (prompt-builder.ts:11-25). The schema is injected verbatim:
  `const schemaJson = JSON.stringify(profile.schema)` (prompt-builder.ts:15).
- **Normalize** — `normalizeFields` iterates **only** `profile.schema.fields`; any AI key not in
  the schema is silently discarded (normalizer.ts:31-32). Type coercion is per-field
  `field.type` (normalizer.ts:74-100), with enum values restricted to the allowed set
  (normalizer.ts:156-164).
- **Ground** — three passes (evidence/label verdict/confidence) over `profile.schema.fields`
  (grounding.ts:84); hardcoded keyed semantic gates (§6).
- **Clean** — `entity-cleaner.ts` iterates schema fields; `isNameField` is key-based
  (`key === "name" || key.endsWith("_name")`, entity-cleaner.ts:195-196); notes/text noise
  gates (entity-cleaner.ts:181, grounding.ts:110-123).
- **Recover** — required-only FIND pass (recovery.ts:59-62); retry gating; cross-provider retry.
- **Validate** — rules from `profile.validationRules`, plus a hardcoded `total_amount`
  cross-field reconciliation rule (validator.ts:119-135) and unknown-rule guard
  (validator.ts:137-139).
- **Confidence** — multi-signal engine (`computeConfidence`, confidence.ts:24-57) with fixed
  signal weights (confidence.ts:167-178); `crossCheck` and `required` are schema-driven signals
  (confidence.ts:71-77, 107-118, 121-124).
- **Persist** — `serializeFields` (service.ts:645-649) writes `{key,value,raw,confidence,source,
  status,evidence,...}`; rebuild is profile-anchored (service.ts:602-643). `updateFields`
  rejects any key outside `profile.schema.fields` (service.ts:349-356).
- **Export** — JSON from `extraction.fields` (exporter.ts:57-102); CSV columns from
  `profile.exportConfig.csvColumns` falling back to `Object.keys(cleanFields)`
  (exporter.ts:110-118).
- **Fallback profile** ("unknown") carries 6 predefined generic fields (fallback.ts:8-30) and a
  hardcoded csvColumns list (fallback.ts:61).

**Consequence (PROVEN):** every downstream stage re-derives field meaning from the schema.
"Dynamic fields" cannot exist because they are filtered out at the very first boundary
(normalizer.ts:31-32) before grounding/confidence/persistence ever see them.

## 4. AI Contract

### 4.1 Current contract (PROVEN)

- Input = `profile.promptTemplate` + `{{schema}}` (`JSON.stringify(profile.schema)`,
  prompt-builder.ts:15) + `{{document}}` (truncated to 60 000 chars, prompt-builder.ts:3,16) +
  `OUTPUT_CONTRACT`.
- Output = `{ "data": { <schemaKey>: { raw, value, confidence, evidence } } }`
  (prompt-builder.ts:32-40). The contract states **"The keys of 'data' are the schema field
  keys"** (prompt-builder.ts:33).
- JSON is parsed by `extractJSON` (fence-stripping, outer-bracket repair, trailing-comma repair,
  last-balanced-`}` truncation) and then filtered by schema in `normalizeFields`
  (normalizer.ts:31-32).

### 4.2 What must change (INFERRED, bounded)

Two sides of the same contract:

1. **Prompt side:** replace the fixed `{{schema}}`-keyed contract with a schema-free discovery
   instruction: "list every field you can justify from the document text, each with a canonical
   key, human label, semantic category, type, value, raw quote, and evidence." This is a
   **prompt-template + OUTPUT_CONTRACT change only** — it does not touch grounding logic.
2. **Response side:** accept a heterogeneous field set. The response shape stays
   `{ data: { key: { raw, value, confidence, evidence, ... } } }` but keys are no longer
   constrained to a schema — they are validated generically (§6).

### 4.3 Boundary guarantees that stay (PROVEN)

- Every value must still carry verbatim `raw` + `evidence` quote (prompt-builder.ts:37-40) —
  the grounding preconditions remain identical.
- Confidence remains per-field and optional (prompt-builder.ts:39).
- `extractJSON` repair is schema-agnostic already (INFERRED from its fence/JSON mechanics) —
  no change needed for free-form keys.

## 5. Dynamic Field Representation

**PROVEN — the key/type/label trio must be carried by the AI, not the profile.**

- Current representation is `FieldSchema` keyed by `profile.schema.fields` (types.ts), consumed
  by `normalizer.ts:31-32`, `grounding.ts:84`, `validator.ts:23,33`, `recovery.ts:59`,
  `exporter.ts:110`, `service.ts:349`, entity-cleaner.ts:83.
- For dynamic discovery the AI must emit, per discovered field, at minimum:
  `key` (canonical id), `label` (human text), `type` (string|number|currency|date|boolean|
  enum|array|object|text), `value`, `raw`, `evidence`, `confidence`. This is a **superset of
  FieldSchema**; existing types stay valid (normalizer.ts:74-100 coercion works unchanged).

### 5.1 Generic field registry (INFERRED — recommended design)

A "discovered field" is only meaningful if the semantic-lexicon/label-group machinery
(§6, §7) can classify it. Today `labelGroupForField` has a **key-based default map**
(label-lexicon.ts:120-140, e.g. `key === "total_amount"` → `"total"`) plus a `group`
override per FieldSchema. A dynamic field therefore needs a **semantic category hint**
(`group`) emitted by the model or inferred from the label by a generic lexicon matcher.
This is an additive fallback — legacy schema fields keep their explicit groups.

## 6. Grounding

### 6.1 Behavior table (PROVEN)

| Behavior | Schema-free possible? | Current dependency | Evidence |
|---|---|---|---|
| Value must appear in document | ✅ Yes (already schema-free) | value-match on OCR spans | grounding.ts:125-139 |
| Derived variants (dates/amounts reformatted) | ✅ Yes | `derivedVariants` | grounding.ts (date/derived path) |
| Label verification (never relabel) | ✅ Yes | `labelVerdict` via `labelGroupForField` + `detectLabelGroup` | grounding.ts:514-525 |
| Composed confidence (ai × OCR × label) | ✅ Yes | per-field, schema-independent | grounding.ts:529-560 |
| Currency stated in document | ⚠️ Hardcoded key | `field.key === "currency"` + `CURRENCY_MARKER` | grounding.ts:89-95, :43-44 |
| Tax-ID anchors to tax-labeled line | ⚠️ Hardcoded key suffix | `field.key.endsWith("_tax_id")` + `TAX_KEYWORD` | grounding.ts:96-102, :46-47 |
| No phantom line items | ⚠️ Hardcoded key | `field.key === "line_items"` + `looksLikeItemizedList` | grounding.ts:103-109 |
| No OCR garbage in notes | ⚠️ Hardcoded key | `field.key === "notes"` + `isNoiseFragment` | grounding.ts:110-118, :119-123 |
| `total_amount` reconciliation | ⚠️ Hardcoded key | validator.ts:119-135 | §10 |
| Name-field cleaning | ⚠️ Key heuristic | entity-cleaner.ts:195-196 (`key==="name" || endsWith("_name")`) | §10 |
| Recover required fields | ❌ Schema-anchored | `profile.schema.fields` + `field.required` | recovery.ts:59-62 |

### 6.2 The generic replacement (INFERRED)

The four ⚠️ gates in grounding are all **"universal semantic checks"** — the code comment itself
says "never vendor-keyed" (grounding.ts:88). They are keyed by *hardcoded strings*, not by
schema shape. The generic form already exists conceptually:

- Replace `field.key === "currency"` with **a semantic category check** —
  `labelGroupForField(field) === "currency"` (group already exists in label-lexicon).
- Replace `field.key.endsWith("_tax_id")` with `group === "tax"` — the tax group already exists
  (verify-or-find.ts:374-378 treats group `"tax"` as reference; label-lexicon has the tax group).
- Replace `field.key === "line_items"` with `field.type === "array"` + itemized-list shape test.
- Replace `field.key === "notes"` with `field.type === "text"` noise gate
  (grounding.ts:119-123 already applies the noise test to **every** `type:"text"` field — notes
  is subsumed).

**No gate weakens:** every replacement keeps the same predicate, just keyed by semantic category
or type instead of a hardcoded string. M13–M17 behavior for existing profiles is byte-identical.

### 6.3 Proven constraints on grounding design

- Grounding iterates the schema (grounding.ts:84) — for dynamic mode this iteration must be
  replaced by iteration over the **model-discovered field set** (INFERRED), which is a
  mechanical swap (the body is schema-free; only the loop source changes).
- `line_items` grounding is evidence-integrity-specific (grounding.ts:167-177); the generic
  array path must retain per-item evidence to preserve M16 (line items need grounded
  descriptions, no phantoms).

## 7. Evidence

**PROVEN — the evidence system is already generic.** This is the strongest "no-change-needed"
section.

- `FieldEvidence` shape `{ quote, lineIndex, role, context, confidence }` (types.ts) is
  schema-free — used identically by OCR search, FIND recovery, and layout-aware providers.
- OCR-only evidence search (`findEvidence`) operates on lines, not schema keys.
- Layout-aware ladder: region → neighbors → block → page → document with
  `maxSpanChars: 120` and a deterministic WeakMap cache (layout-aware-evidence.ts:126+;
  INFERRED for the ladder internals from prior reads — see §21 verification note).
- Recovery evidence: `labelWords` anchors on the **full label phrase or category lexicon**
  (verify-or-find.ts:206-217) — never a generic token (M17 fix). Same-line value rule:
  `textCandidates`/`valueAfterLabel` (verify-or-find.ts:339-372). Reference fields require an
  identifier-shaped reading (verify-or-find.ts:374-388).
- Label lexicon (`detectLabelGroup`) matches Arabic + English text generically (INFERRED —
  lexicon is text-based, not key-based; the key-based map at label-lexicon.ts:120-140 is only a
  default *fallback* for fields that declare no explicit group).

**Gap (INFERRED):** in dynamic mode the evidence for a model-discovered key is *self-declared*
(the AI provides the quote). The generic contract must therefore demand that **every discovered
field carries an evidence quote** (it already does — prompt-builder.ts:37-40), and grounding must
**verify the quote resolves to a real OCR line** — which is exactly what `findEvidence` does
today. No new mechanism needed.

## 8. Confidence

**PROVEN — the confidence engine is schema-free at the signal level, with two schema-coupled knobs.**

| Signal | Schema coupling | Evidence |
|---|---|---|
| Validation | via `validation.results` (profile rules) | confidence.ts:60-68, §10 |
| Cross-field consistency | **`field.crossCheck` flag on schema** | confidence.ts:71-77 |
| OCR quality | none (lines/words/page) | confidence.ts:84-104 |
| Extraction | **required fields weighted 2×** | confidence.ts:107-118 |
| Missing required | **`validation.missing` (profile `required`)** | confidence.ts:121-124, validator.ts:33-35 |
| Evidence grounding | none | confidence.ts:127-146 |
| Uncertainty | none (status/reasons) | confidence.ts:149-165 |
| Model confidence | none (optional) | confidence.ts:38-40 |
| Weights | none (fixed) | confidence.ts:167-178 |

- Per-field penalty on failed validation: `VALIDATION_ADJUSTMENT = 0.85`
  (stages/confidence.ts:5, applied stages/confidence.ts:18-32).
- OCR confidence never diluted by unmeasured layout components (measured-mask fix in
  layout-aware-evidence.ts:90-120 — the **uncommitted M13 fix**).

**Gap (INFERRED):** the two ⚠️ signals (`crossCheck`, `required`-weighted) are profile metadata.
For dynamic discovery, "required" can default to **false** (no predeclared required set) and
"crossCheck" to **false** — the signals then contribute neutrally (cross.length===0 → 1.0,
confidence.ts:73; missing.length===0 → 1.0, confidence.ts:122). No engine change required; only
the *absence* of schema flags changes the score — which is honest (a schema-free extraction has
no declared required/cross-check contract).

## 9. Validation

**PROVEN — validation is the most profile-anchored stage, but the anchor is data, not code.**

- `validateExtraction` checks `profile.schema.fields` for presence + `field.required`
  (validator.ts:23-35), and runs `profile.validationRules` (per-profile).
- **Hardcoded special case:** `rule.key === "total_amount"` reconciliation against
  subtotal/tax/discount (validator.ts:119-135) — receipt+invoice only in practice
  (receipt.ts:90, invoice.ts:109 reference it; the rule is profile-declared, the math is not).
- Unknown rule keys are rejected (validator.ts:137-139).

**Design for generic validation (INFERRED):**
- Presence/required checks become optional in dynamic mode (no declared required set).
- Type checks already generic via normalizer `coerce` (normalizer.ts:74-100).
- The `total_amount` reconciliation is a **semantic rule**; generic form = "a numeric field whose
  label category is total reconciles against numeric fields whose categories are subtotal/tax/
  discount, when present." It never runs unless the AI *discovered* those categories.
- No validation rule ever invents or modifies a value (all rules are ok/fail + message) —
  so generic validation is safe by construction.

## 10. Recovery

**PROVEN — recovery is generic in mechanism, schema-anchored in trigger.**

- `recoverMissingFields` iterates `profile.schema.fields` and only fields with `required: true`
  (recovery.ts:59-62).
- FIND engine is fully generic: label phrase + category lexicon + type coerce + OCR spans,
  "No document type, vendor, or field key is special-cased" (recovery.ts:25; verify-or-find.ts).
- Retry gating: `groundFlaggedRecovery` + `extractWithAIRetry` re-pass; retry only when a
  required field is unresolved (stages/recover.ts:185-192; INFERRED for the exact gate details
  from stages/recover.ts).
- `total_amount`-specific reconciliation validation (§9) can flag but never changes values.

**Design for dynamic mode (INFERRED):** `required` becomes a model-discovered attribute
("is this field critical to the document?"), recovered with the same FIND engine — or simply
absent (no recovery). The engine itself is unchanged; only the field list source changes.

## 11. Persistence

**PROVEN — persistence is schema-anchored at write, rebuild, and edit.**

Write (`serializeFields`, service.ts:645-649): stores `{key,value,raw,confidence,source,status,
evidence,alternatives,reasons}` per field — **the stored shape is schema-free already**. The
DB row stores `fields_json`, `profile_type`, `profile_version` (service.ts:606,633-634).

Rebuild (`rebuildExtraction`, service.ts:602-643): re-hydrates each stored field against
`profile.schema.fields`; **a stored key absent from the schema is silently downgraded to an
untyped string** (`fieldSchema ?? { key: s.key, type: "string", label: s.key }`,
service.ts:608-610). This is the second hard blocker from M18 — persisted dynamic fields would
lose their type on read.

Edit (`updateFields`, service.ts:334-356): **rejects any override key not in
`profile.schema.fields`** (service.ts:349-356) — the third M18 blocker. `coerceValue` uses the
schema type (service.ts:364-365).

**Trace (INFERRED from the above — dynamic-field persistence must work end-to-end):**

| Step | Today | Dynamic mode |
|---|---|---|
| Write | `fields_json` = schema-free shape ✓ | unchanged ✓ |
| Read | `profile_type` + `fields_json` | ✓ needs to also persist the *discovered schema* or per-field type |
| Rebuild | schema lookup, untyped fallback (service.ts:608-610) | must use persisted per-field type |
| API | `GET /extractions/{id}` returns `job` (route.ts:21-23) | unchanged shape, dynamic keys flow through |
| Edit (PATCH) | schema-key whitelist (service.ts:349-356) | must accept dynamically-discovered keys |
| Validation/confidence recompute on edit | `rebuildExtraction` + same engines (service.ts:387-397) | works once rebuild is type-faithful |

**Required persistence change (INFERRED, additive):** store the discovered field schemas
alongside `fields_json` (a `schema_json` column or per-field `type`/`label` inside the DTO).
Legacy rows keep using the profile schema; the rebuild fallback (service.ts:608-610) already
degrades gracefully.

## 12. Export

**PROVEN — JSON export is already dynamic; CSV is the only schema-anchored export path.**

- JSON: iterates `extraction.fields` (the *kept* set, whatever its source), emits
  `{value, confidence, source, status, edited, verified, label, raw, evidence, reasons,
  alternatives}` per field, and never emits empty values (exporter.ts:57-102). **No schema
  reference anywhere in the JSON path.**
- CSV: columns from `profile.exportConfig.csvColumns`, falling back to
  `Object.keys(extraction.cleanFields)` (exporter.ts:110-118). The fallback is already dynamic;
  only profiles that declare `csvColumns` pin the header. Dynamic mode needs the fallback or a
  discovered-fields column list.

**Design (INFERRED):** keep JSON as-is; for CSV, drop `csvColumns` reliance when in dynamic
mode and always use the `cleanFields`/kept-fields ordering (which is what the fallback does
today). Legacy profiles unaffected.

## 13. Frontend / API

**PROVEN — the API/UI surface mirrors `FieldSchemaDTO`/`ProfileSchemaDTO`; unknown fields have
a graceful fallback, but the editing contract is schema-closed.**

- `GET /api/pipeline/extractions` (list) and `GET /extractions/{id}` (job) are schema-free
  (routes.ts:11-27, [id]/route.ts:10-27).
- `PATCH /extractions/{id}` filters to `{key:value}` primitives/arrays, then `updateFields`
  **rejects unknown keys** (service.ts:349-356).
- The documents page UI mirrors `FieldSchemaDTO`/`ProfileSchemaDTO`; `humanize` falls back for
  unknown keys; `parseDraft` uses typed coercion (page ui; INFERRED for exact line numbers —
  see §21).

**Design (INFERRED):** the frontend can render any `fields` object already (it renders per-field
from DTOs, not from a closed enum). Dynamic discovery needs only: (1) PATCH to accept
dynamically-discovered keys, (2) per-field `type`/`label` present in the job payload so the UI
can render/type-edit values — both satisfied by the §11 persistence change.

## 14. Safety Matrix

Invariants to preserve (M13–M17), their current mechanism, whether the mechanism depends on the
schema, and whether it can become generic:

| Invariant | Current mechanism | Schema dependency | Can become generic? |
|---|---|---|---|
| No invented values (grounded or dropped) | value/derived span match (grounding.ts:125-139) | none | ✅ already generic |
| Confidence never diluted by unmeasured components (M13) | measured-mask `combineConfidence` (layout-aware-evidence.ts:90-120) | none | ✅ already generic |
| Merchant-name guard (M13) | label/category-based evidence + drop path | none (category via lexicon) | ✅ |
| Tax-ID must anchor to tax-labeled line (M14) | `_tax_id` key gate + `TAX_KEYWORD` (grounding.ts:96-102) | **key suffix** | ✅ → semantic `group==="tax"` |
| Notes garbage gate + relabel veto (M15) | notes/text noise gate (grounding.ts:110-123) + `labelVerdict` conflict drop (grounding.ts:514-525, :176-177) | **`notes` key** + lexicon | ✅ notes subsumed by `type:"text"` noise gate; relabel veto is category-based |
| Line items need grounded descriptions, no phantoms (M16) | `line_items` key gate + per-item evidence (grounding.ts:103-109, :167-177; entity-cleaner.ts:105-113) | **`line_items` key** | ✅ → generic array-of-objects with per-item evidence |
| Phrase-anchored labels, same-line values (M17) | FIND phrase labels + same-line rule (verify-or-find.ts:206-217, :339-372) | none | ✅ already generic |
| No generic-token borrow (M17) | `labelWords` full-phrase only (verify-or-find.ts:206-217); reference shape check (verify-or-find.ts:374-388) | none | ✅ already generic |
| Values dropped when confidence below threshold | `post-processor.ts:50` | none (schema-independent constant) | ✅ |

**UNIVERSAL (schema-free today):** grounding evidence, label verdict, OCR-confidence
composition, noise/quality gates, FIND engine, JSON export, confidence engine internals.
**DOMAIN-SPECIFIC (hardcoded strings):** `currency`/`_tax_id`/`line_items`/`notes` keys in
grounding, `total_amount` math in validator, `name`/`_name` heuristic in entity-cleaner,
profile-`required` recovery trigger, `csvColumns` in exporter. Each has a ready generic
replacement (§6.2, §9, §10, §12). No invariant depends on the schema in a way that blocks
dynamic discovery.

## 15. Profile System

- **Profiles that must stay:** id, label, docTypes, promptTemplate, validationRules,
  exportConfig, version, registry (registry.ts; receipt/invoice/contract/resume/fallback).
- **Profile-coupled optional enhancements (INFERRED):** per-profile grounding thresholds or
  custom recovery rules are *optional conveniences*, not requirements. Dynamic mode can ignore
  them (defaults are generic constants — grounding.ts:35-41).
- **Required contracts (INFERRED):** (1) prompt side accepts a schema-free mode; (2) normalizer
  accepts schema-free key sets; (3) rebuild/PATCH/CSV accept dynamically-discovered keys.
  These are contract changes, not profile-file changes.

## 16. Dynamic Extraction Contract (conceptual JSON only)

What the model returns in dynamic mode (conceptual — NOT implemented):

```json
{
  "data": {
    "total_amount": {
      "raw": "1,234.50",
      "value": 1234.5,
      "confidence": 0.9,
      "evidence": "TOTAL: 1,234.50 SAR",
      "type": "currency",
      "label": "Total amount",
      "group": "total",
      "required": true
    },
    "beneficiary_name": {
      "raw": "AHMED ALI",
      "value": "AHMED ALI",
      "confidence": 0.85,
      "evidence": "Beneficiary: AHMED ALI",
      "type": "string",
      "label": "Beneficiary name",
      "group": "party"
    }
  }
}
```

Every entry keeps the existing `{raw, value, confidence, evidence}` envelope (so the grounding
preconditions are unchanged) and adds discoverability metadata (`type`, `label`, optional
`group`, optional `required`). All fields optional except the envelope + `type` + `label`.

## 17. OCR → AI Boundary

**PROVEN.** Input to extraction is `documentText` via `layoutReaderFor(ctx.ocr).documentText`
when layout is available, else raw `sourceText` (stages/extract.ts). OCR quality is preserved
through structured `OcrDocument` (per-word/per-line confidence, tesseract-main.ts:311-428;
bboxes via `getBoundingBox`). The AI contract (prompt-builder) is fed plain text — the boundary
is unchanged by dynamic discovery; the AI just gets a different instruction (discover fields)
over the same text. The grounding side re-resolves quotes to real OCR lines, so AI must quote
verbatim text (unchanged requirement, prompt-builder.ts:37-40).

## 18. AI Invented Value

**Risk:** the model returns a value not present in the document.
**Mitigation (PROVEN, unchanged):** strict grounding — a value that does not appear in the
source text (verbatim or derived variant) is dropped (`drops[field.key] = "not found in source
text"`, grounding.ts:156-157); composed confidence multiplies by OCR factor (grounding.ts:529-
560); low confidence fields are dropped (post-processor.ts:50). Dynamic mode keeps every one of
these checks — they are schema-free.

## 19. AI Invented Semantics

**Risk:** the model invents a *field* (a label/type) with no textual basis, e.g. a guessed
"tax_id" on a doc with no tax text.
**Mitigation (PROVEN + one INFERRED extension):**
- Semantic gates already exist generically: currency must be stated (`CURRENCY_MARKER`,
  grounding.ts:89-95), tax requires a tax-labeled line (`TAX_KEYWORD`, grounding.ts:96-102),
  itemized lists must look like lists (grounding.ts:103-109).
- A discovered field must still pass the **label verdict**: evidence context whose detected
  label group conflicts with the field's declared group → dropped ("value labeled for a
  different field", grounding.ts:176-177).
- **INFERRED extension:** a dynamic field with no evidence at all is dropped by the same
  grounding pass (evidence length 0 → no commitment). Invented semantics therefore die at the
  same place invented values die — grounding. No new safety mechanism required.

## 20. M13–M17 Compatibility

- **M13** (merchant_name drop + measured-mask confidence): unaffected — both are
  evidence/confidence mechanisms, schema-free (layout-aware-evidence.ts:90-120).
- **M14** (tax-ID anchors to tax-labeled line): the `_tax_id` key gate becomes a `group==="tax"`
  semantic gate (§6.2). Receipt/invoice fields declare explicit tax groups today (INFERRED), so
  behavior is identical; the hardcoded-key version stays as the legacy path until migration.
- **M15** (notes garbage + relabel veto): notes subsumed by the existing `type:"text"` noise
  gate (grounding.ts:119-123); relabel veto is already category-based (grounding.ts:514-525).
- **M16** (line-item grounding + phantom suppression): generic array-with-per-item-evidence
  keeps every evidence requirement; the `line_items` key gate becomes a generic array shape
  test.
- **M17** (phrase-anchored labels + same-line values + no generic-token borrow): fully generic
  today (verify-or-find.ts:206-217, :339-388) — zero changes needed.
- **Compatibility rule (INFERRED):** every replacement is *additive* — existing profiles keep
  hardcoded keys until they opt in; the generic path is engaged only when the profile declares
  a schema-free mode or a field uses semantic categories. No M13–M17 test can regress because
  the predicates are identical, only keyed differently.

## 21. Migration Boundary (legacy vs dynamic mode)

**INFERRED** (no migration exists — this is a boundary definition, not an implementation):

- **Legacy mode (default):** current behavior byte-for-byte. Profile schema is the contract;
  normalizer, grounding, recovery, PATCH, CSV all schema-anchored.
- **Dynamic mode (opt-in):** profile (or request flag) declares `dynamic: true`. Then:
  prompt renders schema-free; normalizer accepts discovered keys (with type/label from the
  model); grounding iterates the discovered set and applies semantic categories instead of
  hardcoded keys; required/crossCheck default false; recovery optional; persistence stores the
  discovered schema; PATCH/CSV accept discovered keys.
- **Coexistence is the key requirement:** a single profile could even mix — schema-declared
  fields get the legacy guarantee, discovered fields get the generic guarantee, both share the
  same grounding/evidence/confidence engines. Migration is per-profile and reversible.
- **Explicit non-goal (PROVEN from scope):** dynamic mode does not change OCR, preprocessing,
  thresholds, classifier ids, or any M13–M17 rule.

## 22. Final Verdict

| Option | Verdict |
|---|---|
| A. Keep schema-only extraction | ✗ Fails the objective — discovery is impossible at the boundary (normalizer.ts:31-32). |
| B. Dynamic schema *variable* (M18 idea) | ✗ Insufficient alone — the prompt variable exists but the contract is still keyed to schema field keys (prompt-builder.ts:33), and downstream stages are schema-anchored. |
| C. Dynamic field *discovery* end-to-end | ✅ **Chosen direction.** Bounded set of ~6 interlocked contract changes (§§4, 6, 11-13), all additive, none touching M13-M17 invariants. |
| D. Per-document arbitrary schema (user-defined) | ⚠️ Out of scope for discovery; requires a schema-persistence model beyond C. |
| E. Fully untyped "bags of values" | ✗ Violates typed evidence/coercion guarantees (normalizer.ts:74-100). |
| F. Two-mode (legacy + dynamic) coexistence | ✅ **Required as the migration boundary** (§21). |
| G. Defer discovery indefinitely | ⚠️ Possible but the architecture already contains every generic primitive needed; the only blockers are the 6 contract changes. |

**Verdict:** **C + F.** Dynamic field discovery is architecturally viable as an additive,
opt-in, two-mode contract change. It does not require weakening grounding, evidence,
confidence, validation, or any M13–M17 safety rule.

## 23. Proposed M20 Scope

**Recommended (all read/write decisions deferred to M20):**
1. **Normalizer:** accept a discovered field set (key+type+label+group) instead of schema-only
   iteration; keep `coerce` typed coercion and enum restriction unchanged.
2. **Grounding:** loop over discovered fields; replace the four hardcoded key gates
   (`currency`, `_tax_id`, `line_items`, `notes`) with semantic-category/type predicates —
   legacy path preserved behind the legacy flag.
3. **Recovery:** run the FIND engine over discovered `required` fields (defaults: none).
4. **Persistence:** store discovered field schemas with `fields_json`; make `rebuildExtraction`
   type-faithful; relax `updateFields` whitelist for dynamic jobs.
5. **Export:** keep JSON as-is; CSV uses kept-fields ordering (existing fallback).
6. **Prompt contract:** add a schema-free prompt template + discovered-field OUTPUT_CONTRACT
   variant (still requiring verbatim `raw` + `evidence`).
7. **Tests:** a schema-free E2E fixture (none exists today — tests/fixtures only carries
   receipt-ocr + arabic-ocr-corpus), plus regression run of all M13–M17 suites.
8. **Not in scope:** OCR changes, thresholds, classifier ids, safety-rule relaxation, real
   document-type profiles for the new modes.

## 24. Verification

**Files inspected (all PROVEN, line references cited above):**
- `src/lib/pipeline/{types,orchestrator,defaults,service,validator,classifier,confidence,
  exporter,dto,ai}.ts`
- `src/lib/pipeline/stages/{index,classify,extract,ground,clean,recover,validate,confidence}.ts`
- `src/lib/pipeline/extractor/{index,normalizer,grounding,verify-or-find,recovery,prompt-builder,
  json-repair,post-processor,label-lexicon,entity-cleaner}.ts` (entity-cleaner via
  `src/lib/pipeline/entity-cleaner.ts`)
- `src/lib/pipeline/profiles/{registry,receipt,invoice,contract,resume,fallback}.ts`
- `src/lib/extraction/layout-aware-evidence.ts`, `src/lib/extraction/layout-aware-reader.ts`
- `src/lib/file-parser.ts`, `src/lib/tesseract-main.ts`, `src/lib/ocr/{arabic,text-quality}.ts`
- `src/app/api/pipeline/{run,extractions,profiles}.ts`,
  `src/app/api/pipeline/extractions/[id]/route.ts`
- `src/app/(dashboard)/documents/page.tsx` (mirrors; exact line numbers not cited — marked
  INFERRED where referenced)
- M13/M14/M15/M16/M17/M18 reports

**Verification commands run:**
- `git status` — confirmed working-tree changes (M13–M16 layout/grounding/tests) uncommitted,
  head `2a3e5a1`.
- `git log --oneline -5` — confirmed head commit.
- Targeted reads/greps for every `PROVEN` citation; no build/test/lint run (read-only mandate).

**Git status:** branch `main`, up to date with `origin/main`. Modified (pre-existing, NOT from
this milestone): `src/lib/extraction/layout-aware-evidence.ts`, `src/lib/layout/*`,
`src/lib/pipeline/extractor/grounding.ts`, `tests/*`. Untracked (pre-existing): M13–M18 reports,
`SUPERPAY-FORENSIC-REPORT.md`, live-recon/test files.

**Files changed by this milestone:** only `M19-RECONNAISSANCE-REPORT.md` (this file).

---

**STOP** — M19 reconnaissance complete. No production code, tests, config, prompts, schemas,
OCR, thresholds, or safety rules were modified. Awaiting M20 scoping decision.
