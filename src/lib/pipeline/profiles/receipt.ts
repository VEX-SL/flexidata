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
      keys: ["customer_name"],
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

Schema:
{{schema}}

Document:
{{document}}`;

const validationRules = [
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
];

export const receiptProfile: ExtractionProfile = {
  id: "receipt",
  label: "Receipt",
  docTypes: ["receipt", "إيصال", "reçu", "kwitansi", "bon", "ticket", "fiskal"],
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
