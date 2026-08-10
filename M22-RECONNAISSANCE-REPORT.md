# M22 - Reconnaissance Report (forensic audit BEFORE implementation)

Status: READ-ONLY AUDIT. No code, test, prompt, schema, SQL or UI changes were made.

Supersedes / extends: SUPERPAY-FORENSIC-REPORT.md (post-M12). M22 re-verifies every prior claim
against the CURRENT source (M13-M21) and adds the full A-J production trace plus the dynamic-mode
schema-leak catalog. Where this report differs from the older one, THIS report wins.

Evidence conventions: every claim is labeled [PROVEN] (verified against current source and/or
committed artifacts, with file:line), [INFERRED] (derived from provable premises, not directly
observed), or [UNKNOWN] (no evidence). No claim is asserted without a tag.

---

## 0. Scope and constraints (re-affirmed, non-negotiable)

- Do NOT implement anything until this report is approved.
- Do NOT introduce: Python/Rust OCR, multi-OCR arbitration, a UI redesign, a new field registry.
- Preserve legacy M13-M21 behavior byte-identically where it is correct.
- Additive architecture preferred; every change must be provable better and revertable.
- AI (and this report) must never invent evidence. Grounded, verbatim or normalized - nothing else.
- Dynamic (discovery) mode contract: NO required fields, NO static schema-key semantic instructions,
  one OCR source.

---

## 1. Executive verdict

The SuperPay production failure is a cascade, not a single bug:

1. OCR layer damage - bidi-smashed RTL lines, merged header text, misread labels/numbers. The
   pipeline is downstream of this and never repairs it (by design). [PROVEN]
2. Legacy schema mismatch - the receipt schema has no fields for the SuperPay document's actual
   identifiers (transaction / reference / account / customer-mobile numbers). Legacy normalizeFields
   silently discards every AI-produced key that is not in the schema, so those values are
   structurally unreachable in legacy mode. [PROVEN]
3. Grounding confidence gate - merchant_name ("SuperPay") is a real OCR string on a label-less
   line. Composed confidence (aiConf * ocrFactor * 0.8) falls below MIN_CONFIDENCE = 0.3 and the
   field is dropped. [PROVEN mechanism, UNKNOWN exact runtime components]. Recovery cannot rescue
   it (no label word in the document; retry gate excludes the drop reason). [PROVEN]
4. UI mirrors raw OCR - the review title is sourceText.slice(0, 60), so the bidi-damaged header
   text becomes the visible title; the "Missing required fields: Merchant / store name" banner is
   the validator's missing list rendered verbatim. [PROVEN]

The dynamic (discovery) mode already in the codebase addresses the root cause of items 2-4 for
future runs (no predefined keys, values anchored to OCR, neutral validation), but this audit finds
one hard contract violation in the current dynamic path - the recovery stage injects
profile-schema-required fields into dynamic extractions via label-driven FIND [PROVEN] - plus a set
of smaller mode-gating gaps. Those must be fixed before dynamic mode is trusted as the remediation
for this document class.

---

## 2. The actual dynamic lifecycle (as the code is today)

Traced end-to-end against current source. Every step carries file:line.

1. API - POST /api/pipeline/run parses extractionMode; must be ["legacy","dynamic"] else 400
   (src/app/api/pipeline/run/route.ts:56-59); forwarded into the service (route.ts:63-72). [PROVEN]
2. Service run - PipelineService.run passes extractionMode into the run input
   (src/lib/pipeline/service.ts:184). Idempotency + force re-run unchanged. [PROVEN]
3. Orchestrator - builds state (input, sourceText, textStats, ocr = input.ocr ??
   buildOcrDocument(input.sourceText)), then runs the fixed stage list
   (src/lib/pipeline/orchestrator.ts; src/lib/pipeline/stages/index.ts:18-26):
   classify -> extract -> ground -> clean -> recover -> validate -> confidence. [PROVEN]
