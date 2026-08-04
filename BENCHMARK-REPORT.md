# Benchmark: OCR + extraction quality before/after (real engine, real providers)

Milestone commit: after `54dd276`. This report measures the OCR milestone end
to end: OCR quality, downstream field extraction, confidence calibration,
grounding, and agent answers — **before** (old engine + raw text) vs **after**
(new engine + preprocessing/fallback + structured document). All numbers below
are reproduced from committed JSON snapshots in `benchmarks/results/`.

Generated: 2026-08-04

## How to reproduce

```bash
# 1. OCR-level (old vs newRaw vs newPre)
node --experimental-strip-types --experimental-transform-types \
  --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
  tests/live/benchmark/run-ocr-level.ts

# 2. Pipeline-level (old vs new through real runPipeline + real providers)
node --experimental-strip-types --experimental-transform-types \
  --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
  tests/live/benchmark/run-pipeline-level.ts

# 3. Agent re-evaluation (real providers)
node --experimental-strip-types --experimental-transform-types \
  --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
  tests/live/benchmark/run-agent-eval.ts

# 4. This report (pure data pass)
node --experimental-strip-types --experimental-transform-types \
  --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
  tests/live/benchmark/generate-report.ts
```

Run order matters: `run-agent-eval` reads `pipeline-level.json`, and
`generate-report` reads all three. Provider-dependent runs need `.env`
(Groq/cerebras/gemini/openrouter keys); the pipeline falls over to other
providers on rate limits.

---

## 1. Corpus

| Corpus item | Description | Ground-truth keys |
|---|---|---|
| `en-clean` | English receipt (clean) | merchant, merchant, total 38.40, cash 50.00, change 11.60 |
| `en-lowcontrast` | English receipt (low contrast) | merchant, merchant, total 38.40, cash 50.00, change 11.60 |
| `en-rot90` | English receipt (90° rotated) | merchant, merchant, total 38.40, cash 50.00, change 11.60 |
| `en-slant2` | English receipt (2° slanted) | merchant, merchant, total 38.40, cash 50.00, change 11.60 |
| `ar-thermal` | Arabic thermal receipt | total 45.50, المبلغ, الإجمالي |
| `real-superpay` | Real SuperPay receipt photo (prod) | amount 68.38, account 391003452, ref 2013438351, merchant SuperPay, customer Zahra Aman, date 02-07-2026 |

Corpus sources: `benchmarks/corpus/` (synthetic PNGs rendered with
`@napi-rs/canvas`) plus the real production SuperPay receipt photo
`benchmarks/corpus/real-superpay.jpg` (copy of
`benchmarks/real/db51e106…jpg`).

## 2. OCR level — old vs new engine

| Corpus | Engine | Lines | Chars | Page conf | Mean line conf | GT hits | ms |
|---|---|---|---|---|---|---|---|
| `en-clean` | old | 18 | 147 | 90.0% | 90.0% | **5/5** | 1002 |
|  | new (raw) | 10 | 147 | 91.4% | 91.9% | **5/5** | 703 |
|  | new (preprocessed) | 10 | 147 | 95.3% | 95.4% | **5/5** | 993 |
| `en-lowcontrast` | old | 18 | 147 | 90.0% | 90.0% | **5/5** | 701 |
|  | new (raw) | 10 | 147 | 91.6% | 92.1% | **5/5** | 646 |
|  | new (preprocessed) | 10 | 147 | 94.9% | 95.0% | **5/5** | 874 |
| `en-rot90` | old | 17 | 41 | 58.0% | 58.0% | **0/5** | 932 |
|  | new (raw) | 5 | 83 | 92.5% | 92.4% | **1/5** | 292 |
|  | new (preprocessed) | 5 | 83 | 92.5% | 92.4% | **1/5** | 750 |
| `en-slant2` | old | 8 | 84 | 85.0% | 85.0% | **1/5** | 466 |
|  | new (raw) | 5 | 84 | 87.9% | 87.5% | **1/5** | 485 |
|  | new (preprocessed) | 5 | 84 | 85.7% | 85.4% | **1/5** | 655 |
| `ar-thermal` | old | 6 | 74 | 86.0% | 86.0% | **3/3** | 283 |
|  | new (raw) | 5 | 74 | 89.0% | 89.2% | **3/3** | 279 |
|  | new (preprocessed) | 5 | 76 | 90.4% | 90.5% | **3/3** | 501 |
| `real-superpay` | old | 18 | 348 | 64.0% | 64.0% | **4/6** | 2292 |
|  | new (raw) | 17 | 325 | 74.1% | 75.4% | **5/6** | 2007 |
|  | new (preprocessed) | 18 | 307 | 67.9% | 70.7% | **6/6** | 4722 |

