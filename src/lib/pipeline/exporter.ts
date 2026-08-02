import type {
  ExportOptions,
  ExportResult,
  ExtractionResult,
  ExtractionProfile,
} from "./types";
import { getProfileManager } from "./profiles/registry";
import { isEmptyValue } from "./extractor/post-processor";

/**
 * Exporter — turns a validated extraction into downloadable formats.
 * JSON and CSV are implemented; XLSX and PDF land in phase 2 (stubs throw
 * a clear "not implemented" error so the contract stays explicit).
 */

/** Enrichment metadata (not part of the extraction result itself). */
export interface ExportMeta {
  /** Overall pipeline confidence (0..1). */
  confidence?: number;
  /** ISO timestamp of completion. */
  extractedAt?: string;
}

export function exportExtraction(
  extraction: ExtractionResult,
  options: ExportOptions,
  meta: ExportMeta = {}
): ExportResult {
  const profile = getProfileManager().getOrFallback(extraction.profileType);
  const baseName = sanitize(profile.exportConfig.filename ?? profile.id);

  switch (options.format) {
    case "json":
      return exportJson(extraction, options, meta, `${baseName}.json`);
    case "csv":
      return exportCsv(profile, extraction, options, `${baseName}.csv`);
    case "xlsx":
      throw new Error("XLSX export is scheduled for phase 2");
    case "pdf":
      throw new Error("PDF export is scheduled for phase 2");
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }
}

/**
 * Structured JSON export. Always self-describing and current:
 *  - `document_type`, `confidence`, `extracted_at`, `provider`, `model`
 *  - `fields`: every extracted field key → { value, confidence, edited,
 *    verified, label }. Edited/reviewed values are what the user sees; empty
 *    values (including empty arrays) are never emitted — the export can never
 *    contain a meaningless `key_numbers: []`.
 */
function exportJson(
  extraction: ExtractionResult,
  _options: ExportOptions,
  meta: ExportMeta,
  fileName: string
): ExportResult {
  const fields: Record<string, unknown> = {};
  for (const f of extraction.fields) {
    if (isEmptyValue(f.value.value)) continue;
    fields[f.field.key] = {
      value: f.value.value,
      confidence: f.value.confidence,
      edited: f.value.status === "edited",
      verified: f.value.status === "verified",
      label: f.field.label ?? f.field.key,
    };
  }

  const body: Record<string, unknown> = {
    document_type: extraction.profileType,
    confidence: meta.confidence ?? null,
    extracted_at: meta.extractedAt ?? null,
    provider: extraction.provider ?? null,
    model: extraction.model ?? null,
    fields,
  };

  return {
    format: "json",
    content: JSON.stringify(body, null, 2),
    mimeType: "application/json",
    fileName,
  };
}

function exportCsv(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  _options: ExportOptions,
  fileName: string
): ExportResult {
  const columns =
    profile.exportConfig.csvColumns ?? Object.keys(extraction.cleanFields);
  const row = columns.map((col) => {
    const fv = extraction.fieldsMap[col];
    const value = fv && !isEmptyValue(fv.value) ? fv.value : "";
    return csvEscape(
      typeof value === "string" ? value : JSON.stringify(value)
    );
  });

  const header = columns.map(csvEscape).join(",");
  const content = `${header}\n${row.join(",")}`;

  return {
    format: "csv",
    content,
    mimeType: "text/csv; charset=utf-8",
    fileName,
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "document";
}