4. classify - classifyDocument(ctx.sourceText, { pinned: ctx.input.profileType, ai })
   (src/lib/pipeline/stages/classify.ts:9-12). Pinned type short-circuits with source "rule",
   confidence 1 (src/lib/pipeline/classifier.ts:36-44). Unpinned: AI-first, rule-validated,
   rule-fallback, then unknown (classifier.ts:49-128). [PROVEN]
5. extract - resolves the profile (getOrFallback, stages/extract.ts:17), builds the prompt
   document via the layout-aware reader when OCR is present (extract.ts:21-24,
   src/lib/extraction/layout-aware-reader.ts:111-145), and calls extractDocument(...,{grounded:
   false}) (extract.ts:25-34) - candidates only; grounding is a separate stage. [PROVEN]
6. Prompt - dynamic mode does NOT inject the profile schema: buildExtractionPrompt branches to
   buildDynamicPrompt(sourceText) (src/lib/pipeline/extractor/prompt-builder.ts:19,108-115), a
   schema-free discovery prompt with its own output contract (prompt-builder.ts:67-105). Legacy
   mode injects {{schema}} + the profile template (prompt-builder.ts:21-30). [PROVEN]
7. Parse + normalize - JSON repair -> parseRaw (src/lib/pipeline/extractor/index.ts:149-175) ->
   candidatesFromAICall (index.ts:85-108). Dynamic: normalizeDynamicFields
   (src/lib/pipeline/extractor/normalizer.ts:74-100) preserves EVERY discovered key (safe-keyed
   via safeFieldKey, src/lib/pipeline/extractor/dynamic.ts:55-66; prototype-key blocked,
   dynamic.ts:129-139); type/label/group/evidence kept on meta (normalizer.ts:82-85);
   fieldSchemaForDynamicField adapts each into the NormalizedField shape (index.ts:116-124,
   dynamic.ts:103-117). Legacy: normalizeFields iterates profile.schema.fields ONLY and silently
   drops non-schema keys (normalizer.ts:35-54). [PROVEN]
8. ground - groundExtraction(profile, candidates, sourceText, ocr, layoutProvider)
   (src/lib/pipeline/stages/ground.ts:22-30). enumerateFields = schema fields first (schema
   order), then any discovered keys in insertion order (src/lib/pipeline/extractor/grounding.ts:
   262-274). Dynamic fields skip the relabel veto (grounding.ts:186-188) but the universal
   key-based semantic checks (grounding.ts:94-128) and labelConfidenceFactor (grounding.ts:
   589-596) still apply. Evidence: layout-aware ladder when available else OCR-only findEvidence
   (grounding.ts:276-301); verify-or-find adds deterministic normalization tiers
   (src/lib/pipeline/extractor/verify-or-find.ts:65-84). Pass 3 drops empty values and any field
   with composed confidence < MIN_CONFIDENCE 0.3 (grounding.ts:225-241). [PROVEN]
9. clean - cleanExtraction iterates profile.schema.fields ONLY (src/lib/pipeline/entity-cleaner.ts:
   83) - dynamic fields are never cleaned. GAP. [PROVEN]
10. recover - recoverMissingFields iterates profile.schema.fields required keys (src/lib/pipeline/
    extractor/recovery.ts:59-60) and applyRecovery injects schema-typed fields (src/lib/pipeline/
    stages/recover.ts:82-85). SCHEMA LEAK in dynamic mode. Cross-provider retry is also
    schema-gated (stages/recover.ts:187-203). [PROVEN]
11. validate - dynamic returns neutral { ok:true, results:[], missing:[] }
    (src/lib/pipeline/validator.ts:22-24). [PROVEN]
12. confidence - computeConfidence (src/lib/pipeline/confidence.ts). Dynamic synthesized fields
    carry no required/crossCheck, so required-weight (confidence.ts:107-118) never applies. [PROVEN]
13. Persist - extraction_mode = extraction.extractionMode ?? "legacy" (service.ts:199);
    fields_json serializes type/label/evidence/reasons per field
    (service.ts:687-701; src/lib/pipeline/dto.ts:14-46). Column exists idempotently
    (supabase/pipeline.sql:118-119). [PROVEN]
