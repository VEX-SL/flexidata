/**
 * File Parser — extracts text from various file formats.
 * PDF → pdfjs-dist (legacy), DOCX → mammoth, Excel → xlsx, Images → tesseract.js
 * Video/Audio parsing will be added in Milestone 3 (ffmpeg + Whisper).
 */

export async function parseFileBuffer(
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<string> {
  const type = mimeType.toLowerCase().split(";")[0].trim();

  if (
    type === "text/plain" ||
    type === "application/json" ||
    type === "text/markdown" ||
    type === "text/csv" ||
    type === "text/html" ||
    type === "text/xml" ||
    type === "text/css" ||
    type === "text/javascript" ||
    type.startsWith("text/")
  ) {
    return buffer.toString("utf-8").slice(0, 500_000);
  }

  // Handle common unknown types as text (Windows sometimes sends .txt as octet-stream)
  if (type === "application/octet-stream") {
    const text = buffer.toString("utf-8");
    const nonTextRatio =
      (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length / Math.max(text.length, 1);
    if (nonTextRatio < 0.1) return text.slice(0, 500_000);
    throw new Error(`Binary file cannot be parsed as text`);
  }

  if (type === "application/pdf") {
    return extractPdfText(buffer);
  }

  if (
    type ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocxText(buffer);
  }

  if (
    type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    type === "application/vnd.ms-excel"
  ) {
    return extractExcelText(buffer);
  }

  if (type.startsWith("image/")) {
    return extractImageText(buffer);
  }

  throw new Error(`Unsupported file type: ${mimeType}`);
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(buffer));
    const cleaned = (result.text || []).join("\n").trim();

    // If text is short (scanned/image PDF), render each page to image then OCR
    if (cleaned.length < 500) {
      try {
        const ocrText = await ocrPdfPages(buffer);
        if (ocrText.length > cleaned.length) {
          return ocrText.slice(0, 500_000);
        }
      } catch (e) {
        console.error("[Parser] PDF OCR failed:", e);
      }
    }

    if (cleaned.length >= 50) {
      return cleaned.slice(0, 500_000);
    }
    return await extractImageText(buffer);
  } catch (err) {
    console.error("[Parser] PDF extraction failed:", err);
    throw new Error("Failed to parse PDF file");
  }
}

async function ocrPdfPages(buffer: Buffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@/lib/pdf-canvas");
  const Tesseract = await import("tesseract.js");

  pdfjsLib.GlobalWorkerOptions.workerSrc = "";
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  let allText = "";

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });

    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");

    await page.render({
      canvasContext: ctx as any,
      canvas: canvas as any,
      viewport,
    } as any).promise;

    const imageData = ctx.getImageData(0, 0, viewport.width, viewport.height);
    const { data: { text } } = await Tesseract.default.recognize(imageData, "ara+eng", { logger: () => {} });
    if (text.trim()) {
      allText += text + "\n";
    }
  }

  return allText.trim();
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || "";
  } catch (err) {
    console.error("[Parser] DOCX extraction failed:", err);
    throw new Error("Failed to parse Word document");
  }
}

async function extractExcelText(buffer: Buffer): Promise<string> {
  try {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    let text = "";
    for (const sheetName of workbook.SheetNames) {
      text += `\n--- Sheet: ${sheetName} ---\n`;
      text += XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
    }
    return text.trim().slice(0, 500_000);
  } catch (err) {
    console.error("[Parser] Excel extraction failed:", err);
    throw new Error("Failed to parse Excel file");
  }
}

async function extractImageText(buffer: Buffer): Promise<string> {
  try {
    const Tesseract = await import("tesseract.js");
    const {
      data: { text },
    } = await Tesseract.default.recognize(buffer, "ara+eng", {
      logger: () => {},
    });
    return text?.trim() || "[No text found in image]";
  } catch (err) {
    console.error("[Parser] OCR failed:", err);
    return "[Could not extract text from image]";
  }
}
