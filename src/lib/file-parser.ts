/**
 * File Parser — extracts text from various file formats.
 * PDF → unpdf + OCR fallback, DOCX → mammoth, Excel → xlsx,
 * Images → main-thread OCR (tesseract.js-core), Audio → Whisper,
 * Video → metadata extraction.
 */
import fs from "fs";

import { recognizeMainThread } from "@/lib/tesseract-main";
import type { OcrDocument } from "@/lib/pipeline/types";
import { runVisionOCR, visionNormalizedBBoxToPixelBox } from "@/lib/ocr/vision-service";
import { imageDimensionsFromBuffer } from "@/lib/ocr/image-dims";
import type { ReceiptExtraction } from "@/lib/ocr/vision-service";
import { OCR_TIMEOUT_MS } from "@/lib/ocr/recall";
import { postProcessOcr } from "@/lib/ocr/arabic";
import { countArabicLetters } from "@/lib/ocr/arabic/scripts";

const ARABIC_PRESENTATION_FORMS = /[\uFB50-\uFDFF\uFE70-\uFEFF]/gu;

const VISION_PDF_MAX_PAGES = 24;

/**
 * Arabic PDF text layers are often glyph-level garbage: exporters encode each
 * Arabic letter as its isolated presentation form (U+FB50–U+FEFF) and drop the
 * word separators, so the extracted "text" is presentation forms glued into one
 * unreadable run (plus stray Latin from a broken ToUnicode map). Such a layer
 * must not feed the extractor — it deserves a real OCR pass instead.
 */
export function isGarbageArabicTextLayer(text: string): boolean {
  const arabicCount = countArabicLetters(text);
  if (arabicCount === 0) return false;
  const presentation = (text.match(ARABIC_PRESENTATION_FORMS) || []).length;
  if (presentation / arabicCount > 0.25) return true;
  let arabicTokens = 0;
  let arabicLettersInTokens = 0;
  for (const token of text.split(/\s+/)) {
    const n = countArabicLetters(token);
    if (n > 0) {
      arabicTokens += 1;
      arabicLettersInTokens += n;
    }
  }
  if (arabicTokens === 0) return false;
  // Real Arabic words are ~4–8 letters; 25+ letters per whitespace token means
  // the layer glued whole lines together with no separators.
  return arabicLettersInTokens / arabicTokens > 25;
}

// Bound every OCR call with a hard timeout so the pipeline can never get
// stuck; on failure the caller falls back to the "no text" path. The same
// constant drives the recall-recovery dynamic budget (see @/lib/ocr/recall).

function withOcrTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`OCR timed out after ${OCR_TIMEOUT_MS}ms`)),
      OCR_TIMEOUT_MS
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export interface ParseResult {
  text: string;
  /** Structured OCR document (word-level confidence) when available. */
  ocr?: OcrDocument;
  /** Structured extraction from Gemini Vision (images only, when available). */
  visionExtraction?: ReceiptExtraction;
}