14. Export - dynamic CSV columns = produced field keys in extraction order, deduped
    (src/lib/pipeline/exporter.ts:113-118); legacy keeps profile.exportConfig.csvColumns
    (exporter.ts:118). Base filename still profile-derived (exporter.ts:30-31). [PROVEN]
15. Edit - updateFields gates allowed keys by mode: legacy = schema keys only; dynamic = stored
    produced keys that pass safeFieldKey (service.ts:369-372); dynamic edits keep persisted
    type/label (service.ts:386-389). [PROVEN]
16. Replace - preserves the stored mode into the re-run (service.ts:495). [PROVEN]
17. UI - ReviewWorkspace fieldLabel = schema label, else persisted label, else humanize (src/app/
    (dashboard)/documents/page.tsx:818-821). Dynamic fields have no schema group, so they render
    under "Other" (page.tsx:834-835). Missing banner never shows in dynamic (missing is empty).
    [PROVEN]

---

## 3. SuperPay root-cause trace (items A-J)

Anchored to committed artifacts (benchmarks/results/pipeline-level.json "real-superpay" old+new,
benchmarks/results/ocr-level.json "real-superpay", tests/fixtures/receipt-ocr.ts) and current
source. The committed OCR surface (tests/fixtures/receipt-ocr.ts:7-24) is the production photo
(photo_2026-08-02_12-59-10.jpg), bidi controls dropped, everything else preserved.

### A. "60 SuperPay eX" as the review title
- Title = job.sourceText?.slice(0, 60) in ReviewWorkspace (documents/page.tsx:851); the DocRow
  fallback is slice(0, 40) (page.tsx:689). sourceText is the OCR-derived surface (PIPELINE_VERSION
  2, Arabic-first repaired; src/lib/pipeline/constants.ts:11). [PROVEN] mechanism
- The header content "60 SuperPay ..." comes from the bidi-garbled first OCR line "له SuperPay 60"
  (tests/fixtures/receipt-ocr.ts:8) whose Latin digit tail renders leftmost; word reconstruction
  confirms "60 SuperPay له" order (tests/arabic-ocr.test.ts:164). [PROVEN] the source line exists;
  [UNKNOWN] whether the runtime pass literally produced "eX" vs "له" (that exact surface is not
  persisted; the "eX" is consistent with a bidi/rendering artifact of the same region).
- Verdict: the pipeline's role is the slice, nothing more. No title-from-fields exists. [PROVEN]

### B. "15468" merged into the header
- Same title slice; "La 15468" / "LL 15468" is the second OCR line (tests/fixtures/receipt-ocr.ts:9,
  tests/live/verify-fresh-ocr.ts:19). [PROVEN] source line exists; [UNKNOWN] exact runtime spacing.

### C. Receipt number misread ("La 15468")
- Committed real-superpay.new: receipt_number = "La 15468", raw "La 15468", status extracted,
  reasons [ocr_confidence_low, label_not_matched], evidence quote "La 15468"
  (benchmarks/results/pipeline-level.json:2114-2128). The model read the terminal-code line as the
  receipt number; grounding anchored it verbatim (value-match, grounding.ts:276-301). [PROVEN]
- The true receipt identifier is not printed under any "receipt number" label; the closest line is
  "رقم التمليه : 6070218301132167" (fixture line 12). The old engine surfaced that as receipt_number
  (pipeline-level.json:1947-1958); the new engine grounds whatever the model quoted. Both readings
  are semantically wrong. [PROVEN]
- Grounding cannot fix this: it never rewrites a verbatim-grounded value. [PROVEN]

### D. Transaction / reference / customer / mobile numbers not discovered
- Legacy mode: normalizeFields iterates profile.schema.fields ONLY (normalizer.ts:35-54); any key
  the model returns that is not in the schema is silently discarded. The receipt schema has no
  transaction_number / reference_number / account_number / customer_mobile / customer_number fields
  (src/lib/pipeline/profiles/receipt.ts:5-28). [PROVEN]
