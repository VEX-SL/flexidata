# M18 — Reconnaissance Report: Can FlexiData move from `predefined schema → field extraction → grounding` to `OCR representation → dynamic AI semantic structuring → generic evidence grounding`?

**Status:** README-ONLY architecture investigation. No production code, no tests,
no prompts, no schemas, no OCR, no thresholds, no label factors, no recovery
changes, and no vendor/receipt/field-specific logic was changed. Nothing was
committed or pushed. The deliverable is this report only.

**Marker legend for the target architecture checklists:**
- **✓** — the current system already provides a capability the target needs
  (safe to build on, unchanged).
- **⚠️** — a gap or blocker for the target (must be designed around; several are
  hard coupling points that the transition has to decouple first).

Every claim is tagged **PROVEN** (with `file:line` and/or trace reasoning),
**INFERRED**, or **UNKNOWN**.

Generated: 2026-08-10

---

## 1. Task and scope

The transition question, stated as a single sentence:

> Can FlexiData be re-shaped from **predefined schema → field extraction →
> grounding** (the current architecture) into **OCR representation → dynamic AI
> semantic structuring → generic evidence grounding** (the target), where the
> AI proposes arbitrary semantic fields per document and a generic grounding
> layer verifies each one against OCR evidence — without a predefined field
> schema at the contract boundary?

Scope of this report:
1. Map every place the profile schema is threaded through the runtime
   (`extract → ground → clean → recover → validate → confidence → DTO/export/UI`).
2. Prove where the schema is the *binding* AI contract and where it is just
   metadata.