export async function parseFileBuffer(
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<string> {
  return (await parseFileBufferDetailed(buffer, mimeType, fileName)).text;
}

export async function parseFileBufferDetailed(
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<ParseResult> {
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
    return { text: buffer.toString("utf-8").slice(0, 500_000) };
  }

  // Handle common unknown types as text (Windows sometimes sends .txt as octet-stream)
  if (type === "application/octet-stream") {
    const text = buffer.toString("utf-8");
    const nonTextRatio =
      (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length / Math.max(text.length, 1);
    if (nonTextRatio < 0.1) return { text: text.slice(0, 500_000) };
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
    return { text: await extractDocxText(buffer) };
  }

  // ── Excel ──
  if (
    type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    type === "application/vnd.ms-excel"
  ) {
    return { text: await extractExcelText(buffer) };
  }

  // ── Images ──
  if (type.startsWith("image/")) {
    return extractImageText(buffer);
  }

  // ── Audio ──
  if (type.startsWith("audio/")) {
    return { text: await extractAudioText(buffer, fileName) };
  }

  // ── Video ──
  if (type.startsWith("video/")) {
    return { text: await extractVideoText(buffer, fileName) };
  }

  throw new Error(`Unsupported file type: ${mimeType}`);
}

async function loadPdfJs(): Promise<any> {
  try {
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return await import("pdfjs-dist/build/pdf.mjs");
  }
}

/**
 * Tier-1 OCR for scanned/garbage PDFs: send the PDF file itself to Gemini as
 * `application/pdf` (inline data) — the model reads the whole document, so no
 * pdfjs rendering or canvas is involved and it cannot break on serverless
 * runtimes. Per-page geometry is unavailable in this mode (multi-page
 * normalized boxes are meaningless), so the returned document carries lines
 * without bboxes; the reviewer just shows no overlay for them.
 */
async function ocrPdfInline(buffer: Buffer): Promise<OcrDocument> {
  if (buffer.length > 20 * 1024 * 1024) return { text: "", lines: [] };
  const vision = await runVisionOCR(buffer, "auto", {
    mimeType: "application/pdf",
    attemptTimeoutMs: 60_000,
    maxOutputTokens: 8192,
  });
  if (!vision.success || vision.data.length === 0) {
    return { text: "", lines: [] };
  }
  const text = vision.data
    .map((l: { text: string }) => l.text)
    .join("\n")
    .trim();
  let ocr: OcrDocument = {
    text,
    language: vision.detected_language || undefined,
    lines: vision.data.map(
      (l: { text: string; confidence: number }) => ({
        text: l.text,
        confidence: l.confidence,
        words: l.text
          .split(/\s+/)
          .filter((w: string) => w.length > 0)
          .map((w: string) => ({ text: w, confidence: l.confidence })),
      })
    ),
  };
  if (countArabicLetters(text) > 0) {
    ocr = postProcessOcr(ocr).doc;
  }
  return ocr;
}

async function extractPdfText(buffer: Buffer): Promise<ParseResult> {
  try {
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(buffer));
    const cleaned = (result.text || []).join("\n").trim();

    // Re-OCR when the PDF looks scanned (little embedded text) OR when its
    // Arabic text layer is glyph-level garbage (presentation forms, glued
    // words) — common with exported RTL PDFs whose ToUnicode map is broken.
    const needsReOcr =
      cleaned.length < 500 ||
      (countArabicLetters(cleaned) > 0 && isGarbageArabicTextLayer(cleaned));

    if (needsReOcr) {
      const isGarbage =
        countArabicLetters(cleaned) > 0 && isGarbageArabicTextLayer(cleaned);
      // Tier 1: hand the whole PDF straight to Gemini as application/pdf. No
      // pdfjs/canvas in the loop, so it cannot break on serverless runtimes.
      try {
        const inline = await ocrPdfInline(buffer);
        if (
          inline.text.trim() &&
          (isGarbage || inline.text.length > cleaned.length)
        ) {
          console.debug(
            `[Parser] PDF whole-file Vision OCR: ${inline.lines.length} lines`
          );
          return { text: inline.text.slice(0, 500_000), ocr: inline };
        }
      } catch (e) {
        console.error("[Parser] PDF inline Vision failed:", e);
      }
      // Tier 2: per-page rendering (pdfjs + canvas) — Vision-first per page,
      // tesseract fallback. The old length check stays only for scanned PDFs;
      // garbage text layers accept any non-empty reading.
      try {
        const ocr = await ocrPdfPages(buffer);
        if (
          ocr.text.trim() &&
          (isGarbage || ocr.text.length > cleaned.length)
        ) {
          return { text: ocr.text.slice(0, 500_000), ocr };
        }
      } catch (e) {
        console.error("[Parser] PDF OCR failed:", e);
      }
    }

    if (cleaned.length >= 50) {
      return { text: cleaned.slice(0, 500_000) };
    }
    return extractImageText(buffer);
  } catch (err) {
    console.error("[Parser] PDF extraction failed:", err);
    throw new Error("Failed to parse PDF file");
  }
}

async function ocrPdfPages(buffer: Buffer): Promise<OcrDocument> {
  const { isCanvasAvailable } = await import("@/lib/pdf-canvas");
  if (!isCanvasAvailable()) return { text: "", lines: [] };

  const pdfjsLib = await loadPdfJs();
  const { createCanvas } = await import("@/lib/pdf-canvas");

  pdfjsLib.GlobalWorkerOptions.workerSrc = "";
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const allLines: OcrDocument["lines"] = [];
  const chunks: string[] = [];

  // Overall per-PDF recovery budget: only suspicious pages run recovery, and
  // the total recovery spend across all pages is capped so a multi-page scan
  // can never blow its OCR time budget.
  const PDF_RECOVERY_BUDGET_MS = 6_000;
  let pdfRecoverySpentMs = 0;
  let visionAvailable = true;

  for (let i = 1; i <= doc.numPages; i++) {
    if (visionAvailable && doc.numPages > VISION_PDF_MAX_PAGES) {
      visionAvailable = false;
    }
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });

    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");

    await page.render({
      canvasContext: ctx as any,
      canvas: canvas as any,
      viewport,
    } as any).promise;

    // Vision-first per page — the same Gemini OCR the image path uses, which
    // reads clear Arabic far better than tesseract. On any failure we degrade
    // to the legacy tesseract branch for the rest of the document.
    if (visionAvailable && typeof canvas.toBuffer === "function") {
      try {
        const pageDoc = await visionOcrPdfPage(
          canvas,
          viewport.width,
          viewport.height
        );
        if (pageDoc.text.trim()) {
          chunks.push(pageDoc.text);
          allLines.push(...pageDoc.lines);
          continue;
        }
      } catch (e) {
        console.error(`[PDF Vision] page ${i} failed:`, e);
        visionAvailable = false;
      }
    }

    const imageData = ctx.getImageData(0, 0, viewport.width, viewport.height);
    const pageOcr = await withOcrTimeout(
      recognizeMainThread(imageData, "ara+eng", {
        recoverRecall: true,
        recoveryBudgetMs: Math.max(0, PDF_RECOVERY_BUDGET_MS - pdfRecoverySpentMs),
      })
    );
    const rec = pageOcr.meta?.recallRecovery as
      | { elapsedMs?: unknown }
      | undefined;
    if (rec && typeof rec.elapsedMs === "number") {
      pdfRecoverySpentMs += rec.elapsedMs;
    }
    if (pageOcr.text.trim()) {
      chunks.push(pageOcr.text);
      allLines.push(...pageOcr.lines);
    }
  }

  return { text: chunks.join("\n").trim(), lines: allLines };
}