- Therefore: "رقم التمليه : 6070218301132167" (transaction number, fixture line 12) -> discarded;
  "الرقم المرجقي : 2013438351" (reference number, fixture line 15) -> discarded;
  "رقم العميل : 9840833767" (customer mobile, fixture line 17) -> discarded. [PROVEN] structurally
- "رقم الحساب : 391003452" (account number, fixture line 14) is not discarded - it is misassigned
  to pos_number because the pos label group contains "الحساب"/"حساب"
  (src/lib/pipeline/extractor/label-lexicon.ts:111-113) and pos_number maps to group "pos"
  (label-lexicon.ts:130). Committed new run: pos_number = "391003452"
  (pipeline-level.json:2197-2209). [PROVEN]
- Net: 3 of the document's 4 identifier types are unreachable in legacy mode; the 4th lands on the
  wrong key. [PROVEN]

### E. "Missing required fields: Merchant / store name"
- merchant_name is required (receipt.ts:8; validation rule receipt.ts:89). Grounding dropped it
  (see H). validateExtraction -> missing = ["merchant_name"] (src/lib/pipeline/validator.ts:34-46).
  Committed new run: validation { ok:false, missing:["merchant_name"] }
  (pipeline-level.json:2093-2097). [PROVEN]
- UI: banner when missing.length > 0 (documents/page.tsx:890-894); fieldLabel resolves to the
  schema label "Merchant / store name" (page.tsx:818-821, receipt.ts:8); message
  "Missing required fields: {{fields}}" (src/lib/i18n/locales/en.json:34). [PROVEN]

### F. Title concatenation
- Header = sourceText.slice(0, 60) (page.tsx:851); row = slice(0, 40) (page.tsx:689). No
  field-derived title, no cleaning, no humanization. [PROVEN]

### G. Broken line_items "oe a : il"
- Model emitted 3 items (committed dump pipeline-level.json:2212-2231). Grounding:
  looksLikeItemizedList short-circuits true because items.length >= 2 (grounding.ts:613-631, line
  618). Cleaner (entity-cleaner.ts:237-273): "Hostinger;Description;)0123456788(" ->
  isNoiseFragment true (oversized letter+digit token, src/lib/pipeline/text-quality.ts:65) ->
  removed; "x PURCHASE" -> isGenericItemDescription true (/purchase/,
  src/lib/pipeline/extractor/grounding.ts:50-60) -> removed; "oe   a           : il" has letters, is
  not generic, is not noise, and grounds verbatim to its own OCR line
  (tests/fixtures/receipt-ocr.ts:20) via appearsInOcr (entity-cleaner.ts:482-504) -> KEPT. Final =
  [{ description: "oe a : il", quantity:null, unit_price:null, amount:null }] - exactly the
  production value. [PROVEN] end-to-end (fixture + current code)
- Note: the committed dump still shows all 3 items because that trace predates the cleaner's
  line-item gate (committed at 9135a40, pre-M13). Current code yields the single kept item.
  [PROVEN] for current code; [INFERRED] that production ran current code.

### H. merchant_name drop root cause
- Supersedes the post-M12 report's Part 2. Re-verified against current source:
- Candidate produced: extract.fields = 16 means every schema key (incl. merchant) held a non-empty
  candidate after normalization (candidateFields only pushes truthy map[key],
  src/lib/pipeline/extractor/index.ts:110-129; committed traces pipeline-level.json:2048 for the
  old run and :2253 for the merchant-missing new run - both fields:16). [PROVEN] AI produced the
  value; grounding killed it.
- Evidence discoverable: "SuperPay" normalizes to "superpay" and is a substring of the normalized
  line "له superpay 60" (normalizeText drops bidi controls + lowercases,
  src/lib/pipeline/ocr.ts:34-44); findEvidence therefore returns a span (grounding.ts:276-301).
  [PROVEN]
- Label verdict: the line has no merchant lexicon word (merchant group = التاجر|البائع|المورد|
  المحل|الشركة|merchant|seller|vendor|store|trading, label-lexicon.ts:99-101) -> verdict neutral,
  not conflict (grounding.ts:550-561) -> survives Pass 1. [PROVEN]
