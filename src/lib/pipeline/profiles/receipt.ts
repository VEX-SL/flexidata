import type { ExtractionProfile, ProfilePlugin } from "../types";

const schema = {
  version: 1,
  fields: [
    { key: "receipt_number", type: "string" as const, label: "Receipt number", required: true },
    { key: "receipt_date", type: "date" as const, label: "Receipt date", required: true },
    { key: "merchant_name", type: "string" as const, label: "Merchant / store name", required: true },
    { key: "merchant_tax_id", type: "string" as const, label: "Merchant tax ID", crossCheck: true },
    { key: "merchant_address", type: "string" as const, label: "Merchant address" },
    { key: "customer_name", type: "string" as const, label: "Customer name" },
    {
      key: "transaction_id",
      type: "string" as const,
      label: "Transaction ID (رقم العملية)",
      labelGroup: "number",
      crossCheck: true,
      description:
        "Long continuous digit sequence printed next to رقم العملية — typically 16 digits. Never a hotline/support number.",
    },
    {
      key: "reference_number",
      type: "string" as const,
      label: "Reference number (الرقم المرجعي)",
      labelGroup: "number",
      crossCheck: true,
      description: "Usually a 10-digit number starting with 20.",
    },
    {
      key: "customer_id",
      type: "string" as const,
      label: "Customer ID (رقم العميل)",
      labelGroup: "buyer",
      crossCheck: true,
      description: "The digits printed next to رقم العميل.",
    },
    {
      key: "mobile_number",
      type: "string" as const,
      label: "Customer mobile number",
      labelGroup: "phone",
      crossCheck: true,
      description: "Egyptian mobile number matching 01[0125] followed by 8 digits.",
    },
    { key: "currency", type: "enum" as const, label: "Currency", enum: ["USD", "EUR", "GBP", "AED", "SAR", "EGP", "JOD", "KWD", "QAR", "BHD", "OMR"] },
    { key: "subtotal", type: "currency" as const, label: "Subtotal", crossCheck: true },
    { key: "tax_amount", type: "currency" as const, label: "Tax amount", crossCheck: true },
    { key: "discount_amount", type: "currency" as const, label: "Discount amount", crossCheck: true },
    { key: "total_amount", type: "currency" as const, label: "Total amount", required: true, crossCheck: true },
    { key: "payment_method", type: "string" as const, label: "Payment method" },
    { key: "cashier_name", type: "string" as const, label: "Cashier" },
    { key: "pos_number", type: "string" as const, label: "POS / terminal number" },
    { key: "notes", type: "text" as const, label: "Notes / footer text" },
    {
      key: "line_items",
      type: "array" as const,
      itemsType: "object" as const,
      label: "Line items",
      description: "Purchased items with description, quantity, unit price and amount",
    },
  ],
  groups: [
    {
      id: "document",
      label: "Receipt",
      keys: ["receipt_number", "receipt_date"],
    },
    {
      id: "merchant",
      label: "Merchant",
      keys: ["merchant_name", "merchant_tax_id", "merchant_address"],
    },
    {
      id: "customer",
      label: "Customer",
      keys: ["customer_name", "customer_id", "mobile_number"],
    },
    {
      id: "identifiers",
      label: "Transaction identifiers",
      keys: ["transaction_id", "reference_number"],
    },
    {
      id: "amounts",
      label: "Amounts",
      keys: ["currency", "subtotal", "tax_amount", "discount_amount", "total_amount"],
    },
    {
      id: "payment",
      label: "Payment",
      keys: ["payment_method", "cashier_name", "pos_number"],
    },
    {
      id: "details",
      label: "Details",
      keys: ["notes"],
    },
    {
      id: "lineItems",
      label: "Line items",
      keys: ["line_items"],
    },
  ],
};

