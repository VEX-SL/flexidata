import type { ExtractionProfile, ProfilePlugin } from "../types";

const schema = {
  version: 1,
  fields: [
    { key: "contract_title", type: "string" as const, label: "Contract title", required: true },
    { key: "contract_date", type: "date" as const, label: "Contract date", required: true },
    { key: "effective_date", type: "date" as const, label: "Effective date" },
    { key: "expiry_date", type: "date" as const, label: "Expiry / termination date", crossCheck: true },
    { key: "party_a_name", type: "string" as const, label: "Party A (first party)", required: true },
    { key: "party_a_type", type: "enum" as const, label: "Party A type", enum: ["individual", "company", "government", "other"] },
    { key: "party_b_name", type: "string" as const, label: "Party B (second party)", required: true },
    { key: "party_b_type", type: "enum" as const, label: "Party B type", enum: ["individual", "company", "government", "other"] },
    { key: "jurisdiction", type: "string" as const, label: "Jurisdiction / governing law" },
    { key: "currency", type: "enum" as const, label: "Currency", enum: ["USD", "EUR", "GBP", "AED", "SAR", "EGP", "JOD", "KWD", "QAR", "BHD", "OMR"] },
    { key: "contract_value", type: "currency" as const, label: "Contract value", crossCheck: true },
    { key: "payment_terms", type: "string" as const, label: "Payment terms" },
    { key: "renewal_terms", type: "string" as const, label: "Renewal terms" },
    { key: "notice_period", type: "string" as const, label: "Notice period" },
    { key: "governing_law", type: "string" as const, label: "Governing law" },
    { key: "signatories", type: "array" as const, itemsType: "object" as const, label: "Signatories", description: "Objects with keys: name, title, party, signed" },
    { key: "key_obligations", type: "array" as const, itemsType: "object" as const, label: "Key obligations", description: "Objects with keys: party, obligation" },
    { key: "summary", type: "text" as const, label: "Summary", description: "2-4 sentence summary of the contract purpose" },
  ],
  groups: [
    {
      id: "document",
      label: "Contract",
      keys: ["contract_title", "contract_date", "effective_date", "expiry_date"],
    },
    {
      id: "parties",
      label: "Parties",
      keys: ["party_a_name", "party_a_type", "party_b_name", "party_b_type"],
    },
    {
      id: "terms",
      label: "Terms",
      keys: [
        "jurisdiction",
        "currency",
        "contract_value",
        "payment_terms",
        "renewal_terms",
        "notice_period",
        "governing_law",
      ],
    },
    {
      id: "obligations",
      label: "Obligations",
      keys: ["signatories", "key_obligations"],
    },
    {
      id: "summary",
      label: "Summary",
      keys: ["summary"],
    },
  ],
};

const promptTemplate = `You are a contract data extraction engine.
Extract the fields below from the contract. Return ONLY valid JSON matching the given schema.

Rules:
- Use the exact names of the parties as written (full legal names).
- Normalize dates to YYYY-MM-DD.
- "signatories" objects: name, title, party ("A"/"B"), signed (true/false/null).
- "key_obligations" objects: party ("A"/"B"), obligation (short clause text).
- If a value is absent, use null or []. Do not invent values.
- For each field you may include a numeric "confidence" between 0 and 1 (optional).
- Never include explanation text outside the JSON.

Schema:
{{schema}}

Document:
{{document}}`;

const validationRules = [
  { key: "contract_title", kind: "string" as const, required: true },
  { key: "contract_date", kind: "date" as const, required: true, format: "yyyy-mm-dd" },
  { key: "party_a_name", kind: "string" as const, required: true },
  { key: "party_b_name", kind: "string" as const, required: true },
  { key: "contract_date", kind: "string" as const, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
];

export const contractProfile: ExtractionProfile = {
  id: "contract",
  label: "Contract",
  docTypes: ["contract", "agreement", "عقد", "ميثاق", "accordo", "contrat"],
  schema,
  promptTemplate,
  validationRules,
  exportConfig: {
    formats: ["json", "csv", "xlsx", "pdf"],
    csvColumns: [
      "contract_title",
      "contract_date",
      "effective_date",
      "expiry_date",
      "party_a_name",
      "party_a_type",
      "party_b_name",
      "party_b_type",
      "jurisdiction",
      "currency",
      "contract_value",
      "payment_terms",
      "renewal_terms",
      "notice_period",
      "governing_law",
      "signatories",
    ],
    filename: "contract",
  },
  version: 1,
};

export const contractPlugin: ProfilePlugin = {
  info: {
    id: "contract",
    label: "Contract",
    version: 1,
    docTypes: contractProfile.docTypes,
    enabled: true,
  },
  build: () => contractProfile,
};
