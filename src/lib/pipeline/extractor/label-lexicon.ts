import type { FieldSchema } from "../types";

/**
 * Multilingual label lexicon — maps the semantic *category* of a field to the
 * words/labels OCR and printed documents use for it. Documents are extracted
 * across Arabic/English/French/etc, so labels are collected per category, not
 * per vendor or per document type. Adding a new profile (passport, ID,
 * contract, bank statement) only needs its fields mapped to a category here —
 * no per-document logic.
 */

export interface LabelGroupDef {
  /** Stable category id. */
  group: string;
  /** Label words, case-insensitive, matched on normalized (bidi-stripped) text. */
  words: string[];
}

export const LABEL_GROUPS: LabelGroupDef[] = [
  {
    group: "number",
    words: [
      "المرجعي",
      "المرجقي",
      "مرجعي",
      "المعاملة",
      "التمليه",
      "رقم العملية",
      "رقم المعاملة",
      "reference",
      "ref no",
      "ref",
      "transaction id",
      "receipt no",
      "invoice no",
      "serial",
    ],
  },
  {
    group: "date",
    words: [
      "التاريخ",
      "تاريخ",
      "التوقيت",
      "الوقت",
      "تاريخ الاصدار",
      "تاريخ الاستحقاق",
      "استحقاق",
      "issued",
      "date",
      "datetime",
      "time",
      "due",
      "period",
      "فترة",
    ],
  },
  {
    group: "tax",
    words: [
      "الرقم الضريبي",
      "الضريبي",
      "الضريبية",
      "الضريبة",
      "السجل التجاري",
      "الرقم الموحد",
      "vrn",
      "vat",
      "tax no",
      "tax id",
      "tax",
      "tin",
      "crn",
      "gst",
    ],
  },
  {
    group: "total",
    words: [
      "الإجمالي",
      "الاجمالي",
      "المجموع",
      "المطلوب",
      "العلى",
      "الاجمالي المستحق",
      "المستحق",
      "grand total",
      "total",
      "amount due",
      "balance",
      "المبلغ الاجمالي",
    ],
  },
  {
    group: "currency",
    words: ["العملة", "currency", "ريال", "درهم", "دينار", "جنيه", "دولار", "يورو", "د.ك", "ر.س"],
  },
  {
    group: "merchant",
    words: ["التاجر", "البائع", "المورد", "المحل", "الشركة", "merchant", "seller", "vendor", "store", "trading"],
  },
  {
    group: "buyer",
    words: ["المشتري", "العميل", "customer", "buyer", "client"],
  },
  {
    group: "payment",
    words: ["الدفع", "طريقة الدفع", "البطاقة", "نقدي", "شبكة", "payment", "method", "card", "cash", "tap"],
  },
  {
    group: "pos",
    words: ["الحساب", "حساب", "نقطة البيع", "الطرفية", "pos", "terminal", "tid"],
  },
  {
    group: "notes",
    words: ["ملاحظات", "ملاحظة", "معلومات", "إضافية", "اضافية", "notes", "note", "info", "footer"],
  },
];

/** Default field key → label category mapping (overridable via FieldSchema). */
function defaultGroupForField(key: string): string | null {
  if (key === "notes") return "notes";
  if (key === "line_items" || key === "items") return "items";
  if (key === "currency") return "currency";
  if (key === "total_amount" || key === "amount_due") return "total";
  if (key === "tax_amount" || key === "tax_rate") return "tax";
  if (key === "merchant_name" || key === "seller_name" || key === "vendor_name") return "merchant";
  if (key === "customer_name" || key === "buyer_name") return "buyer";
  if (key === "payment_method") return "payment";
  if (key === "pos_number" || key === "terminal_id") return "pos";
  if (key === "merchant_tax_id" || key === "seller_tax_id" || key === "buyer_tax_id") return "tax";
  if (key.endsWith("_date") || key === "date" || key === "due_date") return "date";
  if (key.endsWith("_number") || key === "number" || key.endsWith("_no")) return "number";
  return null;
}

/** The label category a field expects to see next to its value. */
export function labelGroupForField(field: FieldSchema): string | null {
  if (field.labelGroup) return field.labelGroup;
  return defaultGroupForField(field.key);
}

/** Which category's words appear on a line (first match wins). */
export function detectLabelGroup(lineText: string): string | null {
  const norm = normalizeForLabel(lineText);
  for (const def of LABEL_GROUPS) {
    if (def.words.some((w) => norm.includes(w))) return def.group;
  }
  return null;
}

function normalizeForLabel(s: string): string {
  return s
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