const promptTemplate = `You are a receipt data extraction engine.
Extract the fields below from the receipt. Return ONLY valid JSON matching the given schema.

Rules:
- Read values exactly as printed (preserve currency amounts as numbers, not strings).
- Normalize dates to YYYY-MM-DD.
- Use ISO 4217 currency codes when identifiable.
- A line item object has keys: description, quantity, unit_price, amount (all numbers where numeric).
- If a value is absent, use null. Do not invent values.
- For each field you may include a numeric "confidence" between 0 and 1 (optional).
- Never include explanation text outside the JSON.

Egyptian payment / thermal receipts (Fawry, SuperPay, Aman):
- transaction_id (رقم العملية): MUST be the long continuous digit sequence printed next to رقم العملية — typically 16 continuous digits (e.g. "6070218301132157"). DO NOT pick hotline/support numbers like "15468", company registration numbers, tax IDs, or account numbers in this field.
- reference_number (الرقم المرجعي): usually a 10-digit number starting with "20" (e.g. "2013439351").
- customer_id (رقم العميل): extract the digits printed next to رقم العميل.
- mobile_number: an Egyptian mobile number matching 01 followed by an operator digit 0/1/2/5 and 8 more digits (e.g. "01012345678").
- amount / total_amount (المبلغ المطلوب / الكلي): match decimal amounts explicitly, preserving the decimal point (e.g. 68.38 — not 6838, not 68).
- Copy identifier digits verbatim even when the thermal print is faint; never pad, trim or reorder them, and keep each identifier separate from the others.

Schema:
{{schema}}

Document:
{{document}}`;

const validationRules = [
  // NOTE: these fields stay `required` because the recovery / grounding stages
  // use `required` to decide which fields to actively re-extract. Requiredness
  // here does NOT mean the validator hard-fails on a missing receipt field —
  // the validator treats the receipt profile as lenient (no missing-field
  // errors) so thermal / aggregator slips that omit a number/date are fine.
  { key: "receipt_number", kind: "string" as const, required: true },
  { key: "receipt_date", kind: "date" as const, required: true, format: "yyyy-mm-dd" },
  { key: "merchant_name", kind: "string" as const, required: true },
  { key: "total_amount", kind: "currency" as const, required: true },
  {
    key: "currency",
    kind: "enum" as const,
    allowed: ["USD", "EUR", "GBP", "AED", "SAR", "EGP", "JOD", "KWD", "QAR", "BHD", "OMR"],
  },
  { key: "receipt_date", kind: "string" as const, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  // Egyptian payment receipts (Fawry / SuperPay / Aman) — identifier shapes.
  // Non-required: a mismatch lowers the validation signal and is surfaced for
  // review, it never drops the field.
  { key: "transaction_id", kind: "string" as const, pattern: "^\\d{16}$" },
  { key: "reference_number", kind: "string" as const, pattern: "^20\\d{8}$" },
  { key: "mobile_number", kind: "string" as const, pattern: "^01[0125]\\d{8}$" },
];

export const receiptProfile: ExtractionProfile = {
  id: "receipt",
  label: "Receipt",
  docTypes: [
    "receipt",
    "إيصال",
    "reçu",
    "kwitansi",
    "bon",
    "ticket",
    "fiskal",
    "purchase",
    "payment",
    "transaction",
    "عملية ناجحة",
    "رقم الحساب",
    "رقم البطاقة",
    "رقم العميل",
  ],
  schema,
  promptTemplate,
  validationRules,
  exportConfig: {
    formats: ["json", "csv", "xlsx", "pdf"],
    csvColumns: [
      "receipt_number",
      "receipt_date",
      "merchant_name",
      "merchant_tax_id",
      "customer_name",
      "customer_id",
      "mobile_number",
      "transaction_id",
      "reference_number",
      "currency",
      "subtotal",
      "tax_amount",
      "discount_amount",
      "total_amount",
      "payment_method",
      "cashier_name",
      "pos_number",
    ],
    filename: "receipt",
  },
  version: 1,
};

export const receiptPlugin: ProfilePlugin = {
  info: {
    id: "receipt",
    label: "Receipt",
    version: 1,
    docTypes: receiptProfile.docTypes,
    enabled: true,
  },
  build: () => receiptProfile,
};