3. Prove whether a "dynamic schema variable" alone would decouple the AI
   contract from grounding (M18's critical probe).
4. Inventory the deterministic, metadata-driven safety machinery that would
   have to survive a schema-less grounding pass (M13–M17 constraints).
5. Assess the target architecture against the **10 M18 safety invariants**
   (below) and state the gaps, with a target decomposition (README only).

The 10 M18 safety invariants that must survive any future design
(constraints of this milestone, restated):
1. Never invent a value that has no evidence.
2. Every committed value must be grounded in real OCR evidence.
3. Never relabel — a value on a line labeled for another field is not evidence
   for this field.
4. Never borrow unrelated OCR lines as values (M17's "MILK 3.50" class).
5. No OCR-confidence dilution (M13: layout `combineConfidence` must not
   understate a strong per-word OCR confidence).
6. Recovery never bypasses grounding — flagged FIND candidates must re-pass the
   same grounding ladder before commit.
7. Dynamic fields must not become dynamic safety rules — the universal
   semantic gates (currency/tax/line-items/notes) stay document-type agnostic.
8. A field name/key never proves a value — evidence decides.
9. AI evidence references are hints only — grounding stays deterministic and
   provider-independent.
10. Determinism: identical OCR + identical input always produce identical
    output; no provider-specific or order-dependent behavior.

---

## 2. Method

1. **Code-trace, not runtime instrumentation.** Unlike M13/M14/M15 (which ran
   live probes), M18 is constrained to a README-only investigation. All
   conclusions below come from reading the committed code paths and the
   uncommitted working-tree diffs (M13–M16 work). No instrumentation was added
   and nothing was executed that mutates state.
2. **Line-anchored audit.** Every runtime consumer of `profile.schema.fields`
   was located via search and read in full: `stages/extract.ts`,
   `extractor/{index,normalizer,post-processor,grounding,verify-or-find,recovery,label-lexicon,prompt-builder,ai-client}.ts`,
   `stages/{recover,clean,ground,validate,confidence}.ts`,
   `entity-cleaner.ts`, `validator.ts`, `confidence.ts`, `exporter.ts`,
   `service.ts`, `dto.ts`, `classifier.ts`, `profiles/*.ts`,
   `layout-aware-evidence.ts`, `layout-aware-selector.ts`, `ocr.ts`, `types.ts`,
   `app/api/pipeline/**`, and the UI page.
3. **Fixture experiment (Step 11) performed as a code trace.** A synthetic
   non-receipt document (bank statement) was traced through
   `classify → extract → normalize` to prove, from code, what a live probe
   would produce — no fixture file was created (constraint: no new tests).
4. **Verification of the audit itself:** `git status` shows only pre-existing
   M13–M16 working-tree changes and reports; this report adds one new file
   (`M18-RECONNAISSANCE-REPORT.md`) and nothing else. No `npm test`, no
   `tsc`, no lint run was required because no code changed.

---

## 3. The pipeline today — fixed stage wiring and where the schema is threaded

The runtime path is a single hardwired stage list:

- `runPipeline(input, opts)` (`src/lib/pipeline/defaults.ts:21-26`) →
  `createDefaultPipeline` (`defaults.ts:15-19`) → `new Pipeline(stages)`
  (`defaults.ts:18`) → `Pipeline.run` (`src/lib/pipeline/orchestrator.ts:23`).
- Stage order: `classify → extract → ground → clean → recover → validate →
  confidence` (`src/lib/pipeline/stages/index.ts:15-27`).
- `parseFileBufferDetailed` (`src/lib/file-parser.ts`) produces text (+
  structured OCR); the neutral fallback `buildOcrDocument` (`src/lib/pipeline/ocr.ts:9-16`)
  is used when only source text exists.
- `PipelineService.run` (`src/lib/pipeline/service.ts:47-241`) is the
  transport-agnostic executor: resolves the file, runs the pipeline, persists
  the job row (`service.ts:138-149`, `:190-208`).

Where the profile schema is threaded (every item PROVEN by the cited line):

- **`extract`** — `extractStage` resolves the profile from classification and
  stores it on context: `ctx.profile = profile` (`stages/extract.ts:16-18`),
  then `extractDocument({ profile, sourceText, ocr }, ai, { grounded: false })`
  (`extract.ts:25-29`).
- **`ground`** — `groundExtraction(profile, ...)` iterates
  `profile.schema.fields` in Pass 1 (`grounding.ts:84`), Pass 2 (`grounding.ts:193`),
  and Pass 3 (`grounding.ts:211`).
- **`clean`** — `cleanExtraction` iterates `profile.schema.fields`
  (`entity-cleaner.ts:83`).
- **`recover`** — `recoverStage` requires `ctx.profile` (`stages/recover.ts:46-50`);
  `recoverMissingFields` iterates `profile.schema.fields` (`extractor/recovery.ts:59`);
  `retryEligibleRequiredFields` iterates them again (`recover.ts:185`).
- **`validate`** — `validateExtraction` re-derives the profile from the
  persisted `profileType` (`validator.ts:17`) and uses `profile.validationRules`
  plus `profile.schema.fields` (`validator.ts:22-37`).
- **`confidence`** — uses the extracted fields' `field.crossCheck` / `field.required`
  metadata (`confidence.ts:72`, `:110`) and `profile.validationRules` output.
- **DTO/export** — `exportJob` re-derives the profile (`service.ts:291-293`),
  `rebuildExtraction` maps stored DTO keys through the profile schema
  (`service.ts:602-643`), CSV iterates `profile.exportConfig.csvColumns`
  (`exporter.ts:110-118`).

**⚠️ The schema is threaded through every stage and every downstream surface.**
There is no stage that operates on `OcrDocument` alone; each requires
`ExtractionProfile` + `FieldSchema` metadata. The pipeline is a *profile-driven*
machine, not a *document-driven* one.

**✓** On the positive side, the orchestrator itself is stage-agnostic
(`defaults.ts:10-14`, `stages/index.ts:10-14` comment: future stages are
appended here) — the *stage list* is replaceable without touching the
coordinator. That is the one seam the target architecture can reuse unchanged.

---

## 4. The profile subsystem — predefined schemas, registry, fallback

- `getProfileManager().builtin()` (`src/lib/pipeline/profiles/registry.ts`)
  registers exactly five profiles: **invoice, receipt, resume, contract,
  fallback** (`id: "unknown"`).
- `ExtractionProfile` carries `id, label, docTypes, schema, promptTemplate,
  validationRules, exportConfig, version`; `FieldSchema` is
  (`src/lib/pipeline/types.ts:28-48`): `key, type, itemsType, enum, label,
  description, labelGroup, required, crossCheck`. `ProfileSchema` is
  `version + fields[] + groups[]` (`types.ts:50-55`).
- Receipt profile: 16 predefined fields (`profiles/receipt.ts:3-66`); required
  `receipt_number / receipt_date / merchant_name / total_amount`
  (`receipt.ts:6-8`, `:16`); currency `enum` (`receipt.ts:12`); `line_items`
  as `array`/`object` (`receipt.ts:21-27`); `crossCheck` flags on
  `merchant_tax_id/subtotal/tax_amount/discount_amount/total_amount`
  (`receipt.ts:9,13-16`); declarative `validationRules` (`receipt.ts:86-97`);
  multilingual `docTypes` aliases (`receipt.ts:102-117`).
- Fallback profile ("unknown"): **6 predefined generic fields** —
  `document_title, document_date, author_name, recipient_name, key_numbers,
  summary` (`profiles/fallback.ts:8-30`); its own `promptTemplate`
  (`fallback.ts:32-46`), one `validationRules` entry (`fallback.ts:48-50`), and
  `csvColumns` (`fallback.ts:61`).

**⚠️ Every document that is not a known type does NOT produce free-form
semantic output — it is forced into the fallback profile's 6 generic fields.**
The "unknown" case is still a fixed schema (`fallback.ts:8-30`). There is no
"schema-less" mode anywhere in the codebase.

**✓** The lexicon is category-based, not vendor-based: `LABEL_GROUPS`
(`extractor/label-lexicon.ts:19-118`) maps ~10 semantic categories
(number/date/tax/total/currency/merchant/buyer/payment/pos/notes) to
multilingual words, and `labelGroupForField` resolves a field's category from
`field.labelGroup ?? defaultGroupForField(field.key)` (`label-lexicon.ts:121-141`).
This is the machinery a generic pass could reuse to infer semantics *from
evidence* — but today it is invoked only with a schema field in hand.

---

## 5. The classification layer — a closed set of 5 types

- `KNOWN_TYPES = ["invoice","receipt","resume","contract","unknown"]`
  (`src/lib/pipeline/classifier.ts:10-16`).
- Order: **AI-first** → rule-validation of the AI answer → rule fallback →
  `unknown` (`classifier.ts:24-31`, `:32-128`). Never keyword-first.
- AI classification prompt is the *concatenation of profile ids*:
  `Classify this document into exactly one type: ${options}`
  (`classifier.ts:135-139`); the AI answer is clamped to `KNOWN_TYPES`
  (`classifier.ts:188-192`).
- Rule validation scans the first 3000 chars for `profile.docTypes` aliases:
  `scoreByAliases` (`classifier.ts:203-211`) and `ruleClassify`
  (`classifier.ts:213-241`); a zero-alias AI answer is overruled by rules
  (`classifier.ts:61-80`), low-confidence unmarked answers are rejected
  (`classifier.ts:82-87`), and an unmarked "unknown" is upgraded by a rule match
  (`classifier.ts:90-111`).
- `classifyStage` feeds `ctx.classification`; `extractStage` maps the type to a
  profile via `getProfileManager().getOrFallback(type)` (`extract.ts:16-17`).
- The API re-validates against the same hardcoded list
  (`app/api/pipeline/run/route.ts:52`).

**⚠️ The classifier can only ever return one of 5 types.** A document family
with no profile (bank statement, ID, passport, medical record) is classified
`unknown` and routed to the fallback's 6 generic fields. There is no mechanism
to emit a *novel* document type or a novel field set.

**✓** The pinned-type override (`classifier.ts:36-44`) and the injectable
`AIClient` (`classifier.ts:47`) are seams that already exist; they are useful
for a future dynamic-structuring test harness.

---

## 6. The AI extraction contract — request shape, prompt, output contract

- The model request is minimal: `AIRequest { messages, maxTokens?, temperature? }`
  (`src/types.ts:6-10`). **No per-word OCR confidence and no bounding boxes ever
  reach the model.** The only document view the model sees is text
  (`buildExtractionPrompt`'s `{{document}}`).
- `extractWithAI` → `ai.chatCompletion(buildRequest(prompt))`
  (`extractor/ai-client.ts:25-35`); `buildRequest` = `SYSTEM_PROMPT` + prompt,
  `maxTokens: 4096`, `temperature: 0` (`ai-client.ts:61-73`). System prompt:
  "Reply with ONLY a single valid JSON object…" (`ai-client.ts:5-7`).
- `buildExtractionPrompt` injects **the whole profile schema as JSON**:
  `schemaJson = JSON.stringify(profile.schema)` → replaces `{{schema}}`
  (`extractor/prompt-builder.ts:11-25`); document truncated head+tail to 60k
  (`prompt-builder.ts:3,16`, `truncateMiddle` `:58-66`).
- `OUTPUT_CONTRACT` (`prompt-builder.ts:32-52`):
  - "The keys of `data` are the schema field keys."
  - Per-field envelope `{ raw, value, confidence, evidence }`; `raw` must be a
    verbatim substring; `evidence` a verbatim quote.
  - Semantic no-goes: no currency unless printed, no tax ID without a tax
    label, no line items from footers/totals/fragments.
- Recovery's cross-provider retry re-issues the same prompt via
  `extractWithAIRetry` (`ai-client.ts:42-59`) and re-grounds
  (`stages/recover.ts:96-117`).

**⚠️ The schema IS the AI contract at both ends.** The model is told the exact
keys and types to produce (`prompt-builder.ts:15` + `:33`), and the response is
parsed back through the same schema (`normalizer.ts:31-32`). A model proposing a
semantic field that is not in the schema is not a candidate — it is invisible
(see §7).

**⚠️ Invariant #9 in reverse:** today the *model's* `evidence` strings are
consumed only as `meta.evidenceQuote` (`normalizer.ts:48`) and are never used by
grounding (grounding re-derives evidence from OCR). That is already the
"hints only" property the invariant demands — the target must preserve it.

---

## 7. The normalization / coercion layer — the dynamic-key discard proof

This is M18's critical probe, and it is **PROVEN from code**:

- `normalizeFields(profile, raw)` iterates `for (const field of profile.schema.fields)`
  and reads `raw.data[field.key]` (`extractor/normalizer.ts:31-32`). A model
  output key that is not a schema key is **never read** — it is silently
  discarded before any grounding, validation, or export.
- `candidatesFromAICall` builds `fields` only for schema keys
  (`extractor/index.ts:69-98`, `candidateFields` `:89-98`).
- `postProcessFields` iterates the schema again (`post-processor.ts:39`).
- Therefore: **an "AI-dynamic schema" variable alone does NOT decouple the AI
  contract.** Even if a future classifier produced a dynamic schema object, the
  chain `extractStage (extract.ts:25) → extractDocument (index.ts:42-62) →
  candidatesFromAICall (index.ts:52) → normalizeFields (normalizer.ts:31) →
  groundExtraction (grounding.ts:84) → postProcess (post-processor.ts:39)`
  would still only ever see fields that are members of whatever `schema.fields`
  the profile carried. The decoupling must happen at the *contract boundary*,
  not by making `schema.fields` variable.

Supporting coercion facts (all PROVEN):
- `coerce(field, rawValue)` casts by `field.type` only (`normalizer.ts:74-100`);
  numbers handle Arabic-Indic digits and trailing currency words
  (`toNumber` `:102-118`); dates strip trailing time, accept ISO/MM-DD/DD-MM,
  then fall back to `new Date()` (`toDate` `:120-145`); enums are
  **whitelist-only** — a guessed currency/enum becomes `null`
  (`normalizeEnum` `:156-164`).
- Default model confidence is flat `0.85` when the model omits one
  (`normalizer.ts:10`, `:41-45`).

**⚠️ For the target:** a dynamic semantic field must still be *typed* and
*coerced* for grounding to work (dates need `date` variants, amounts need
numeric-equality matching, enums need an allowed set). Without a schema, the
type and the enum set must come from the model envelope and the evidence — and
the whitelist-only enum rule (`normalizeEnum`) has no meaning without an allowed
set. This is a real design gap, not a cosmetic one.

---

## 8. The grounding ladder — deterministic evidence anchoring and semantic gates

`groundExtraction` (`src/lib/pipeline/extractor/grounding.ts:69-236`), three
passes:

**Pass 1 — evidence + strict grounding (`grounding.ts:83-190`):**
- Universal semantic gates, document-type agnostic:
  - `currency` requires a printed `CURRENCY_MARKER` (`grounding.ts:43-44`, `:89-95`);
  - any `*_tax_id` requires a `TAX_KEYWORD` (`grounding.ts:46-47`, `:96-102`);
  - `line_items` must pass `looksLikeItemizedList` (`grounding.ts:103-109`,
    `:577-595`);
  - `notes`/`text` values must not be `isNoiseFragment` (`grounding.ts:110-123`).
- Evidence anchor: layout provider if available, else OCR `findEvidence`
  (`grounding.ts:130-139`); date derived-variant union (`grounding.ts:140-147`);
  `verifyEvidence` fallback (`grounding.ts:152-154`); drop
  `"not found in source text"` (`grounding.ts:155-159`).
- `line_items` keep the whole matching description set as evidence — no primary
  span, no relabel veto (the descriptions ARE the line content)
  (`grounding.ts:161-170`).
- **Relabel veto:** `labelVerdict` (`grounding.ts:514-525`) drops a value whose
  evidence lines carry a *different* label group than the field's
  (`grounding.ts:174-179`). This is invariant #3's enforcement point.
- Primary/alternatives via `choosePrimaryEvidence` (`grounding.ts:461-508`) —
  differing OCR readings become honest `alternatives`.

**Pass 2 — composed confidence (`grounding.ts:192-206`):**
`confidence = clamp(aiConf × ocrFactor × labelFactor × (hasEvidence ? 1 : NO_EVIDENCE_FACTOR))`
with `MIN_CONFIDENCE 0.3`, `LABEL_NEUTRAL_FACTOR 0.8`, `NO_EVIDENCE_FACTOR 0.9`,
`LOW_OCR_THRESHOLD 0.6` (`grounding.ts:35-41`); `ocrConfidenceFactor`
(`grounding.ts:540-550`), `labelConfidenceFactor` (`grounding.ts:553-560`),
`uncertaintyReasons` (`grounding.ts:563-573`).

**Pass 3 — commit/drop (`grounding.ts:208-227`):** drop empty
(`grounding.ts:217-220`) and drop `confidence < MIN_CONFIDENCE`
(`grounding.ts:221-223`).

Matching specifics that a generic pass must keep:
- Numeric fields anchor on **value equality with magnitude guard**, never
  substring: `findNumericSpan`/`numericKey` (`grounding.ts:399-441`),
  `isNumericField` (`grounding.ts:389-391`). "$100" can never ground "$1000".
- `valueNeedles` for arrays anchors on **item descriptions** (`grounding.ts:272-277`).
- `derivedVariants` covers dates + thousands-separator amounts
  (`grounding.ts:310-319`).

**✓** Grounding is deterministic and provider-independent (invariant #10): it
consumes `profile + extraction + sourceText + ocr`, all pure functions, no
randomness, no provider state.

**⚠️ Every gate is keyed or typed:** `field.key.endsWith("_tax_id")`
(`grounding.ts:96`), `field.key === "currency"` (`grounding.ts:89`),
`field.key === "line_items"` (`grounding.ts:103,167`), `field.key === "notes"`
(`grounding.ts:110`), `field.type` everywhere. A dynamic field named
`vat_number` (not ending `_tax_id`) would **not** get the tax gate
(invariant #7); a dynamic field named `grand_total` would get `type`-driven
numeric matching but none of the currency-stated gate. **The semantic gates are
hardwired to specific schema keys, not to label categories.** This is the
single largest re-work surface for "generic evidence grounding."

---

## 9. The layout-aware evidence layer — scopes, confidence, and the M13 interplay

- Reader is cached per frozen OCR via `WeakMap` (`layout-aware-evidence.ts:73-88`)
  so all stages share one layout build per document.
- Ladder (narrowest first): `explicit region → reading-order neighbors → same
  block → same page → whole document` — `buildLayoutAwareEvidence`
  (`layout-aware-evidence.ts:126-173`); plan from `LayoutAwareSelector.planFor`
  (`layout-aware-selector.ts:135-149`).
- Region mapping is key-based: `KEY_RULES` regexes over the field key
  (`layout-aware-selector.ts:49-80`), fallback `LABEL_RULES` over the label
  category (`layout-aware-selector.ts:83-100`).
- `createLayoutEvidenceProvider` (`layout-aware-evidence.ts:212-228`) searches
  the field's primary `valueNeedles` then `derivedVariants`; returns `[]` when
  layout is unavailable so the OCR-only path runs unchanged
  (`layout-aware-evidence.ts:134-136`).
- Matching is `normLine.includes(needle)` then token-set equality
  (`layout-aware-evidence.ts:256-278`); `maxSpanChars: 120` guards noise
  (`layout-aware-evidence.ts:59-61`, `:268`).
- **Confidence (M13-sensitive):** `combineConfidence` (`layout-aware-evidence.ts:98-120`)
  is the mean of the *measured* component means of the frozen M2
  `ConfidenceProfile`; without a `measured` mask it is the mean of all six
  (`layout-aware-evidence.ts:100-110`). **M13 proved** that the pre-mask form
  diluted a 0.768-per-word line to 0.128 and dropped `merchant_name`
  (`M13-RECONNAISSANCE-REPORT.md §4-6`); the measured-mask fix is in the
  **working tree, uncommitted** (invariant #5 must be preserved).
- Evidence provenance stays in the shared OCR vocabulary (`source: "ocr"`) with
  `layoutRank`/`scope` recorded separately (`layout-aware-evidence.ts:311-325`,
  `LayoutFieldEvidence` `:46-51`).

**✓** The layout layer is already *document-driven* (reads OCR + field metadata)
and deterministic. It is the closest existing component to the target's
"generic evidence grounding."

**⚠️ The selector's region mapping is key-regex-based (`layout-aware-selector.ts:49-80`).**
A dynamic field whose key does not match any `KEY_RULES`/`LABEL_RULES` regex
falls back to `regionTypesFor → []` → `planFor` returns the bare `document`
ladder (`layout-aware-selector.ts:112-148`) — meaning every value would be
matched at the outermost scope with no region priority, and the layout
confidence components for a bare value line would again risk the M13 dilution
pattern unless the measured-mask is always present.

---

## 10. Verify-or-Find — the deterministic VERIFY and FIND arms

`src/lib/pipeline/extractor/verify-or-find.ts`:

- Constants: `FLAG_CONFIDENCE_FACTOR 0.7`, `FLAG_CONFIDENCE_CAP 0.5`,
  `DEFAULT_OCR_CONFIDENCE 0.7` (`:52-54`).
- **VERIFY arm** (`verifyEvidence` `:65-84`): only deterministic normalization
  tiers — separator-free reference numbers for `number`/`tax` label categories
  on string/text fields (`searchSeparatorFree` `:87-98`, with digit-count guard
  `findSeparatorFreeSpan` `:134-159`) and alternative ISO date layouts
  (`searchIsoDateVariants` `:101-126`). No fuzzy matching — "Amzon" never
  verifies as "Amazon" (`:18-25` doc block).
- **FIND arm** (`findFieldCandidates` `:178-198`): label-driven search using
  `labelWords(field)` = the field's **label phrase** (whitespace-collapsed,
  never tokenized) + the category lexicon words (`:206-217` — the M17 fix);
  `firstMatchingLabel` longest-match-wins (`:220-230`); per-type candidate
  extraction (`extractLineCandidates` `:236-268`).
- For string/text, the value must follow the label **on the same line**
  (`textCandidates` `:339-360`, `valueAfterLabel` `:363-372`) and, for reference
  categories, must pass `looksLikeReference` (every token carries a digit)
  (`:375-388`).
- Recovered candidates carry deliberately low confidence:
  `flagConfidence(base) = min(0.5, base × 0.7)` (`:407-419`).

**✓** The FIND arm is already *generic*: it takes only `(field: FieldSchema,
ocrDoc)` and uses only label metadata + OCR spans (`:178-198`). It is the
closest existing primitive to "find semantics from a label, without a value."

**⚠️** It still requires a `FieldSchema` (for `labelGroupForField`, `type`,
`label`, `enum`). A dynamic field needs these produced by the structuring pass
before FIND can operate — including the label phrase itself, which today is the
author-written `field.label`, not something inferred from OCR.

---

## 11. The recovery stage — FIND commit + cross-provider retry

- `recoverMissingFields` (`extractor/recovery.ts:48-98`): only `required`
  fields; a single distinct candidate → `flagged` (source `"ocr"`, low
  confidence); several → `ambiguous` with `alternatives`; none → unresolved.
- `recoverStage` (`stages/recover.ts:42-125`):
  - **Verdict pass (invariant #6):** flagged candidates are re-anchored through
    `groundExtraction` (`groundFlaggedRecovery` `:63-72`, `:134-171`) so the
    relabel veto + universal semantic checks apply to recovery exactly as to
    grounding; only survivors are committed.
  - **Retry gate:** only drop reasons `"not found in document"` / `"empty value"`
    are retryable (`:179-195`); a confidence-only miss (the M13 merchant case)
    is never retried.
  - **Cross-provider retry:** re-issues `buildExtractionPrompt` on a different
    provider (skipping the used one), re-normalizes, and **re-grounds**
    (`:87-122`, `mergeRetry` `:232-263`).
- Field ordering stays schema-defined (`reorderFields` `:266-281`).

**✓** Recovery already honors "never bypass grounding" (invariant #6) through
`groundFlaggedRecovery`, and the retry path re-grounds before commit.

**⚠️** Both arms are keyed to `field.required` from the schema (`recovery.ts:59-62`,
`recover.ts:185-188`). In the target, "required" is a profile notion; a dynamic
document has no required set. The target needs an evidence-driven "is this
semantic entity expected?" rule (e.g. a label was found, but no value) instead
of a schema flag.

---

## 12. The entity cleaner — surgical, metadata-driven normalization

`cleanExtraction` (`src/lib/pipeline/entity-cleaner.ts:68-166`):

- Free-text gate: `notes`/`text` must pass `isNoiseFragment` AND be grounded to a
  single OCR line (`:89-102`, `isFreeTextField` `:180-182`, `freeTextVerdict`
  `:217-227`).
- Line-item gate: descriptions must contain letters, not be a noise fragment /
  generic footer marker, and be grounded to one OCR line
  (`:105-127`, `cleanLineItems` `:237-273`, `isPlausibleItemDescription`
  `:263-273`); if every item is suppressed the field is dropped.
- Only `string`/`text` are cleanable (`isCleanable` `:175-177`); structured
  types are already coerced.
- Surgical ops: invisible-character removal, NFKC, whitespace collapse,
  duplicate-punctuation/dash collapse, edge-separator trimming
  (`:281-329`); name-like fields additionally trim detached pure-digit edge
  tokens (`isNameField` `:189-198`, `trimNameEdgeArtifacts` `:358-370`).
- "Provable better" guards: `preservesContent` (letter/digit multiset subset,
  `:374-389`), `preservesOrder` (subsequence, `:392-407`),
  `preservesBracketBalance` (`:410-424`).
- **Re-grounding safety:** every cleaned text value must still ground through
  the same strict engine (`canGround` `:434-449`, `strictlyGrounded` `:451-480`)
  or the lossless normalization fallback with the same relabel guard
  (`appearsInOcr` `:482-504`).

**✓** The cleaner is already generic (metadata + type + label category only;
explicitly "no field key beyond its semantic category, no document type,
vendor, or sample pattern" — `:29-32`). This is the most target-ready component.

**⚠️** Two hardcoded schema keys remain: `line_items` (`:105`) and `notes`
(`:181`, `:491`). Dynamic field names must be mapped to these semantics (via
label category or evidence) or the gates silently do not apply (invariant #7).

---

## 13. The validation layer — declarative, schema-keyed

`validateExtraction` (`src/lib/pipeline/validator.ts:14-48`):

- Rules come from the re-derived profile: `getProfileManager().getOrFallback(extraction.profileType)`
  (`:17`); `required` set from rules (`:22`), `defined` set from the schema
  (`:23`).
- Missing-required detection on schema-required fields (`:33-37`).
- Per-rule evaluation (`evaluate` `:50-142`): enum whitelist (`:68-76`), regex
  pattern (`:79-91`), `yyyy-mm-dd` date format (`:94-101`), number/currency
  range (`:104-116`), and the **cross-field total reconciliation** special case
  for `total_amount` (`:119-135`).
- Rules referencing unknown fields fail explicitly (`:137-139`).

**⚠️** Validation is doubly schema-coupled: it needs the profile (`:17`) and its
`missing`/`defined` sets are schema-derived (`:22-37`); `total_amount`
reconciliation is a hardcoded key (`:119`). In the target, "validation" must
become evidence semantics (e.g. an amount labeled "total" whose line also shows
subtotal/tax) rather than keyed rules — otherwise dynamic documents get no
validation and invariant #7 (no dynamic safety rules) is violated the other way
(fields that DO exist but cannot be cross-checked).

---

## 14. The confidence engine — multi-signal, schema-coupled

`computeConfidence` (`src/lib/pipeline/confidence.ts:24-57`):

- Seven signals: `validation, consistency, ocrQuality, extraction, missing,
  evidence, uncertainty` (`:29-37`), plus optional low-weight `modelConfidence`
  (`:38-40`).
- `consistencySignal` uses `field.crossCheck` (`:71-77`); `extractionSignal`
  weights required fields 2× (`:107-118`); `missingSignal` penalizes each
  missing required field 0.2 (`:121-124`); `evidenceSignal` = coverage ×
  mean evidence confidence (`:127-146`); `uncertaintySignal` penalizes
  flagged/ambiguous/recovered (`:149-165`).
- `combine` weighted sum: validation 0.3, extraction 0.3, then five others
  (`:167-178`).
- `confidenceStage` multiplies a failed field's confidence by
  `VALIDATION_ADJUSTMENT 0.85` (`stages/confidence.ts:5`, `:16-32`).

**✓** The OCR-quality signal is already document-driven (per-word/per-line
confidences, `confidence.ts:84-104`), and the evidence/uncertainty signals are
field-agnostic.

**⚠️** The `consistency`, `extraction` (required weighting), and `missing`
signals all depend on `field.crossCheck` / `field.required` — schema metadata.
A dynamic document would have neither; its overall confidence would lose these
signals (they degrade to neutral 1.0 / 0), not error. That is tolerable but
means "overall confidence" for a dynamic document is not comparable with the
schema-backed number today — a compatibility and product problem for
`overall_confidence` in existing persisted jobs.

---

## 15. The DTO and persistence contract

- `FieldDTO` (`src/lib/pipeline/dto.ts:14-34`): `key, value, raw?, evidence[],
  confidence, source, status, alternatives?, reasons?`.
- `JobDTO` (`dto.ts:45-70`): `profileType, profileVersion, pipelineVersion,
  provider, model, overallConfidence, fields, validation {ok, missing},
  confidence {overall, signals, summary}, sourceText (≤4000 preview, `:118-119,138-140`),
  ocr, url`.
- Persistence is a single `extractions` table with `fields_json, validation_json,
  confidence_json, ocr_json, source_text, trace_json` (`service.ts:138-149`,
  `:190-208`; `dto.ts:92-116`).
- `serializeFields` emits exactly the committed fields with evidence
  (`service.ts:645-657`); `round4` clamps precision (`service.ts:659-661`).
- **`rebuildExtraction` (export/edit path):** stored DTO keys are mapped back
  through the profile schema; a key NOT in the schema gets a synthetic schema
  `{ key, type: "string", label: key }` (`service.ts:607-610`). So persisted
  unknown keys survive round-trip **but are treated as untyped strings** — no
  labelGroup, no required, no crossCheck — which silently disables every
  metadata-driven safety check on them after a re-export.
- `updateFields` whitelists override keys against the profile schema and rejects
  anything else (`service.ts:349-356`).

**⚠️** The persistence contract is *not* schema-free: `profile_type` +
`profile_version` are required columns (`dto.ts:49-50`, `service.ts:193-194`),
and every read path re-derives the schema from those (`service.ts:291-293`,
`:602-643`). A dynamic document would need a durable artifact describing its own
field set (or a stable "dynamic" profile version) for re-export/edit to work —
nothing stores the model's proposed schema today.

**✓** The DTO shape itself is stable and field-agnostic (`dto.ts:8-11`, `:14-34`);
the *schema shape* (`FieldSchemaDTO`, `ProfileSchemaDTO`) is a UI mirror, not a
storage dependency (§17).

---

## 16. The export surface

`exportExtraction` (`src/lib/pipeline/exporter.ts:25-45`):

- **JSON** is self-describing and schema-light: `document_type, confidence,
  signals, extracted_at, provider, model` + `fields` keyed by field key, each
  carrying `value/confidence/source/status/edited/verified/label/raw/evidence/
  reasons/alternatives` (`:57-102`); empty values (incl. empty arrays) are never
  emitted (`:64-65`, `:50-55` doc block).
- **CSV** is schema-coupled: `columns = profile.exportConfig.csvColumns ?? Object.keys(extraction.cleanFields)`
  (`:110-118`). `cleanFields` itself is built by grounding/cleaning from the
  schema (`grounding.ts:226`, `entity-cleaner.ts:152`). So CSV column order and
  set are profile-defined.
- XLSX/PDF are explicit "phase 2" throws (`:39-41`); the API maps those to
  `UNSUPPORTED_FORMAT` (`service.ts:306-313`).

**⚠️** CSV cannot represent a dynamic field set unless `csvColumns` stops being
the source of truth. The existing *fallback*: `Object.keys(cleanFields)`
(`exporter.ts:111`) already yields whatever was committed — that is the natural
dynamic-CSV path, but it is only a fallback today.

**✓** JSON export is the least schema-coupled consumer and would survive a
dynamic pass almost unchanged.

---

## 17. The UI surface

`src/app/(dashboard)/documents/page.tsx`:

- Client mirrors of the schema DTOs: `FieldSchemaDTO` / `ProfileSchemaDTO`
  (`:39-59`).
- `humanize(key)` (`:63-68`) and `displayValue` (`:70-75`) render any field;
  `parseDraft(def, draft)` coerces user edits per `def.type` (`:93-118`).
- Field labels fall back to `schema?.fields.find(...)?.label ?? humanize(key)`
  (`:810`); confidence color coding (`:77-81`); signal breakdown key mapping
  (`:83-91`).
- The review UI renders fields from the persisted `FieldDTO[]` with
  evidence/reasons/alternatives.

**⚠️** The UI's editing path is type-driven from the schema (`parseDraft`,
`:93-118`) and labels come from the schema (`:810`). A dynamic field still
renders (via `humanize`) but the label is the key, not an OCR-inferred label,
and editing validates against a `string` type only.

**✓** The UI already degrades gracefully for unknown keys (`humanize` fallback),
so a dynamic field set would render — with reduced fidelity.

---

## 18. The API surface

- `POST /api/pipeline/run` (`src/app/api/pipeline/run/route.ts:19-75`): auth +
  rate-limit (`:20-38`), body validation (`:47-54`), profileType validated
  against the hardcoded 5 (`:52`), returns `{job, created, rerun, location}`
  (`:68-71`).
- List/create/get/delete/edit/export/replace routes under
  `src/app/api/pipeline/extractions/**`, all thin over `PipelineService`
  (`service.ts` is transport-agnostic, `:29-35`).

**⚠️** The `profileType` body parameter and its hardcoded validation
(`run/route.ts:51-54`) are the API's own copy of the closed type list. A dynamic
structuring mode would need either a new flag (e.g. `structuring: "dynamic"`)
or a relaxation of the closed-list validation — both are API-contract changes.

---

## 19. Fixtures and the fixture experiment (Step 11)

Fixture inventory (PROVEN):
- **`tests/fixtures/receipt-ocr.ts`** — exactly one real end-to-end fixture:
  the SuperPay receipt OCR stream (`receipt-ocr.ts:7-24`), used by
  `receipt-extraction.test.ts` and friends.
- **`tests/fixtures/arabic-ocr-corpus.ts`** — `ARABIC_OCR_CORPUS` (134 lines)
  covers five OCR-repair document families: `receipt, invoice, contract,
  bilingual, bank` (`arabic-ocr-corpus.ts:15-27`, entries `:29-134`; bank entry
  `:101-118`). These are **OCR post-processing fixtures** (raw stream →
  expected repaired lines), NOT pipeline extraction fixtures — none carries an
  expected per-field extraction.
- **No non-receipt end-to-end extraction fixture exists** in the repo. There is
  no bank/invoice/contract extraction test driving the pipeline to expected
  field values.

**Fixture experiment (Step 11) — code-traced, no file created** (constraint: no
new tests). Take the corpus's own bank-statement text
(`arabic-ocr-corpus.ts:105-111`): "البنك السعودي للاستثمار / كشف حساب رقم
391803452 / …". Trace through the real code:

1. **Classify** (`classifier.ts`): `docTypes` aliases across the five profiles
   (`classifier.ts:135-139`, profiles' `docTypes`) contain no bank aliases —
   "كشف حساب" is not in any list (`receipt.ts:102-117`, contract/invoice/resume
   lists) → `ruleClassify` returns `null` (`classifier.ts:231`); if AI also
   returns no strong signal → `unknown` (`classifier.ts:121-127`). **PROVEN** by
   alias inspection.
2. **Extract** (`extract.ts:16-17`): `getOrFallback("unknown")` →
   `fallbackProfile` (`profiles/fallback.ts:52-65`) → the prompt asks only for
   `document_title, document_date, author_name, recipient_name, key_numbers,
   summary` (`fallback.ts:8-30`, `:32-46`).
3. **Normalize** (`normalizer.ts:31-32`): any richer fields a model might name
   (account number, opening/closing balance) are **not schema keys and are
   discarded**. **PROVEN** — the §7 discard applies directly.
4. **Commit** would therefore be a subset of the 6 fallback fields; CSV export
   uses the fallback `csvColumns` (`fallback.ts:61`).

Consequence: **a synthetic bank statement can never surface
`account_number` / `opening_balance` / `closing_balance` in today's pipeline.**
The fallback profile is the ceiling for any unrecognized document. **PROVEN** by
the code trace.

---

## 20. Feasibility assessment for the target architecture

### 20.1 Verdict

**The target is not reachable by "making the schema dynamic" — it requires a
decoupled structuring pass plus a generic grounding ladder, and it must be built
behind a compat shim.** All three hard blockers below are PROVEN from code;
everything else is a design consequence.

### 20.2 The three hard blockers (PROVEN)

1. **The schema is the AI contract at both ends.**
   `{{schema}}` = `JSON.stringify(profile.schema)` (`prompt-builder.ts:15`);
   OUTPUT_CONTRACT forces the keys (`prompt-builder.ts:33`); the response is
   re-read only through schema keys (`normalizer.ts:31-32`). A dynamic schema
   variable changes *what* is sent but not *that* both sides agree — the model
   still emits exactly the schema's keys and everything else is invisible. The
   decoupling must live in a new prompt + parser contract where the model is
   asked for semantic entities (typed envelope + label hint + evidence hint),
   not schema fields.

2. **Every safety gate is keyed or typed to schema metadata.**
   `currency`/`*_tax_id`/`line_items`/`notes` hardcoded keys (`grounding.ts:89,96,103,110`),
   `isNameField`/`notes` keys (`entity-cleaner.ts:181,189-198`), `total_amount`
   reconciliation (`validator.ts:119`), `crossCheck`/`required` signals
   (`confidence.ts:72,110,121`), FIND's `label`/`labelGroup`/`type`/`enum`
   (`verify-or-find.ts:206-217,236-268`). A dynamic field inherits none of this.
   Invariants #3/#7 (no relabel, no dynamic safety rules) therefore require
   **label-category inference from evidence** (reusing `label-lexicon.ts`
   `detectLabelGroup`), not from key names.

3. **The persistence/export/edit contract is profile-anchored.**
   `profile_type` + `profile_version` columns (`dto.ts:49-50`), schema re-derive
   on every read (`service.ts:291-293,602-643`), edit whitelist
   (`service.ts:349-356`), CSV from `csvColumns` (`exporter.ts:110-118`),
   `rebuildExtraction` downgrades unknown keys to untyped strings
   (`service.ts:610`). Dynamic documents need a durable self-describing field
   set (or a stable "dynamic" profile version) for round-trip correctness.

### 20.3 What already works for the target (✓)

- **Stage list is swappable** (`defaults.ts:10-18`, `stages/index.ts:10-14`).
- **Grounding/cleaning/recovery/confidence are deterministic and
  provider-independent** (invariants #6/#10 hold today; §8, §11, §12).
- **Evidence is document-driven already**: layout ladder (§9),
  `verifyEvidence`/`findFieldCandidates` (§10), `valueNeedles` on item
  descriptions (§8).
- **JSON export** is schema-light (§16) and the **UI renders unknown keys**
  (§17).
- **The label lexicon is category-based** (`label-lexicon.ts:19-141`) and the
  FIND arm already operates label→candidate generically (§10) — the seed for a
  generic structuring engine.

### 20.4 Target decomposition (README only — NOT a proposal to implement)

A feasible shape that preserves all 10 invariants and backward compatibility:

1. **Structuring pass (new contract):** prompt the model for semantic entities —
   `{ key?, name, type, value, raw, confidence, labelPhrase, evidenceQuote }` —
   without a schema. Keep the model's `labelPhrase`/`evidenceQuote` strictly as
   **hints** (invariant #9): grounding must re-derive evidence from OCR.
2. **Label-category inference:** map each entity's `labelPhrase`/evidence line
   through the existing `detectLabelGroup` (`label-lexicon.ts:150-163`) to
   obtain a semantic category — never from the key name (invariant #8). This
   restores the relabel veto and label factor without schema membership.
3. **Generic grounding ladder:** reuse the layout ladder (§9) + numeric
   equality (§8) + verify-or-find tiers (§10) keyed by the *inferred category and
   type*, not by key. Universal gates (currency-stated, tax-label, itemized-list,
   notes-garbage) become category/evidence-driven instead of key-driven
   (invariants #3/#7).
4. **Confidence without schema:** evidence/OCR/uncertainty signals already work
   (§14); add a document-level "structuring confidence" so `overall` stays
   comparable with the schema path.
5. **Compat shim (backward compatibility):** when the classifier returns a known
   profile, run the current schema path byte-identically (M13–M17 results,
   persisted jobs, exports, and `overall_confidence` all unchanged). Route only
   "unknown" (or a new explicit mode) through the dynamic path; persist the
   dynamic entity set so re-export/edit round-trips (§15).

### 20.5 M13–M17 compatibility matrix (what the transition must not regress)

| Milestone | Behavior that must stay byte-identical | Enforced today by | Target must preserve via |
|---|---|---|---|
| M13 | Layout confidence must not dilute OCR confidence (merchant drop) | `combineConfidence` measured-mask (`layout-aware-evidence.ts:98-120`) — **uncommitted** | Reuse the same confidence combine + presence mask in the generic ladder |
| M14 | Tax-ID value anchored to a tax-labeled line, never a bare number | `*_tax_id` gate + `TAX_KEYWORD` (`grounding.ts:96-102`) | Category-driven tax gate on inferred `tax` label |
| M15 | Notes garbage gate + relabel veto; no line-merge artifacts | `freeTextVerdict` (`entity-cleaner.ts:217-227`), `labelVerdict` (`grounding.ts:514-525`) | Same verdicts, keyed by inferred category |
| M16 | Line items need grounded descriptions, phantom items suppressed | `valueNeedles` (`grounding.ts:272-277`), `cleanLineItems` (`entity-cleaner.ts:237-273`) | Item-description anchoring + noise suppression, category-driven |
| M17 | Phrase-anchored labels + same-line values; no generic-token borrow | `labelWords`/`textCandidates`/`looksLikeReference` (`verify-or-find.ts:206-217,339-388`) | The same FIND engine on inferred label phrases |

### 20.6 Open questions (UNKNOWN)

- Whether "unknown" documents should route to the dynamic path by default or
  only via an explicit API flag (product decision; the API contract
  `run/route.ts:51-54` would change either way).
- How to persist a dynamic entity set durably so re-export/edit round-trips
  without a schema (`service.ts:602-643`, `updateFields` `:349-356`).
- Whether the model's proposed semantic entities can be trusted to *name*
  themselves consistently across documents (needed for CSV column stability,
  `exporter.ts:110-118`), or whether the inferred label category is the stable
  key.
- The behavior of `overall_confidence` comparability between schema-backed and
  dynamic runs (§14), and whether a legacy job's confidence must remain frozen
  (`PIPELINE_VERSION` bump implication — `service.ts:144`).
- Whether layout region inference (`layout-aware-selector.ts:49-100`, key-regex
  based) can be extended to category-driven plans without regressing M13/M16.

### 20.7 Bottom line

FlexiData cannot reach the target architecture by parameterizing the existing
pipeline: the schema is the AI contract at both ends (`prompt-builder.ts:15` +
`normalizer.ts:31`), every safety gate is keyed/typed to schema metadata
(`grounding.ts:89-123`, `validator.ts:119`, `confidence.ts:72-124`), and the
persistence/export/edit surface re-derives schemas on every read
(`service.ts:291-293,602-643`). The generic evidence machinery that the target
needs already exists and is deterministic (§8–§12); the missing pieces are a
schema-less structuring contract (model proposes entities + label hints), a
category-from-evidence inference layer (reusing `label-lexicon.ts`), a
category/type-driven grounding ladder, and a compat shim that keeps the
schema path and all M13–M17 behavior byte-identical. All 10 M18 safety
invariants must be re-verified against the dynamic path — most critically
#3 (no relabeling, now that labels are inferred), #7 (no dynamic safety rules),
and #9 (AI hints only). **PROVEN** blockers: §3, §6, §7, §19, §20.2.

---

## Verification performed

- `git status --short`: only pre-existing M13–M16 working-tree changes
  (listed below) plus this report. No production/test/config/prompt/OCR/schema/
  threshold/label/recovery files touched.
- Pre-existing uncommitted changes observed (NOT produced by M18):
  `src/lib/extraction/layout-aware-evidence.ts`,
  `src/lib/layout/{blocks,confidence-propagation,confidence-validation,confidence,hierarchy,region-classifier}.ts`,
  `src/lib/pipeline/extractor/grounding.ts`, `tests/_entry.ts`,
  `tests/{confidence,entity-cleaner,grounding-evidence,receipt-extraction}.test.ts`,
  plus untracked `M13/M14/M15/M16` reports, `SUPERPAY-FORENSIC-REPORT.md`, and
  `tests/{confidence-measured,line-items-evidence,tax-gate}.test.ts` +
  `tests/live/*` probes.
- No `npm test` / `tsc` / lint run was performed (no code changed); all claims
  above are code-read-based, with arithmetic/behavior shown inline where needed.
- HEAD commit audited: `2a3e5a1 fix: harden recovery FIND grounding and label
  matching` (M17); M13–M16 work remains uncommitted.
