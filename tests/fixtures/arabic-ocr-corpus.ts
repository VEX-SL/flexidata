/**
 * Deterministic Arabic OCR before/after corpus.
 *
 * Every entry is a RAW OCR stream (real Tesseract-style artifacts: isolated
 * letters, glued scripts, Arabic-Indic digits, bidi-smashed fragments, edge
 * bleeds from adjacent rows) for a different document type — receipts,
 * invoices, contracts, bilingual bills, bank statements. The post-processing
 * layer must repair each one generically, never lose or invent characters,
 * and never merge lines. Each entry carries the repaired line fragments that
 * MUST appear afterwards (the before/after evidence) so the corpus doubles as
 * a regression suite.
 */
import { SUPERYPAY_RECEIPT_OCR } from "./receipt-ocr.ts";

export interface ArabicOcrCorpusEntry {
  id: string;
  /** Document family the raw stream represents. */
  type: "receipt" | "invoice" | "contract" | "bilingual" | "bank";
  /** Raw OCR text as captured from the engine (artifacts preserved). */
  raw: string;
  /** Repaired line fragments that must appear in the post-processed text. */
  expectAfter: string[];
  /** Substrings that must appear verbatim in the raw stream (sanity). */
  expectRaw: string[];
  /** True when the raw stream contains a line that should be flagged garbage. */
  hasGarbage?: boolean;
}

export const ARABIC_OCR_CORPUS: ArabicOcrCorpusEntry[] = [
  {
    id: "receipt-thermal",
    type: "receipt",
    // Isolated letters from thermal-print spacing + a Latin edge bleed.
    raw: [
      "متجر ا ل ر ح ي م التجاري",
      "فاتورة رقم 1024",
      "b التاريخ : 2025-01-12",
      "المبلغ ا ل م س ت ح ق : 48.75",
      "المجموع 48.75",
    ].join("\n"),
    expectRaw: ["متجر ا ل ر ح ي م التجاري", "b التاريخ : 2025-01-12"],
    expectAfter: [
      "متجر الرحيم التجاري",
      "التاريخ : 2025-01-12",
      "المبلغ المستحق : 48.75",
    ],
  },
  {
    id: "invoice-tax",
    type: "invoice",
    // Arabic-Indic digits + isolated letters + leading Latin fragment.
    raw: [
      "شركة ن و ر التقنية المحدودة",
      "فاتورة ضريبية رقم ١١٢٢٣",
      "المجموع الفرعي : 450.75",
      "الضرائب : 22.50",
      "gla الاجمالي : 473.25",
    ].join("\n"),
    expectRaw: ["١١٢٢٣", "gla الاجمالي : 473.25"],
    expectAfter: ["شركه نور التقنيه المحدوده", "11223", "الاجمالي : 473.25"],
  },
  {
    id: "contract-services",
    type: "contract",
    // Ta-marbuta variant + isolated letters + a value with letters+digits
    // (digit-bearing tokens must never be detached).
    raw: [
      "اتفاقية خدمات استضافة",
      "الطرف الثاني : ا ل ش ر ك ة الافق العالمية",
      "رقم الاتفاقية : CT-2025-881",
      "Total 14000",
      "التوقيع : 2025-02-20",
    ].join("\n"),
    expectRaw: ["ا ل ش ر ك ة", "CT-2025-881"],
    expectAfter: [
      "الطرف الثاني : الشركه الافق العالميه",
      "رقم الاتفاقيه : CT-2025-881",
    ],
  },
  {
    id: "bilingual-hotel",
    type: "bilingual",
    // Arabic-Indic phone + a 5-letter Latin word that must be left alone +
    // a detachable 3-letter bleed.
    raw: [
      "فندق الواحة الماسي",
      "غرفة : 204",
      "رقم الهاتف : ٠٥٥١٢٣٤٥٦٧",
      "Suite الاجمالي : 520.00",
      "الضيف : احمد خالد",
      "gla العنوان : الرياض",
    ].join("\n"),
    expectRaw: ["٠٥٥١٢٣٤٥٦٧", "Suite الاجمالي : 520.00"],
    expectAfter: [
      "رقم الهاتف : 0551234567",
      "Suite الاجمالي : 520.00",
      "العنوان : الرياض",
    ],
  },
  {
    id: "bank-statement",
    type: "bank",
    // Pure-Arabic statement with a single-letter edge bleed and a long
    // digit value that must never be touched.
    raw: [
      "البنك السعودي للاستثمار",
      "كشف حساب رقم 391803452",
      "تاريخ الاصدار : 2025-01-01",
      "B الرصيد الحالي : 128500.00",
      "الرصيد المتاح : 128500.00 ريال",
    ].join("\n"),
    expectRaw: ["391803452", "B الرصيد الحالي : 128500.00"],
    expectAfter: [
      "كشف حساب رقم 391803452",
      "الرصيد الحالي : 128500.00",
      "الرصيد المتاح : 128500.00 ريال",
    ],
  },
  {
    id: "receipt-superpay",
    type: "receipt",
    // The real captured SuperPay OCR — the ground-truth artifact set.
    raw: SUPERYPAY_RECEIPT_OCR,
    hasGarbage: true,
    expectRaw: ["gla المطلوب : 68.38 ;", "glad | العلى : 68.38"],
    expectAfter: [
      "SuperPay 60",
      "انرقم المرجقي : 2013438351",
      "المطلوب : 68.38 ;",
      "العلي : 68.38",
      "عمليه ناجحه",
    ],
  },
];