- Pass 2: labelFactor = 0.8 (LABEL_NEUTRAL_FACTOR, grounding.ts:589-596). aiConf from the model;
  ocrFactor = mean evidence-word confidence (grounding.ts:576-586). [PROVEN] formula
- Pass 3: confidence < 0.3 (MIN_CONFIDENCE, grounding.ts:225-241) -> drop reason
  "confidence below threshold (x.xx)" (grounding.ts:236). [PROVEN]
- Cross-check artifact: real-superpay.old kept merchant "SuperPay" at 0.744 with only
  label_not_matched (pipeline-level.json:1973-1986) - proving the label-less penalty alone (0.8)
  does not always kill; the kill needs aiConf * ocrFactor low as well. Exact runtime component
  values are not persisted. [PROVEN] old artifact; [UNKNOWN] exact new-run components
- Recovery cannot rescue: FIND arm searches label words + field label phrase (verify-or-find.ts:
  178-217); no merchant word exists anywhere in the OCR (fixture lines 7-24) -> zero candidates
  (recovery.ts:59-97). Cross-provider retry gate accepts only drop reasons "not found in document"
  and "empty value" (stages/recover.ts:187-203); "confidence below threshold" is NOT eligible ->
  retryAttempted false (committed new-run trace pipeline-level.json:2266-2271). [PROVEN]

### I. Non-discovery root cause (see D) - structural schema filtering, not AI failure. [PROVEN]

### J. Recovery / retry never fire for this drop (see H) - no label word AND retry gate excludes the
reason. [PROVEN]

---

## 4. Proven schema leaks into dynamic mode

Catalog of every place profile.schema still reaches dynamic-mode execution. Severity ordered.

1. [P0] Recovery injects schema-required fields (hard contract violation).
   recoverMissingFields iterates profile.schema.fields required keys (recovery.ts:59-60) in ANY
   mode; applyRecovery commits flagged/ambiguous schema-typed fields (stages/recover.ts:82-85).
   Deterministic on the SuperPay fixture OCR (tests/fixtures/receipt-ocr.ts), so a dynamic run on
   it today would inject - independently of what the AI discovered:
   - receipt_number = "6070218301132167" (flagged): "التمليه" is in the number group
     (label-lexicon.ts:27) and the fixture line 12 matches; textCandidates extracts the value
     (verify-or-find.ts:339-372).
   - receipt_date = "2028-07-02" (flagged): "الوقت" is in the date group (label-lexicon.ts:44) and
     appears inside fixture line 13 "تبيخ الوقت : 02-07-2028 18:30:12"; dateCandidates extracts
     the OCR-misread year (verify-or-find.ts:270-282, coerce toDate in normalizer.ts:167-192).
   - total_amount = 68.38 (flagged): "المطلوب" is in the total group (label-lexicon.ts:83) and
     fixture line 22 matches.
   - merchant_name: NOT injectable (no merchant lexicon word exists anywhere in the OCR).
   [PROVEN] code path + deterministic fixture trace; the exact runtime run has not happened yet.
2. [P0] Cross-provider retry is schema-gated. retryEligibleRequiredFields iterates schema required
   keys (stages/recover.ts:187-203); in dynamic mode a retry would target schema keys, not
   discovered keys. [PROVEN]
3. [P1] Universal semantic checks are keyed on field.key and fire for dynamic fields whose safe key
   collides (grounding.ts:94-128): a discovered "currency" field is dropped when no currency marker
   exists; any "*_tax_id" key needs a tax keyword; "line_items" needs an itemized list; type "text"
   must pass isNoiseFragment. [PROVEN]
4. [P2] labelConfidenceFactor / labelGroupForField apply key-suffix defaults to dynamic fields
   (label-lexicon.ts:121-135; grounding.ts:589-596): a discovered field safe-keyed "merchant_name"
   on a label-less line gets the 0.8 neutral penalty. Minor, arguably intended. [PROVEN]
5. [P2] Entity cleaner skips dynamic fields entirely (entity-cleaner.ts:83 iterates schema fields):
   no name-trim, no free-text gate, no line-item gate for discovered values. Coverage gap, not a
   leak. [PROVEN]
