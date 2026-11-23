import { Buffer } from "node:buffer";
import ExcelJS from "exceljs";

const MAX_EXCEL_TEXT_LENGTH = 500_000;
const MAX_ROWS_PER_SHEET = 50_000;
const MAX_COLS_PER_ROW = 250;

function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str = "";

  if (value instanceof Date) {
    str = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  } else if (typeof value === "object") {
    const obj = value as {
      text?: unknown;
      result?: unknown;
      richText?: Array<{ text?: string }>;
      hyperlink?: string;
    };
    if (Array.isArray(obj.richText)) {
      str = obj.richText.map((part) => part.text ?? "").join("");
    } else if (obj.result !== undefined && obj.result !== null) {
      str =
        obj.result instanceof Date
          ? Number.isNaN(obj.result.getTime())
            ? ""
            : obj.result.toISOString()
          : String(obj.result);
    } else if (typeof obj.text === "string") {
      str = obj.text;
    } else if (typeof obj.hyperlink === "string") {
      str = obj.hyperlink;
    } else {
      str = JSON.stringify(value);
    }
  } else {
    str = String(value);
  }

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function extractCellPrimitive(cell: ExcelJS.Cell): unknown {
  const val = cell.value;
  if (val === null || val === undefined) return "";
  if (typeof val === "object" && "error" in val && val.error) {
    return String(val.error);
  }
  return val;
}

export async function excelBufferToText(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS expects Buffer/ArrayBuffer-compatible input
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  let output = "";
  for (const worksheet of workbook.worksheets) {
    if (output.length >= MAX_EXCEL_TEXT_LENGTH) break;

    output += `\n--- Sheet: ${worksheet.name} ---\n`;
    const rowLimit = Math.min(worksheet.rowCount, MAX_ROWS_PER_SHEET);

    for (let r = 1; r <= rowLimit; r++) {
      const row = worksheet.getRow(r);
      const colLimit = Math.min(
        Math.max(row.cellCount, worksheet.columnCount),
        MAX_COLS_PER_ROW
      );

      const cells: string[] = [];
      let hasNonEmpty = false;
      for (let c = 1; c <= colLimit; c++) {
        const raw = extractCellPrimitive(row.getCell(c));
        const formatted = formatCsvCell(raw);
        if (formatted !== "") hasNonEmpty = true;
        cells.push(formatted);
      }

      if (hasNonEmpty) {
        output += `${cells.join(",")}\n`;
      }
      if (output.length >= MAX_EXCEL_TEXT_LENGTH) break;
    }
  }

  return output.trim().slice(0, MAX_EXCEL_TEXT_LENGTH);
}