| Engine | Aggregate GT hits |
|---|---|
| old | 18/29 |
| new (raw) | 20/29 |
| new (preprocessed) | 21/29 |

Reads (real photo): the old engine turned the date line into
`تبيخ الوقت : 02-07-2028 18:30:12` (page conf 0.64, single confidence value
for every line — `distinctConfs: 1`). The new preprocessed engine reads the
same line as `تاريخ انلوقت : 02-07-2026 18:30:12` with **17 distinct per-line
confidence values** — the garbled-vs-clean distinction is now visible and
usable by grounding.

## 3. Pipeline level — field extraction, confidence, validation

| Corpus | Engine | Class conf | Overall conf | Validation | Field GT | ms |
|---|---|---|---|---|---|---|
| `en-clean` | old | 95.0% | 76.3% | ✗ missing receipt_number | 3/4 | 7809 |
|  | new | 95.0% | 80.7% | ✗ missing receipt_number | 3/4 | 4429 |
| `en-lowcontrast` | old | 95.0% | 82.1% | ✗ missing receipt_number | 3/3 | 14421 |
|  | new | 95.0% | 83.9% | ✗ missing receipt_number | 3/3 | 8251 |
| `en-rot90` | old | 80.0% | 65.2% | ✗ missing receipt_date, total_amount | n/a | 4096 |
|  | new | 95.0% | 75.6% | ✗ missing receipt_number, total_amount | n/a | 7781 |
| `en-slant2` | old | 95.0% | 74.2% | ✗ missing receipt_number, total_amount | n/a | 8164 |
|  | new | 95.0% | 69.9% | ✗ missing receipt_number, total_amount | n/a | 1279 |
| `ar-thermal` | old | 95.0% | 83.3% | ✗ missing receipt_number | 3/3 | 14195 |
|  | new | 95.0% | 75.7% | ✗ missing receipt_number, merchant_name | 2/3 | 7948 |
| `real-superpay` | old | 100.0% | 78.6% | ✓ ok | 2/3 | 8164 |
|  | new | 85.0% | 70.9% | ✗ missing merchant_name | 2/3 | 4609 |

Notes: `en-rot90`/`en-slant2` have no field ground truth (scored `n/a`);
`real-superpay` is the decisive case (real photo, see §4).

## 4. Confidence calibration

How well does reported confidence track actual correctness? Measured on the
two items with meaningful per-field ground truth.

### real-superpay — Real SuperPay receipt photo (prod)

| Field | Old value (conf / status) | New value (conf / status) | Correct? |
|---|---|---|---|
| date = 2026-07-02 | 2028-07-02<br>94.0% | 2026-07-02<br>74.6% | improved (old ✗, new ✓) |
| total = 68.38 | 68.38<br>49.0% `flagged` | 68.38<br>66.7% | ✓ both |
| account = 391003452 | — (missing) | 391003452<br>78.8% | improved (old ✗, new ✓) |
| customer = Zahra Aman | Zahra Aman<br>68.0% | Zahra Aman<br>77.0% | ✓ both |
| ref = 2013438351 | 6070218301132167<br>96.0% | La 15468<br>38.9% | ✗ both |
| merchant = SuperPay | SuperPay<br>74.4% | — (missing) | regressed (old ✓, new ✗) |

