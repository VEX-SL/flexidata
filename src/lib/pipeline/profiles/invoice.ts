import type { ExtractionProfile, ProfilePlugin } from "../types";

const schema = {
  version: 1,
  fields: [
    { key: "invoice_number", type: "string" as const, label: "Invoice number", required: true },
    { key: "invoice_date", type: "date" as const, label: "Invoice date", required: true },
    { key: "due_date", type: "date" as const, label: "Due date" },
    { key: "seller_name", type: "string" as const, label: "Seller / supplier name", required: true },
    { key: "seller_tax_id", type: "string" as const, label: "Seller tax ID", crossCheck: true },
    { key: "seller_address", type: "string" as const, label: "Seller address" },
    { key: "buyer_name", type: "string" as const, label: "Buyer / customer name", required: true },
    { key: "buyer_tax_id", type: "string" as const, label: "Buyer tax ID", crossCheck: true },
    { key: "buyer_address", type: "string" as const, label: "Buyer address" },
    { key: "currency", type: "enum" as const, label: "Currency", enum: ["USD", "EUR", "GBP", "AED", "SAR", "EGP", "JOD", "KWD", "QAR", "BHD", "OMR"] },
    { key: "subtotal", type: "currency" as const, label: "Subtotal before tax", crossCheck: true },
    { key: "tax_amount", type: "currency" as const, label: "Tax amount", crossCheck: true },
    { key: "tax_rate", type: "number" as const, label: "Tax rate (%)", crossCheck: true },
    { key: "discount_amount", type: "currency" as const, label: "Discount amount", crossCheck: true },
    { key: "shipping_amount", type: "currency" as const, label: "Shipping / handling", crossCheck: true },
    { key: "total_amount", type: "currency" as const, label: "Total amount", required: true, crossCheck: true },
    { key: "amount_due", type: "currency" as const, label: "Amount due / balance", crossCheck: true },
    { key: "payment_method", type: "string" as const, label: "Payment method" },
    { key: "bank_name", type: "string" as const, label: "Bank name" },
    { key: "iban", type: "string" as const, label: "IBAN" },
    { key: "payment_terms", type: "string" as const, label: "Payment terms" },
    { key: "notes", type: "text" as const, label: "Notes / terms conditions" },
    {
      key: "line_items",
      type: "array" as const,
      itemsType: "object" as const,
      label: "Line items",
      description: "Items on the invoice with description, quantity, unit price and amount",
    },
  ],
};

const promptTemplate = `You are an invoice data extraction engine.
Extract the fields below from the invoice document. Return ONLY valid JSON matching the given schema.

Rules:
- Read values exactly as printed (preserve currency amounts as numbers, not strings).
- Normalize dates to YYYY-MM-DD.
- Use ISO 4217 currency codes when identifiable (USD, EUR, AED, SAR, ...).
- A line item object has keys: description, quantity, unit_price, amount (all numbers where numeric).
- If a value is absent, use null. Do not invent values.
- For each field you may include a numeric "confidence" between 0 and 1 (optional).
- Never include explanation text outside the JSON.

Schema:
{{schema}}

Document:
{{document}}`;

const validationRules = [
  { key: "invoice_number", kind: "string" as const, required: true },
  { key: "invoice_date", kind: "date" as const, required: true, format: "yyyy-mm-dd" },
  { key: "seller_name", kind: "string" as const, required: true },
  { key: "buyer_name", kind: "string" as const, required: true },
  { key: "total_amount", kind: "currency" as const, required: true },
  {
    key: "currency",
    kind: "enum" as const,
    allowed: ["USD", "EUR", "GBP", "AED", "SAR", "EGP", "JOD", "KWD", "QAR", "BHD", "OMR"],
  },
  { key: "invoice_date", kind: "string" as const, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  { key: "tax_rate", kind: "number" as const, min: 0, max: 100 },
];

export const invoiceProfile: ExtractionProfile = {
  id: "invoice",
  label: "Invoice",
  docTypes: ["invoice", "فاتورة", "facture", "faktur", "boleta", "nota fiscal"],
  schema,
  promptTemplate,
  validationRules,
  exportConfig: {
    formats: ["json", "csv", "xlsx", "pdf"],
    csvColumns: [
      "invoice_number",
      "invoice_date",
      "due_date",
      "seller_name",
      "seller_tax_id",
      "buyer_name",
      "buyer_tax_id",
      "currency",
      "subtotal",
      "tax_amount",
      "tax_rate",
      "discount_amount",
      "total_amount",
      "amount_due",
      "payment_method",
      "payment_terms",
    ],
    filename: "invoice",
  },
  version: 1,
};

export const invoicePlugin: ProfilePlugin = {
  info: {
    id: "invoice",
    label: "Invoice",
    version: 1,
    docTypes: invoiceProfile.docTypes,
    enabled: true,
  },
  build: () => invoiceProfile,
};
