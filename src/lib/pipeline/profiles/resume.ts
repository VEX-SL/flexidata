import type { ExtractionProfile, ProfilePlugin } from "../types";

const schema = {
  version: 1,
  fields: [
    { key: "full_name", type: "string" as const, label: "Full name", required: true },
    { key: "job_title", type: "string" as const, label: "Current job title" },
    { key: "phone", type: "string" as const, label: "Phone" },
    { key: "email", type: "string" as const, label: "Email", crossCheck: true },
    { key: "location", type: "string" as const, label: "Location / address" },
    { key: "linkedin", type: "string" as const, label: "LinkedIn URL" },
    { key: "portfolio_url", type: "string" as const, label: "Portfolio / website" },
    { key: "summary", type: "text" as const, label: "Professional summary" },
    { key: "years_of_experience", type: "number" as const, label: "Years of experience", crossCheck: true },
    {
      key: "skills",
      type: "array" as const,
      itemsType: "string" as const,
      label: "Skills",
      description: "List of professional skills / technologies",
    },
    {
      key: "languages",
      type: "array" as const,
      itemsType: "object" as const,
      label: "Languages",
      description: "Objects with keys: name, level",
    },
    {
      key: "experience",
      type: "array" as const,
      itemsType: "object" as const,
      label: "Work experience",
      description: "Objects with keys: company, title, start_date, end_date, location, description",
    },
    {
      key: "education",
      type: "array" as const,
      itemsType: "object" as const,
      label: "Education",
      description: "Objects with keys: institution, degree, field, start_date, end_date, location",
    },
    {
      key: "certifications",
      type: "array" as const,
      itemsType: "object" as const,
      label: "Certifications",
      description: "Objects with keys: name, issuer, year",
    },
    {
      key: "projects",
      type: "array" as const,
      itemsType: "object" as const,
      label: "Projects",
      description: "Objects with keys: name, description, url",
    },
  ],
  groups: [
    {
      id: "personal",
      label: "Personal",
      keys: [
        "full_name",
        "job_title",
        "phone",
        "email",
        "location",
        "linkedin",
        "portfolio_url",
        "years_of_experience",
      ],
    },
    {
      id: "summary",
      label: "Summary",
      keys: ["summary"],
    },
    {
      id: "skills",
      label: "Skills & languages",
      keys: ["skills", "languages"],
    },
    {
      id: "experience",
      label: "Experience & education",
      keys: ["experience", "education", "certifications", "projects"],
    },
  ],
};

const promptTemplate = `You are a resume / CV data extraction engine.
Extract the fields below from the resume. Return ONLY valid JSON matching the given schema.

Rules:
- Preserve the candidate's exact name, titles and employer names.
- Normalize dates to YYYY-MM-DD (approximate to year when only a year is given, e.g. 2019-01-01).
- "experience" objects: company, title, start_date, end_date, location, description (start/end may be null).
- "education" objects: institution, degree, field, start_date, end_date, location.
- "languages" objects: name, level.
- "certifications" objects: name, issuer, year.
- "projects" objects: name, description, url.
- If a value is absent, use null or []. Do not invent values.
- For each field you may include a numeric "confidence" between 0 and 1 (optional).
- Never include explanation text outside the JSON.

Schema:
{{schema}}

Document:
{{document}}`;

const validationRules = [
  { key: "full_name", kind: "string" as const, required: true },
  { key: "email", kind: "string" as const, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
];

export const resumeProfile: ExtractionProfile = {
  id: "resume",
  label: "Resume",
  docTypes: ["resume", "cv", "curriculum vitae", "سيرة ذاتية", "lebenslauf", "履历"],
  schema,
  promptTemplate,
  validationRules,
  exportConfig: {
    formats: ["json", "csv", "xlsx", "pdf"],
    csvColumns: [
      "full_name",
      "job_title",
      "phone",
      "email",
      "location",
      "linkedin",
      "portfolio_url",
      "years_of_experience",
      "skills",
      "languages",
      "experience",
      "education",
    ],
    filename: "resume",
  },
  version: 1,
};

export const resumePlugin: ProfilePlugin = {
  info: {
    id: "resume",
    label: "Resume",
    version: 1,
    docTypes: resumeProfile.docTypes,
    enabled: true,
  },
  build: () => resumeProfile,
};
