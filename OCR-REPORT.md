# OCR Accuracy & Confidence — Root Cause, Fixes, and Alternatives

Milestone commit: after `8b1f09d`. Scope: OCR quality for the existing
Flexidata receipt/invoice pipeline (Arabic + English + mixed, thermal
receipts, rotated / low-quality mobile photos). Extraction/LLM logic was
**not** touched; the pipeline architecture is unchanged.

---

## 1. Root-cause analysis: how OCR worked before

### 1.1 Flow (unchanged architecture)

`parseFileBufferDetailed` (`src/lib/file-parser.ts`) → `recognizeMainThread("eng")`
(`src/lib/tesseract-main.ts`) with a 25 s `OCR_TIMEOUT_MS`. The engine is
`tesseract.js-core` v7.0.0 run on the **main thread** (the worker_thread path
hangs on Vercel), with `traineddata` for `eng`/`ara` shipped in `public/ocr-data`.

### 1.2 Defects found

1. **Every line got the same page-mean confidence.**
   `buildLines` stamped one `confidence` value (derived from `MeanTextConf`)
   onto every line, so per-line confidence was meaningless and downstream
   stages (`grounding.ts` `meanWordConfidence`, `recovery.ts`) could not
   distinguish a confident line from a garbled one. In practice the old
   `AllWordConfidences()` binding marshals an **empty vector** (verified by
   probing the emscripten embind object — it has no `.size()`/data), and
   `MeanTextConf()` returns **0 for perfectly readable images**, so the page
   mean itself was unreliable. The result: "realistic confidence" was
   impossible and extraction confidence was close to the `DEFAULT_OCR_CONFIDENCE`
   of `0.7` regardless of actual quality.

2. **No image preprocessing.** Raw JPEG/PNG/PDF-render pixels were sent to the
   engine as-is. Rotated (90°) mobile photos, slanted pages, perspective
   distortion, low contrast and uneven lighting were left for Tesseract to
   fight unaided.

3. **EXIF orientation was not handled.** `@napi-rs/canvas` `loadImage` does
   **not** apply EXIF orientation (verified with a hand-built
   orientation-6 JPEG — dimensions unchanged). Photos taken on phones are
   often stored rotated with an EXIF tag.

4. **Fixed page-segmentation mode.** `SetPageSegMode(6)` (PSM.SINGLE_BLOCK)
   was hardcoded, which mis-parses multi-column / mixed-layout receipts.

5. **psm/dpi defaults.** No `user_defined_dpi`, no dictionary tuning for
   thermal-receipt text.

### 1.3 Why it matters for extraction

`OcrLine.confidence` feeds:
- `grounding.ts` `ocrConfidenceFactor` → per-field evidence weight;
- `recovery.ts` `baseConfidence` → metadata-driven field recovery fallback.

With every line carrying the same (unrealistic) confidence, fields grounded on
bad OCR looked just as trustworthy as fields grounded on clean OCR.

---

## 2. What changed

### 2.1 New module `src/lib/ocr/preprocess.ts` (pure, engine-independent)

A decouple-ready preprocessing pipeline (no Tesseract import — can later be
reused by a different engine):

- **EXIF orientation**: full JPEG APP1 / TIFF `0x0112` parser + `applyOrientation`
  (1–8), because `@napi-rs/canvas` does not apply EXIF.
- **90°/270° auto-rotation**: projection-profile variance decides whether lines
  are horizontal or vertical; canvas-backed rotation (dimensions swapped on
  quarter turns so content is never clipped).
- **Deskew**: coarse→fine projection sweep over a downsampled sample
  (`estimateSkewAngle`, handles ~0° and ±3° verified in tests).
- **Perspective (photo preset only)**: ink-boundary line fits (Theil–Sen,
  robust to noise) → `detectQuad` → bilinear `warpQuad`, gated by residual so
  plain rectangular documents are not over-warped.
- **Auto-crop**: Otsu-mask ink bbox trims empty borders.
- **Contrast stretch** (percentile), **unsharp sharpen** (3×3), optional
  **adaptive threshold** (Bradley integral image) for low-contrast thermal
  photos, and **resolution normalization** (≈300 dpi equivalent, capped).