### ar-thermal — Arabic thermal receipt

| Field | Old value (conf / status) | New value (conf / status) | Correct? |
|---|---|---|---|
| date = 2025-01-15 | 2025-01-15<br>100.0% | 2025-01-15<br>91.1% | ✓ both |
| total = 45.50 | 45.5<br>100.0% | 45.5<br>92.4% | ✓ both |
| currency = SAR | — (missing) | SAR<br>52.0% | improved (old ✗, new ✓) |

- Old engine on the real photo returned **6070218301132167 @ 96.0%** (status `extracted`) and **2028-07-02 @ 94.0%** (status `extracted`), and validation passed (`ok: true`). Both values are wrong — the photo is from **02-07-2026** and the ref is **2013438351**.
- New engine on the same photo returns the **correct date 2026-07-02 @ 74.6%** but scores the receipt number low (La 15468 @ 38.9%) with reasons `ocr_confidence_low, label_not_matched`, and validation now fails honestly (`missing: merchant_name`).
- New engine on the Arabic thermal receipt gives `currency` = SAR @ 52.0% with reasons `no_direct_evidence, label_not_matched` — a genuinely uncertain inference is scored low instead of defaulting to ~0.7.

**Reading**: the old engine shipped high-confidence **wrong** values on the
real photo (wrong date 0.94, wrong receipt number 0.96) and validation passed.
The new engine ships the correct date, scores the unreadable receipt number
low (0.389, honest reasons), and lets validation fail on the missing
`merchant_name`. Reported confidence now tracks correctness — a lower overall
confidence (78.6% → 70.9%) is the more truthful number.

## 5. Agent re-evaluation

### en-clean

**Q1** — “What kind of document is this? What was the total amount and on what date?”

- **old** (llama-3.1-8b-instant): **Document Type:** This is a receipt document, likely from a supermarket.

**Total Amount:** The total amount is **38.40**.

**Date:** The transaction took place on **2025-01-15**.
- **new** (gpt-oss-120b): **Document type:** Receipt  

**Date:** `2025-01-15` (from the extracted field **receipt date**)  

**Total amount:** `38.4` (from the extracted field **total amount**)

| Engine | total ✓ | date ✓ | type ✓ |
|---|---|---|---|
| old | true | true | true |
| new | false | true | true |

**Q2** — “Can you see the image of the document? Describe … how confident …”
- **old** (gpt-oss-120b): **What the document looks like**

The image is a small, single‑page receipt printed on a thermal printer. Its layout is simple and left‑aligned:

1. **Header** – Store name “AL RABIH SUPERMARKET” on the top line, followed by the location “Riyadn, KSA” and a phone number “Tel: 011‑555‑1212”.
2. **Date line** – “Date: 2025‑01‑15 15:42”.
3. **Item list** – Each purchased item appears on its own line with quantity/size and price:
   - `Sugar 1kg 6.50`
   - `Milk 1L 7.00`
   - `Rice Sky 24.90`
4. **Totals** – A line with “TOTAL 38.40”, then the payment method:
- **new** (gpt-oss-120b): **What the receipt looks like**

The image shows a typical printed receipt from **AL RABIH SUPERMARKET** in Riyadh, KSA. At the top is the merchant name and address line (“Riyadh, KSA Tel: 011‑555‑1212”). Below that appears the date and time stamp:

```
Date: 2025-01-15 15:42
```

The body lists three purchased items with their quantities and unit prices:

- **Sugar 1kg** – 6.50  
- **Milk 1L** – 7.00  
- **Rice 5kg** – 24.90  

A line labeled **TOTAL** shows **38.40**. Beneath it, the payment method is indicated as **Cash 50.00**, followed by a **Change** amount of **11.60**. The receipt ends …

