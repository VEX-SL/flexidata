import ExcelJS from "exceljs";

export interface ExcelFieldDetailRow {
  key: string;
  label: string;
  value: string | number | boolean;
  confidencePercent: number;
  source: string;
  status: string;
}

export interface ExcelHeaders {
  field: string;
  label: string;
  value: string;
  confidencePercent: string;
  source: string;
  status: string;
  ocrTextHeader: string;
}

export interface BuildExtractionWorkbookInput {
  flatHeaders: string[];
  flatValues: Array<string | number | boolean>;
  fieldRows: ExcelFieldDetailRow[];
  ocrLines: string[];
  headers?: Partial<ExcelHeaders>;
  rtl?: boolean;
}

const DEFAULT_HEADERS: ExcelHeaders = {
  field: "Field",
  label: "Label",
  value: "Value",
  confidencePercent: "Confidence (%)",
  source: "Source",
  status: "Status",
  ocrTextHeader: "Extracted OCR Text",
};

function calcColWidth(...values: unknown[]): number {
  const longest = values.reduce<number>(
    (max, v) => Math.max(max, String(v ?? "").length),
    0
  );
  return Math.min(60, Math.max(14, longest + 4));
}

export async function buildExtractionWorkbookBuffer(
  input: BuildExtractionWorkbookInput
): Promise<Uint8Array> {
  const h: ExcelHeaders = { ...DEFAULT_HEADERS, ...input.headers };
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FlexiData";
  workbook.created = new Date();

  const sheetViews = input.rtl ? [{ rightToLeft: true }] : undefined;

  // Sheet 1: Extraction (flat record)
  const flatSheet = workbook.addWorksheet("Extraction", { views: sheetViews });
  flatSheet.addRow(input.flatHeaders);
  flatSheet.addRow(input.flatValues);
  flatSheet.getRow(1).font = { bold: true };
  flatSheet.columns = input.flatHeaders.map((label, i) => ({
    width: calcColWidth(label, input.flatValues[i]),
  }));

  // Sheet 2: Fields (per-field readable report)
  const detailSheet = workbook.addWorksheet("Fields", { views: sheetViews });
  detailSheet.addRow([
    h.field,
    h.label,
    h.value,
    h.confidencePercent,
    h.source,
    h.status,
  ]);
  detailSheet.getRow(1).font = { bold: true };

  for (const row of input.fieldRows) {
    detailSheet.addRow([
      row.key,
      row.label,
      row.value,
      row.confidencePercent,
      row.source,
      row.status,
    ]);
  }

  detailSheet.columns = [
    { width: 24 },
    { width: 26 },
    { width: 44 },
    { width: 15 },
    { width: 13 },
    { width: 13 },
  ];

  // Sheet 3: OCR (verbatim lines when present)
  if (input.ocrLines.some((l) => l.length > 0)) {
    const ocrSheet = workbook.addWorksheet("OCR", { views: sheetViews });
    ocrSheet.addRow([h.ocrTextHeader]);
    ocrSheet.getRow(1).font = { bold: true };
    for (const line of input.ocrLines) {
      ocrSheet.addRow([line]);
    }
    ocrSheet.columns = [{ width: 80 }];
  }

  const out = await workbook.xlsx.writeBuffer();
  return new Uint8Array(out as ArrayBuffer);
}