async function visionOcrPdfPage(
  canvas: unknown,
  width: number,
  height: number
): Promise<OcrDocument> {
  const png = (canvas as any).toBuffer("image/png") as Buffer;
  const vision = await runVisionOCR(png, "auto");
  if (!vision.success) {
    throw new Error(vision.error || "Vision OCR failed");
  }
  const text = vision.data
    .map((l: { text: string }) => l.text)
    .join("\n")
    .trim();
  let ocr: OcrDocument = {
    text,
    language: vision.detected_language || undefined,
    lines: vision.data.map(
      (l: {
        text: string;
        confidence: number;
        bbox?: [number, number, number, number];
      }) => ({
        text: l.text,
        confidence: l.confidence,
        ...(l.bbox !== undefined
          ? { bbox: visionNormalizedBBoxToPixelBox(l.bbox, width, height) }
          : {}),
        words: l.text
          .split(/\s+/)
          .filter((w: string) => w.length > 0)
          .map((w: string) => ({ text: w, confidence: l.confidence })),
      })
    ),
  };
  if (countArabicLetters(text) > 0) {
    ocr = postProcessOcr(ocr).doc;
  }
  return ocr;
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

async function extractImageText(buffer: Buffer): Promise<ParseResult> {
  // Gemini Vision handles BOTH OCR text and structured extraction in one call.
  // No Tesseract — eliminates 400MB+ WASM load, prevents Vercel OOM/502.
  try {
    const vision = await runVisionOCR(buffer, "auto");
    if (!vision.success) {
      console.error("[Vision OCR Error]:", vision.error);
      return { text: "", ocr: undefined, visionExtraction: undefined };
    }

    const text = vision.data
      .map((l: { text: string }) => l.text)
      .join("\n")
      .trim();

    // Convert each line's normalized bbox (0..1000) into the pipeline's
    // pixel-space BBox so the inspector can draw regions on the image.
    // No pixels are lost when the model omits coordinates — lines simply keep
    // no bbox and the inspector falls back to no overlay for that field.
    const dims = imageDimensionsFromBuffer(buffer);

    // Build a minimal OcrDocument from Gemini lines so the grounding stage
    // still has structured OCR evidence; lines carry pixel bboxes when the
    // model returned normalized coordinates.
    let ocr: OcrDocument = {
      text,
      language: vision.detected_language || undefined,
      lines: vision.data.map((l: { text: string; confidence: number; bbox?: [number, number, number, number] }) => ({
        text: l.text,
        confidence: l.confidence,
        ...(dims !== null && l.bbox !== undefined
          ? { bbox: visionNormalizedBBoxToPixelBox(l.bbox, dims.w, dims.h) }
          : {}),
        words: l.text
          .split(/\s+/)
          .filter((w: string) => w.length > 0)
          .map((w: string) => ({ text: w, confidence: l.confidence })),
      })),
    };
    let outText = text;

    // Arabic-first OCR repair (same layer the scanned-PDF path uses): normalize
    // alef/yeh variants and kashida, reassemble isolated letters, unify digit
    // families and report per-line quality — all gated so text is never
    // invented or deleted. Applies whenever the reading contains Arabic script.
    if (countArabicLetters(text) > 0) {
      const repaired = postProcessOcr(ocr);
      ocr = repaired.doc;
      outText = repaired.doc.text;
      if (repaired.report.linesChanged > 0) {
        console.debug(
          `[Vision OCR] Arabic repair applied to ${repaired.report.linesChanged} line(s)`
        );
      }
    }

    return {
      text: outText || "[No text found in image]",
      ocr,
      ...(vision.extraction !== undefined ? { visionExtraction: vision.extraction } : {}),
    };
  } catch (err) {
    console.error("[Vision OCR Error]:", err);
    return { text: "", ocr: undefined, visionExtraction: undefined };
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