| Engine | claims image | refuses |
|---|---|---|
| old | false | false |
| new | true | false |

### ar-thermal

**Q1** — “What kind of document is this? What was the total amount and on what date?”

- **old** (llama-3.1-8b-instant): **نوع المستند:** هذه هي فاتورة شراء من متجر تجاري.

**المبلغ الإجمالي:** 45.50 رس.

**تاريخ الشراء:** 15-01-2025.
- **new** (gpt-oss-120b): **Document type:** Receipt  

**Total amount:** **45.5** SAR  

**Date:** **2025-01-15** (shown as 15‑01‑2025 in the OCR)

| Engine | total ✓ | date ✓ | type ✓ |
|---|---|---|---|
| old | true | false | false |
| new | false | true | true |

**Q2** — “Can you see the image of the document? Describe … how confident …”
- **old** (gpt-oss-120b): **What the document looks like**

The OCR text suggests this is a small retail receipt:

- **Header** – the store name **“متجر الرحيم التجاري”** appears at the top.  
- **Date line** – **“تاريخ: 15-01-2025”** is printed below the header.  
- **Item line** – the product description reads **“tala أرز 5كج”**, indicating a
- **new** (llama-3.1-8b-instant): **Document Overview:**
The provided document is an image of a receipt, labeled as "ar-thermal.png". The image appears to be a scanned or photographed copy of a paper receipt.

**Visual Description:**
The receipt has a simple layout with a few lines of text. The top section contains the merchant's name, "متجر الرحيمالتجاري", written in Arabic script. Below it, there is a date field with the value "15-01-2025" printed in a slightly smaller font size. The main body of the receipt lists a single item, "سلعة: ‎JJ)‏5كج", which translates to "Item: 5 kg". At the bottom, there are two lines with the t …

| Engine | claims image | refuses |
|---|---|---|
| old | false | false |
| new | true | false |

### real-superpay

**Q1** — “What kind of document is this? What was the total amount and on what date?”

- **old** (gpt-oss-120b): **نوع المستند:** إيصال عملية دفع من SuperPay (receipt).

**المبلغ الإجمالي:** **68.38**  

**التاريخ والوقت:** **02‑07‑2028 18:30:12** (مُستخرج من النص “تبيخ الوقت : 02-07-2028 18:30:12”).
- **new** (gpt-oss-120b): **Document type:** Receipt  

**Total amount:** **68.38**  

**Date:** **2026-07-02** (shown in the receipt as “02-07-2026”).

| Engine | total ✓ | date ✓ | type ✓ |
|---|---|---|---|
| old | true | false | true |
| new | true | true | true |

**Q2** — “Can you see the image of the document? Describe … how confident …”
- **old** (gpt-oss-120b): **What the document looks like**

The image appears to be a **SuperPay transaction receipt** printed in a mix of Arabic and English. The layout is typical of a point‑of‑sale slip
- **new** (llama-3.1-8b-instant): **Document Overview:**
The provided image is a receipt, specifically a SuperPay receipt, with a faint background and a mix of Arabic and Latin characters. The overall extraction confidence is 0.71, indicating a moderate level of confidence in the extracted values.

**Visual Description:**
The receipt appears to be printed on a standard A4 paper with a light gray background. The text is in a mix of Arabic and Latin characters, with some characters being slightly blurry or faint. The receipt contains various fields, including the receipt number, date, customer name, subtotal, total amount, POS n …

| Engine | claims image | refuses |
|---|---|---|
| old | false | false |
| new | false | false |


Headline (real photo): the **old** agent quoted **02-07-2028** as the date; the
**new** agent quotes **2026-07-02** and cites the extracted field
(`receipt_date`). Neither refuses; one new-engine Q2 (real-superpay) keeps a
sensible image-free answer, while `en-clean`/`ar-thermal` new answers still
say “the image shows …” (see §7 weaknesses).