6. [P3] Exporter filename is profile-derived (exporter.ts:30-31) even in dynamic mode. [PROVEN]
   Benign.
7. [OK] validator neutral (validator.ts:22-24), dynamic CSV columns produced-only (exporter.ts:
   113-118), edit key gate mode-aware (service.ts:369-372), rebuild keeps persisted type/label
   (service.ts:636-649). [PROVEN]

---

## 5. Reusable infrastructure (verified working, reuse for M22 implementation)

- dynamic.ts: safeFieldKey (deterministic snake_case, prototype-key block),
  parseDynamicExtraction (fail-safe parse), fieldSchemaForDynamicField (per-field compatibility
  adapter), DEFAULT_DYNAMIC_FIELD_CONFIDENCE = 0.85. [PROVEN]
- prompt-builder.ts: buildDynamicPrompt + DYNAMIC_OUTPUT_CONTRACT (schema-free, verbatim raw +
  evidence). [PROVEN]
- normalizer.ts: normalizeDynamicFields (preserves discovered keys + meta). [PROVEN]
- grounding.ts: schema-free evidence anchoring (findEvidence/valueNeedles/derivedVariants),
  dynamic skip of relabel veto (grounding.ts:186-188), enumerateFields schema-first-then-dynamic
  (grounding.ts:262-274). [PROVEN]
- verify-or-find.ts: deterministic verification tiers + label-driven FIND shared by grounding and
  recovery. [PROVEN]
- validator.ts: dynamic neutral path (validator.ts:22-24). [PROVEN]
- exporter.ts: dynamic CSV produced-columns (exporter.ts:113-118). [PROVEN]
- service.ts: extraction_mode persistence, serializeFields with type/label, rebuildExtraction
  restoring persisted type/label, mode-aware updateFields and replace. [PROVEN]
- layout-aware-evidence.ts: layout ladder evidence provider + OCR-only fallback (fallback keeps
  behavior identical when layout is unavailable). [PROVEN]
- Test double pattern: tests/m21-dynamic-lifecycle.test.ts FakeQuery / fakeSupabase (probe version
  adds insert + flush on .single()/.maybeSingle()). [PROVEN]

---

## 6. Required changes (mode-gating, nothing else)

Gate by extractionMode at the exact leak points; do NOT redesign stages.

1. recovery.ts recoverMissingFields: when extraction.extractionMode === "dynamic", skip the
   schema-required iteration entirely (return empty). [PROVEN leak]
2. stages/recover.ts retryEligibleRequiredFields: return [] in dynamic mode (schema-required retry
   is meaningless for discovered fields). [PROVEN leak]
3. entity-cleaner.ts cleanExtraction: in dynamic mode, iterate the extraction's own fields
   (dynamic synthesized schema) so name-trim / free-text / line-item gates apply to discovered
   values too - using the same metadata-driven rules, never schema keys. [PROVEN gap]
4. grounding.ts universal key-based semantic checks (currency / *_tax_id / line_items / notes /
   type text): in dynamic mode, apply ONLY when the field is a schema field (dynamic:false in the
   enumerateFields result). [PROVEN leak]
5. Add observability: serialize droppedFields with per-field drop reasons into trace_json
   (service.ts:193-213 + trace shape) so the next forensic cycle reads the DB row instead of
   code-tracing. Addresses the P2 diagnostic blindness proven in the M12 report. [PROVEN gap]
