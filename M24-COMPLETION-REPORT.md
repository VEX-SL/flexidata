# M24 — Raw AI Observability Completion Report

## Summary

M24 implements raw AI response persistence for forensic observability. The raw AI provider response is now captured **before** parsing, normalization, and grounding, and persisted with each extraction run. This enables future investigations to determine exactly where fields disappear in the pipeline.

---

## Files Changed

### 1. Database Schema — `supabase/pipeline.sql`
```sql
ALTER TABLE public.extractions ADD COLUMN IF NOT EXISTS raw_ai_response TEXT;
```
- **Type**: `TEXT` (chosen deliberately over JSONB — we only store the raw AI content string)
- **Idempotent**: Safe to run on existing databases
- **No secrets**: Contains only AI-generated content (no prompts, API keys, credentials)

### 2. Type Definition — `src/lib/pipeline/types.ts`
```typescript
export interface ExtractionResult {
  // ... existing fields ...
  /** Raw AI provider response content (pre-parser/normalizer/grounding). */
  rawAIResponse?: string;
}
```

### 3. Capture Point — `src/lib/pipeline/extractor/index.ts`
Modified `candidatesFromAICall()` to attach the raw AI response to the returned `ExtractionResult`:
```typescript
return {
  // ... existing fields ...
  rawAIResponse: aiCall.content,  // <-- captured HERE, before parseRaw/normalize/ground
};
```
- **Exact capture point**: Immediately after `extractWithAI()` returns, before `parseRaw()` / `normalizeDynamicFields()` / `groundExtraction()`
- Applies to **both** `legacy` and `dynamic` extraction modes
- Propagates through `groundExtraction()` via spread operator (`...extraction`)

### 4. Persistence — `src/lib/pipeline/service.ts`
Added `raw_ai_response` to the completion payload:
```typescript
const payload = {
  // ... existing fields ...
  raw_ai_response: extraction.rawAIResponse ?? null,
  // ...
};
```
- Stored as `TEXT` in `extractions.raw_ai_response`
- `null` if not present (backward compatible)
- Written on both success and error paths (error path inherits `out.trace` which contains the raw response via `extraction.rawAIResponse`)

### 5. Unit Tests — `tests/extractor-raw-response.test.ts`
6 tests covering:
- `candidatesFromAICall` captures raw response in **dynamic** mode
- `candidatesFromAICall` captures raw response in **legacy** mode
- `extractDocument` returns raw response with `grounded: false` (dynamic)
- `extractDocument` returns raw response with `grounded: false` (legacy)
- `extractDocument` returns raw response after **grounding** (dynamic)
- `extractDocument` returns raw response after **grounding** (legacy)

### 6. Integration Tests — `tests/service-raw-response.test.ts`
3 tests covering:
- Service persists `raw_ai_response` in **dynamic** mode
- Service persists `raw_ai_response` in **legacy** mode
- `JobDTO` **does not expose** `rawAIResponse` / `raw_ai_response` publicly (internal only)

---

## Verification Results

| Check | Result |
|-------|--------|
| Full test suite (718 tests) | �� **718/718 passed** |
| TypeScript compile (`tsc --noEmit`) | �� **No errors** |
| ESLint (touched files) | �� **No errors** |
| M22 discovery acceptance tests | �� All pass |
| Dynamic extraction tests | �� All pass |
| Legacy extraction tests | �� All pass |
| Service persistence tests | �� All pass |

---

## Security Considerations

| Aspect | Status |
|--------|--------|
| API keys / secrets in raw response | **NOT PRESENT** — only AI content, model name, provider name |
| Prompt content stored | **NO** — only AI response `content` |
| RLS protection | **YES** — `extractions` table has `auth.uid() = user_id` policy |
| Public API exposure | **NO** — `toJobDTO()` does not include `rawAIResponse` |
| Retry history | **OUT OF SCOPE** — only final successful response captured (M24 scope) |

---

## Explicit Confirmations

| Requirement | Confirmed |
|-------------|-----------|
| Grounding logic **NOT modified** | �� `grounding.ts` untouched |
| OCR processing **NOT modified** | �� `ocr.ts` untouched |
| Prompt semantics **NOT modified** | �� `prompt-builder.ts` untouched |
| Normalization behavior **NOT modified** | �� `normalizer.ts`, `dynamic.ts` untouched |
| Validation logic **NOT modified** | �� `validator.ts` untouched |
| Confidence algorithms **NOT modified** | �� `confidence.ts` untouched |
| Legacy mode behavior **UNCHANGED** | �� Same code path, just captures raw response |
| Dynamic mode behavior **UNCHANGED** | �� Same code path, just captures raw response |
| Fuzzy matching added | �� **NO** — grounding remains strict verbatim |
| Python OCR added | �� **NO** — out of scope |
| Recovery logic modified | �� **NO** — out of scope |
| Public UI endpoint added | �� **NO** — internal observability only |

---

## Remaining Limitations

1. **Historical runs**: Existing extractions (pre-M24) will have `NULL` in `raw_ai_response` — only new runs capture it
2. **Cross-provider retries**: If `extractWithAIRetry` is used, only the final successful response is stored (failed attempts not captured) — acceptable for M24 scope
3. **Streaming responses**: Not applicable — pipeline uses non-streaming `chatCompletion`
4. **Large responses**: No truncation — very large AI responses could hit storage limits (unlikely with 4096 maxTokens)

---

## Next Steps (M25+)

With M24 complete, future forensic investigations can now:
1. Query `raw_ai_response` from `extractions` table for any production run
2. Compare AI output → parser → normalizer → grounding → validation chain
3. Definitively determine whether field loss occurs in AI discovery or downstream

This resolves the **P1: AI Discovery UNKNOWN** blocker identified in M23.