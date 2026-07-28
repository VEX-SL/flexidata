/**
 * File Parser — extracts text from various file formats.
 * PDF → unpdf + OCR fallback, DOCX → mammoth, Excel → xlsx,
 * Images → tesseract.js, Audio → Whisper (client-side API call),
 * Video → metadata extraction.
 */

export async function parseFileBuffer(
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<string> {
  const type = mimeType.toLowerCase().split(";")[0].trim();

  // ── Text files ──
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

  // ── PDF ──
  if (type === "application/pdf") {
    return extractPdfText(buffer);
  }

  // ── DOCX ──
  if (
    type ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocxText(buffer);
  }

  // ── Excel ──
  if (
    type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    type === "application/vnd.ms-excel"
  ) {
    return extractExcelText(buffer);
  }

  // ── Images ──
  if (type.startsWith("image/")) {
    return extractImageText(buffer);
  }

  // ── Audio ──
  if (type.startsWith("audio/")) {
    return extractAudioText(buffer, fileName);
  }

  // ── Video ──
  if (type.startsWith("video/")) {
    return extractVideoText(buffer, fileName);
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
  const { isCanvasAvailable } = await import("@/lib/pdf-canvas");
  if (!isCanvasAvailable()) return "";

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

async function extractAudioText(buffer: Buffer, fileName?: string): Promise<string> {
  try {
    const name = fileName || "audio.wav";

    // Send to the transcription API
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: "audio/mpeg" });
    formData.append("file", blob, name);

    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000"
      : "http://localhost:3000";

    const res = await fetch(`${baseUrl}/api/audio/transcribe`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      // Fallback: return basic audio info
      const sizeKB = Math.round(buffer.length / 1024);
      return `[Audio file: ${name} (${sizeKB}KB). Transcription unavailable — upload via the chat interface for transcription.]`;
    }

    const data = await res.json();
    if (data.text) {
      return `**Audio Transcription** (${name}):\n\n${data.text}`;
    }
    return `[Audio file: ${name} — no speech detected]`;
  } catch (err) {
    console.error("[Parser] Audio extraction failed:", err);
    const sizeKB = Math.round(buffer.length / 1024);
    return `[Audio file: ${fileName || "unknown"} (${sizeKB}KB). Transcription requires the file to be uploaded through the chat interface.]`;
  }
}

async function extractVideoText(buffer: Buffer, fileName?: string): Promise<string> {
  const sizeKB = Math.round(buffer.length / 1024);
  const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);

  // Extract basic info from the buffer
  let videoInfo = `**Video file**: ${fileName || "unknown"}\n`;
  videoInfo += `- Size: ${sizeMB}MB\n`;
  videoInfo += `- Format: ${fileName?.split(".").pop()?.toUpperCase() || "Unknown"}\n`;

  // Try to detect video codec info from container headers
  try {
    if (buffer.length > 12) {
      // Check for MP4/MOV container (ftyp box)
      if (buffer.toString("ascii", 4, 8) === "ftyp") {
        const brand = buffer.toString("ascii", 8, 12).trim();
        videoInfo += `- Container: MP4 (${brand})\n`;
      }
      // Check for WebM (EBML header)
      else if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
        videoInfo += `- Container: WebM/Matroska\n`;
      }
      // Check for AVI
      else if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "AVI ") {
        videoInfo += `- Container: AVI\n`;
      }
    }
  } catch {}

  videoInfo += `\n*To extract audio transcription from this video, upload it through the chat interface.*`;

  return videoInfo;
}
