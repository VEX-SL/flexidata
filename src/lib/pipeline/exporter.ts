import type {
  ExportOptions,
  ExportResult,
  ExtractionResult,
  ExtractionProfile,
} from "./types";
import { getProfileManager } from "./profiles/registry";

/**
 * Exporter — turns a validated extraction into downloadable formats.
 * JSON and CSV are implemented; XLSX and PDF land in phase 2 (stubs throw
 * a clear "not implemented" error so the contract stays explicit).
 */
export function exportExtraction(
  extraction: ExtractionResult,
  options: ExportOptions
): ExportResult {
  const profile = getProfileManager().getOrFallback(extraction.profileType);
  const baseName = sanitize(profile.exportConfig.filename ?? profile.id);

  switch (options.format) {
    case "json":
      return exportJson(extraction, options, `${baseName}.json`);
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

function exportJson(
  extraction: ExtractionResult,
  options: ExportOptions,
  fileName: string
): ExportResult {
  const body: Record<string, unknown> = options.includeFlags
    ? {
        profile: extraction.profileType,
        profile_version: extraction.profileVersion,
        model: extraction.model,
        fields: extraction.cleanFields,
      }
    : extraction.cleanFields;

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
  options: ExportOptions,
  fileName: string
): ExportResult {
  const columns = profile.exportConfig.csvColumns ?? Object.keys(extraction.cleanFields);
  const row = columns.map((col) => {
    const fv = extraction.fieldsMap[col];
    return csvEscape(fv ? JSON.stringify(fv.value) : "");
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
