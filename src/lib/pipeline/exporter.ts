import type {
  ExportOptions,
  ExportResult,
  ExtractionResult,
  ExtractionProfile,
} from "./types";
import { getProfileManager } from "./profiles/registry";
import { isEmptyValue } from "./extractor/post-processor";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

/**
 * Exporter — turns a validated extraction into downloadable formats.
 * JSON, CSV and Word are implemented; XLSX and PDF land in phase 2 (stubs
 * throw a clear "not implemented" error so the contract stays explicit).
 */

/** Enrichment metadata (not part of the extraction result itself). */
export interface ExportMeta {
  /** Overall pipeline confidence (0..1). */
  confidence?: number;
  /** Per-signal confidence breakdown (from the confidence engine). */
  signals?: Record<string, number>;
  /** ISO timestamp of completion. */
  extractedAt?: string;
  /**
   * Verbatim OCR lines (newline-joined), as shown in the Line-level OCR
   * preview. Exported verbatim — the user asked for the text exactly as OCR
   * read it.
   */
  ocrText?: string;
}
export async function exportExtraction(
  extraction: ExtractionResult,
  options: ExportOptions,
  meta: ExportMeta = {}
): Promise<ExportResult> {
  const profile = getProfileManager().getOrFallback(extraction.profileType);
  const baseName = sanitize(profile.exportConfig.filename ?? profile.id);

  switch (options.format) {
    case "json":
      return exportJson(extraction, options, meta, `${baseName}.json`);
    case "csv":
      return exportCsv(profile, extraction, options, `${baseName}.csv`);
    case "word":
      return exportWord(extraction, meta, `${baseName}.docx`);
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
 *  - `document_type`, `confidence`, `signals`, `extracted_at`
 *  - `ocr`: the verbatim OCR lines (what "فصل النصوص في كلمة" expects — the
 *    text exactly as the OCR read it, newline-joined)
 *  - `fields`: every extracted field key → { value, confidence, source, status,
 *    edited, verified, label, raw, evidence, reasons, alternatives }. Reviewed
 *    values are what the user sees; empty values (including empty arrays) are
 *    never emitted — the export can never contain a meaningless `key: []`.
 * Every field carries the same grounded evidence + uncertainty reasons the
 * review UI shows, so the export is a faithful copy of what was extracted.
 * Provider/model metadata is deliberately NOT exported (user request).
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
      source: f.value.source,
      status: f.value.status,
      edited: f.value.status === "edited",
      verified: f.value.status === "verified",
      label: f.field.label ?? f.field.key,
      raw: f.value.rawValue,
      evidence: f.value.evidence?.map((e) => ({
        quote: e.quote,
        lineIndex: e.lineIndex,
        role: e.role,
        confidence: e.confidence,
      })),
      reasons: f.value.reasons,
      alternatives: f.value.alternatives,
    };
  }

  const body: Record<string, unknown> = {
    document_type: extraction.profileType,
    confidence: meta.confidence ?? null,
    signals: meta.signals ?? undefined,
    extracted_at: meta.extractedAt ?? null,
    ocr: meta.ocrText ?? null,
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
  // Dynamic extractions have no static column list: columns are exactly the
  // fields the extraction produced, in extraction order (deduped). Legacy
  // extractions keep the profile's configured columns (unchanged behaviour).
  const columns =
    extraction.extractionMode === "dynamic"
      ? Array.from(
          new Set(extraction.fields.map((f) => f.field.key))
        )
      : profile.exportConfig.csvColumns ?? Object.keys(extraction.cleanFields);
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

/**
 * Word export — a .docx rendered straight from the OCR reading. The document
 * body is the exact line-level OCR text (one line = one paragraph, verbatim,
 * nothing normalized or rewritten), followed by the extracted fields.
 */
async function exportWord(
  extraction: ExtractionResult,
  meta: ExportMeta,
  fileName: string
): Promise<ExportResult> {
  const lines = (meta.ocrText ?? "").split("\n").filter((l) => l.length > 0);

  const children: Array<Paragraph | Table> = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: "مستند الاستخراج", bold: true, size: 28 }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({
          text: (
            extraction.fields.length > 0
              ? `${extraction.fields.length} حقل مستخرج`
              : "بدون حقول مستخرجة"
          ) + (typeof meta.confidence === "number"
            ? ` · الثقة ${Math.round(meta.confidence * 100)}٪`
            : ""),
          size: 22,
          color: "555555",
        }),
      ],
    })
  );

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: "النص المستخرج من OCR", bold: true, size: 24 })],
    })
  );

  if (lines.length === 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: "(لا يوجد نص OCR)", color: "888888" })],
      })
    );
  }

  for (const line of lines) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: line, size: 22 })],
      })
    );
  }

  if (extraction.fields.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: "الحقول المستخرجة", bold: true, size: 24 })],
      })
    );

    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: "الحقل", bold: true })] })],
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: "القيمة", bold: true })] })],
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: "الثقة", bold: true })] })],
          }),
        ],
      }),
    ];

    for (const f of extraction.fields) {
      if (isEmptyValue(f.value.value)) continue;
      rows.push(
        new TableRow({
          children: [
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: f.field.label && f.field.label !== f.field.key
                        ? f.field.label
                        : f.field.key,
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text:
                        typeof f.value.value === "string"
                          ? f.value.value
                          : JSON.stringify(f.value.value),
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: `${Math.round((f.value.confidence ?? 0) * 100)}٪`,
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
      );
    }

    children.push(
      new Table({
        rows,
        width: { size: 100, type: WidthType.PERCENTAGE },
      })
    );
  }

  const doc = new Document({
    sections: [{ children }],
  });
  const uint8 = await Packer.toBuffer(doc);
  return {
    format: "word",
    buffer: new Uint8Array(uint8),
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileName,
  };
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "document";
}