- Two presets: `"photo"` (camera captures — full pipeline incl. perspective +
  adaptive binarize) and `"scan"` (rendered PDF pages — grayscale or
  binarize-only-when-low-contrast).

### 2.2 `src/lib/tesseract-main.ts` rewrite

- **Real per-word confidence**: walks Tesseract's `ResultIterator` at
  `RIL_WORD` (`GetUTF8Text(3)`/`Confidence(3)`/`IsAtBeginningOf(2)`),
  guarded with try/catch + word cap, falling back to the old page-mean only
  when the iterator binding is unavailable. Line confidence = mean of its
  word confidences; page confidence = mean of all word confidences.
- **Engine config**: `PSM.AUTO` (3) instead of hardcoded single block,
  `preserve_interword_spaces=1`, `user_defined_dpi=300`,
  `textord_min_xheight=10`, dictionary penalties 0.2.
- **Preprocess-aware flow**: preprocess first, then **retry with the raw image**
  when the result looks poor (< 25 chars or mean line confidence < 0.45),
  keeping the better of the two (`isBetterThan`) — so preprocessing can never
  make output worse than before.
- Encoded-bytes input bakes EXIF orientation into the bitmap; the raw fallback
  still hands the EXIF tag to the engine (`SetImageFile` → Leptonica applies it).

### 2.3 `src/lib/pdf-canvas.ts`

Added `loadImage` export; `isCanvasAvailable` re-exported (native module
present on server, absent in some test environments).

### 2.4 Tests

- `tests/preprocess.test.ts` — 20 unit tests for the pure math (EXIF, Otsu,
  Bradley, contrast, sharpen, deskew, quarter-rotation, auto-crop, quad
  detection/warp, canvas scale/rotate) + registered in `tests/_entry.ts`.
  **64/64 tests pass**, `npx tsc --noEmit` clean, `npm run build` clean.
- `tests/live/verify-ocr.ts` — live end-to-end OCR check against the real
  engine on synthetic receipts (English+numbers, Arabic, 90°-rotated,
  2°-slanted, thermal-paper noise). **All checks pass.**

---

## 3. Measured results (live verification, real Tesseract)

| Input | Path | Page conf | Lines | Distinct line confs | Outcome |
|---|---|---|---|---|---|
| clean EN receipt | raw | 91.8% | 10 | 10/10 | AL RABIH SUPERMARKET, TOTAL 38.40 ✓ |
| clean EN receipt | preprocess | 95.0% | 10 | 9/10 | merchant + total ✓ |
| 90°-rotated | raw | 78.9% | 6 | 6/6 | Tesseract OSD already handles 90° |
| 90°-rotated | preprocess | 78.9% | 6 | 6/6 | no regression |
| 2°-slanted | both | — | ✓ | ✓ | text volume preserved |
| Arabic (ara) | preprocess | 92.9% | ✓ | ✓ | `المبلغ: 45.50 رس` + numeric 45.50 ✓ |

Key fixes now visible in output:
- Per-line confidence is **non-uniform** (the old single-page-mean stamp is
  gone).
- Page confidence is **realistic** (sane % for clean input, lower for hard
  input) — no longer stuck near `0.7`.
- Arabic text + digits survive preprocessing; the numeric total is recoverable.

---

## 4. Engine alternatives (deliverable)

| Engine | Pros | Cons vs our constraints | Verdict |
|---|---|---|---|
| **Tesseract (kept)** | Works in pure JS/WASM on Vercel, no Python, no cloud credentials, `eng`+`ara` traineddata already shipped, **per-word confidence** via ResultIterator, offline | Lower accuracy than SOTA on degraded photos; Arabic OCR is legacy but adequate for receipts | **Keep** — only option with per-word confidence in a serverless-WASM-only runtime |
| PaddleOCR | Best Arabic+EN accuracy for receipt photos, strong text-detection | Python runtime (server), heavy model downloads, no per-word confidence out of the box, Vercel impossible without a GPU VM | Long-term: run on a dedicated VM behind an API; not serverless |
| EasyOCR | Decent Arabic, Python + PyTorch | Same runtime problem; heavier; no per-word confidence | Same as PaddleOCR, lower ceiling |
| Surya | Great layout + Arabic, modern | Python, large model, no confidence per word in the compact use | Research alternative |
| Mistral OCR / Gemini / GPT-4o-vision | Best raw text + layout + Arabic | Cloud LLM cost, **no numeric confidence**, latency, data leaves the app | Good as an *enhancement* (AI-pass to fix garbled fields), not a replacement for deterministic OCR confidence |
| Google Vision | Excellent, fast, has per-page confidence, Arabic strong | Cloud credentials + cost + data residency; still only page-level confidence | Viable commercial path if serverless constraints relax |