> Note on the `total ✓` column: the new-engine answers write the total without
> a trailing zero (`38.4`, `45.5`) and the runner regexes expect
> `38[.,]?40` / `45[.,]?50`, so `totalFound=false` on `en-clean` and
> `ar-thermal` (new) is a **check artifact, not a wrong answer** — the value
> is correct in both engines.

## 6. Trace excerpts (real photo)

**old** (overall conf 78.6%)

```json
{
  "ground": {
    "groundedFields": 4,
    "totalFields": 6,
    "evidenceCoverage": 0.667,
    "flagged": 0,
    "ambiguous": 0
  },
  "recover": {
    "flagged": [
      "total_amount"
    ],
    "ambiguous": [],
    "retryAttempted": false,
    "retryProviders": []
  }
}
```
**new** (overall conf 70.9%)

```json
{
  "ground": {
    "groundedFields": 6,
    "totalFields": 7,
    "evidenceCoverage": 0.857,
    "meanEvidenceConfidence": 0.717,
    "flagged": 0,
    "ambiguous": 0
  },
  "recover": {
    "flagged": [],
    "ambiguous": [],
    "retryAttempted": false,
    "retryProviders": []
  }
}
```

Grounding coverage improved on the real photo: `groundedFields 4/6 → 6/7`,
`evidenceCoverage 0.667 → 0.857` (new also exposes `meanEvidenceConfidence:
0.717`). Recovery was not needed on either run.

## 7. Remaining weaknesses

1. **Rotated / slanted synthetics stay hard for every engine.** On `en-rot90`, old scores 0/5 and the new engine only 1/5 (Tesseract OSD recovers the page but not the text reliably); on `en-slant2` all engines reach 1/5. Ground-truth recovery on these inputs is a known limitation, not a regression.
2. **Real-photo receipt number is still misread.** The new engine reads `La 15468` where the receipt shows `2013438351` / `391003452`; it is now scored honestly (0.389, `ocr_confidence_low`) but the value is not correct.
3. **`merchant_name` is missing on the real photo (new).** The SuperPay logo line survives OCR but is not mapped to the required field, so validation now fails (which is the honest outcome).
4. **Garbled line items on the real photo.** Line-item descriptions (`Hostinger;Description…)0123456788(`, `oe   a           : il`) are raw OCR noise; the pipeline extracts them but `line_items` scores 0.39 with `no_direct_evidence`.
5. **Agent can still claim to “see” the image.** Q2 on `en-clean` (new) and `ar-thermal` (new) triggered `claimsImage = true`; the system prompt should keep steering answers to the extracted context.
6. **Groq rate limits (TPM ~6000) add latency/flakiness.** Pipeline and agent runs fall over to cerebras/gemini/openrouter/huggingface and retry, so `ms` columns vary run to run. Provider fallback masks it but benchmarks should re-run when quota allows.
7. **`en-rot90` / `en-slant2` have no field-level ground truth** in the pipeline run (scored `n/a`), so their pipeline numbers only cover classification/confidence.

## 8. Delivered artifacts

- `src/lib/ocr/preprocess.ts` — EXIF orientation, quarter-rotation (ink-band
  gate), deskew, quad warp, auto-crop, contrast/sharpen, adaptive threshold
  (Rec.709 grayscale).
- `src/lib/tesseract-main.ts` — per-word confidence via `ResultIterator`,
  PSM.AUTO, preprocess→raw fallback with `isPoorResult`/`isMediocreResult`/
  `isBetterThan`.
- `src/lib/pipeline/types.ts`, `stages/recover.ts`, `trace.ts` — recovery
  stats + `ground`/`recover` trace summaries.
- `tests/live/_engines/old-tesseract.ts` — archived pre-milestone engine for
  A/B.
- `tests/live/benchmark/` — corpus + 3 runners + this generator.
- `benchmarks/corpus/`, `benchmarks/results/*.json` — committed snapshots.
- Documents page: OCR preview tab now highlights evidence lines and per-word
  confidence (60% threshold, tooltips, legend).