6. UI (page.tsx) title: for dynamic extractions prefer a discovered title-ish field (first
   discovered string field whose value is grounded, or the document's own first line) over the raw
   sourceText slice; keep legacy behavior unchanged. [PROVEN gap]
7. UI missing banner + confidence breakdown: unchanged for legacy; for dynamic, the missing banner
   never appears (missing is empty) - keep. No change needed except title. [PROVEN]

Everything else in the lifecycle is already mode-correct (prompt, normalize, validate, export,
edit, replace, persist).

---

## 7. Proposed discovery contract (internal, additive)

Keep DynamicFieldSpec (dynamic.ts:21-44) and add the anchored variant used downstream so every
discovered value is a grounded entity, not an AI guess:

- key: string (safeFieldKey result)
- label: string (AI label or humanizeKey fallback)
- type: FieldType (AI-declared or inferred)
- group?: string (AI semantic hint; informational only)
- value / raw: unknown (value preserved; meaning NOT inferred by the normalizer)
- confidence: number (informational until grounding recomposes)
- evidence: FieldEvidence[] (set by grounding; empty until anchored)
- status: "extracted" | "flagged" | "ambiguous" (from grounding/recovery)
- reasons: UncertaintyReason[] (from grounding)

Contract rules:
- A discovered field is committed ONLY if grounding anchors its value verbatim (or via the
  deterministic verify/find tiers). No fuzzy matching, nothing invented. [reuses grounding]
- Dynamic mode has NO required fields; validation stays neutral. [already true]
- Recovery may never inject a schema key into a dynamic extraction. [fix 6.1/6.2]
- The schema is never consulted for dynamic field semantics beyond the universal safety checks on
  schema fields. [fix 6.4]

---

## 8. Grounding / validation / confidence design

- Grounding stays the single authority for both modes. Dynamic fields: evidence anchoring
  verbatim, skip relabel veto, apply OCR/label confidence factors. [unchanged behavior]
- Validation: neutral in dynamic mode (no required keys). [unchanged]
- Confidence: keep the composed per-field formula and the multi-signal combine. Dynamic fields
  carry no required/crossCheck weights; consider dropping the label-neutral 0.8 penalty ONLY for
  dynamic fields whose evidence line is label-less AND whose value is anchored to a single OCR
  line with acceptable OCR confidence - to be decided during implementation with a test proving it
  does not weaken legacy. [INFERRED direction; decision deferred to implementation phase]
- The SuperPay merchant case (legacy) stays a legacy-mode behavior; the recommended remediation
  for that document class is re-running in dynamic mode after 6.1/6.2 are fixed. [INFERRED]

---

## 9. Persistence / UI / export impact

- Persistence: extraction_mode already persisted (service.ts:199; supabase/pipeline.sql:118-119).
  Add droppedFields to trace_json (6.5). No migration needed for existing rows (mode defaults to
  legacy). [PROVEN]
- UI: title change (6.6) is dynamic-only and additive. Dynamic fields already render with
  persisted labels under "Other". [PROVEN]
- Export: dynamic CSV/JSON already produced-keys only. Adding droppedFields to trace does not
  change export formats. [PROVEN]

---

## 10. Legacy compatibility

- All fixes are gated on extractionMode === "dynamic" or additive. Legacy path (normalizeFields,
  grounding with schema labels, clean, recover, validate, export columns, edit keys, replace) is
  byte-identical. [PROVEN] by construction; regression suite must confirm.
- One exception to decide: 6.4 changes the universal semantic checks to skip dynamic keys only -
  legacy untouched. [PROVEN]
- Existing legacy records keep their mode "legacy"; no re-run required. [PROVEN]

---

## 11. Acceptance criteria

1. Dynamic extraction of the SuperPay OCR surface (fixture) yields discovered fields for the
   transaction number, reference number, account number and customer mobile - all grounded with
   verbatim evidence. [INFERRED achievable; must be proven by a test]
2. Dynamic extraction of the same surface does NOT contain receipt_number / total_amount /
   merchant_name schema keys injected by recovery. [must be proven]
3. Dynamic extraction has validation.ok true and missing [] always. [already true]
4. All 705 existing tests pass unchanged; npx tsc --noEmit clean; npx eslint 0 errors.
5. Live probe (dynamic run -> export -> edit -> reload) passes unchanged after 6.1-6.4.
6. trace_json contains droppedFields with per-field reasons after 6.5.
7. Legacy SuperPay benchmark re-run is unchanged in behavior (or strictly better, provably so).

---

## 12. Test plan

- Unit: recovery in dynamic mode returns nothing (recovery.ts / stages/recover.ts).
- Unit: entity cleaner applies to a discovered string/text field in dynamic mode (name-trim,
  free-text gate) and still skips nothing legacy.
- Unit: grounding universal checks skip dynamic keys in dynamic mode (a discovered "currency"
  field with no currency marker survives).
- Integration: dynamic run over tests/fixtures/receipt-ocr.ts text; assert discovered keys
  (transaction_number / reference_number / account_number / customer_mobile present with evidence,
  grounded verbatim) and NO injected schema keys.
- Integration: rebuild/export/edit/replace round-trip for a dynamic result with discovered fields
  (extend tests/m21-dynamic-lifecycle.test.ts double with the recover/clean stages).
- Live: tests/live/verify-recovery.ts style run over the real SuperPay image in dynamic mode
  (gated on env/providers as today).
- Regression: full node tests/run.mjs; npx tsc --noEmit; npx eslint.

---

## 13. Risks

- [R1] Entity cleaner on dynamic fields could drop legitimate discovered text values if the
  free-text gate misfires; mitigates by reusing the SAME metadata-driven rules already proven for
  legacy and requiring re-grounding before any drop. [INFERRED]
- [R2] Dropping the 0.8 label-neutral penalty for dynamic fields (if pursued) could let weakly
  anchored values through; mitigation: keep it unless a test proves a strict-grounded single-line
  value survives with acceptable OCR confidence. [INFERRED]
- [R3] trace_json growth from droppedFields: bounded (one entry per dropped key). [INFERRED]
- [R4] UI title change (6.6) is cosmetic; wrong choice of "title-ish field" is a display issue,
  not a data issue, and stays reversible. [INFERRED]

---

## 14. What NOT to change

- Do NOT change the OCR layer (bidi repair, word reconstruction) in this milestone.
- Do NOT add fuzzy matching, "best guess" repair, or value rewriting to grounding.
- Do NOT change the legacy prompt, schema, profile plugins, or the legacy normalize/ground/clean/
  recover/validate/export/edit behavior.
- Do NOT add multi-OCR arbitration or external OCR engines.
- Do NOT redesign the review UI; title change is additive and dynamic-only.
- Do NOT create a field registry or make dynamic fields first-class in profile.config.

---

## 15. Implementation plan (post-approval; ordered, each step verified)

Phase 0 - Baseline: run node tests/run.mjs, npx tsc --noEmit, npx eslint; capture
tests/run.mjs result and the current dynamic probe result. [baseline = 705 passing]
Phase 1 - Mode-gate recovery + retry (6.1, 6.2) with unit tests.
Phase 2 - Dynamic entity cleaner pass (6.3) with unit tests.
Phase 3 - Dynamic semantic-check gating (6.4) with unit tests.
Phase 4 - droppedFields in trace_json (6.5) with a persistence test.
Phase 5 - Dynamic title in review UI (6.6) with a client-side test if harness exists.
Phase 6 - Integration + live tests over the SuperPay fixture and (env-gated) real image in
dynamic mode; verify acceptance criteria 1-3.
Phase 7 - Full regression (criterion 4), live probe (criterion 5), SuperPay legacy re-benchmark
(criterion 7); write M22-COMPLETION-REPORT.md; NO commit/push without explicit request.

---

## 16. Unknowns / limitations

1. Exact runtime drop reason and confidence components for the production merchant drop
   (droppedFields not persisted). [UNKNOWN]
2. Whether the production pass ran pipeline version 1 or 2 OCR surface (title "60 SuperPay eX").
   [UNKNOWN]
3. Exact character-level production of "eX" in the header vs the committed "له SuperPay 60".
   [UNKNOWN]
4. Whether layout (M11) succeeded on the runtime image; either way the OCR-only fallback preserves
   the same evidence behavior for the merchant line. [UNKNOWN]
5. Exact model raw JSON of the production dynamic run (none exists yet - dynamic is new).
   [UNKNOWN]
6. Whether the dynamic mode will discover all four SuperPay identifier types with a pinned stub
   model; predicted by label presence but must be proven by test. [INFERRED]