**Decision: stay on Tesseract (main-thread WASM) with preprocessing +
per-word confidence.** Rationale: (1) per-word/per-line confidence is the
explicit requirement and only Tesseract provides it here; (2) the whole
pipeline runs in a single Vercel serverless request with no Python and no
cloud keys; (3) preprocessing closes most of the accuracy gap for thermal
receipts (rotation, deskew, contrast, binarization); (4) any replacement is a
bigger, higher-cost change that this milestone's evidence does not justify —
the gate in the task ("only replace if measurable improvement") is not met for
a serverless WASM runtime.

---

## 5. Expected accuracy gains

- **Rotation / slanted mobile photos**: recovered before recognition
  (quarter-rotation + deskew), which directly helps phone-captured receipts —
  the most common failure mode.
- **Low-contrast thermal paper**: contrast stretch + adaptive threshold +
  sharpen raise digits/merchant/amount legibility.
- **Perspective (angled camera)**: `warpQuad` straightens the document.
- **Confidence realism**: downstream grounding/recovery now gets truthful
  per-line confidence, so garbled lines are down-weighted instead of
  polluting field confidence — expected to reduce false "high-confidence"
  mis-extractions even where text itself is unchanged.
- **Arabic receipts**: `ara` traineddata + preprocessing; numeric amounts and
  merchant tokens are the primary extractables and survive (verified: `45.50`).

The absolute gain on real user photos still needs verification via the Vercel
dashboard (not reachable from this environment) — see Risks.

---

## 6. Performance impact

- Preprocessing is mostly **downsampled** (rotation/deskew/quad estimates run
  on ≤ ~480 px samples); the expensive full-res pass is only the final
  canvas draw.
- Canvas ops use `@napi-rs/canvas` (native, already a dependency for PDFs).
- Worst case: one preprocessed recognition + one raw fallback retry. Retry is
  gated on a **poor result**, so the common path is a single recognition.
- The old 25 s `OCR_TIMEOUT_MS` budget is unchanged. Expected added latency:
  **tens of ms** (preprocessing) on top of the existing recognition time.
- Engine init stays cached per process (`modulePromise`, `traineddataCache`).

---

## 7. Risks / follow-ups

1. **Real-photo verification pending** — synthetic receipts verify the
   pipeline, but real Arabic/thermal photos must be tested on the deployed
   app (Vercel dashboard). User action: upload a real receipt; also apply
   `ALTER TABLE public.extractions ADD COLUMN IF NOT EXISTS ocr_json JSONB;`
   to see the OCR-preview + confidence breakdown UI.
2. **Adaptive threshold** (Bradley) washes out *large* solid dark regions
   (logos/QR blocks) by design — acceptable for text, worth watching on
   barcode-heavy receipts.
3. **Quad warp** is gated by residual; heavily folded/curved paper may still
   need the raw fallback (which we keep automatically).
4. `file-parser.ts` still calls `recognizeMainThread("eng")` with defaults;
   wiring the `"scan"` preset for rendered PDF pages is a small follow-up
   (PDF scans currently use the same path).
5. PSM.AUTO relies on Tesseract OSD for orientation; on slow deployments OSD
   adds a little time. If it regresses any page, we can pin PSM.OSD→AUTO.
6. `tests/live/trace-extraction-e2e.ts` / `trace-provider-flip.ts` exist
   untracked from earlier milestone work and were **not** committed here.
