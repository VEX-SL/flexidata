/**
 * File Parser — extracts text from various file formats.
 * PDF → unpdf + OCR fallback, DOCX → mammoth, Excel → xlsx,
 * Images → main-thread OCR (tesseract.js-core), Audio → Whisper,
 * Video → metadata extraction.
 */
import fs from "fs";

import { recognizeMainThread } from "@/lib/tesseract-main";
import type { OcrDocument } from "@/lib/pipeline/types";
import { runVisionOCR } from "@/lib/ocr/vision-service";
import type { ReceiptExtraction } from "@/lib/ocr/vision-service";
import { OCR_TIMEOUT_MS } from "@/lib/ocr/recall";

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

async function extractPdfText(buffer: Buffer): Promise<ParseResult> {
  try {
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(buffer));
    const cleaned = (result.text || []).join("\n").trim();

    // If text is short (scanned/image PDF), render each page to image then OCR
    if (cleaned.length < 500) {
      try {
        const ocr = await ocrPdfPages(buffer);
        if (ocr.text.length > cleaned.length) {
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

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
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
      return { text: "[Could not extract text from image]" };
    }

    const text = vision.data
      .map((l: { text: string }) => l.text)
      .join("\n")
      .trim();

    // Build a minimal OcrDocument from Gemini lines so the grounding stage
    // still has structured OCR evidence (no bboxes — grounding uses text
    // matching instead of spatial alignment when bboxes are absent).
    const ocr: OcrDocument = {
      text,
      language: vision.detected_language || undefined,
      lines: vision.data.map((l: { text: string; confidence: number }) => ({
        text: l.text,
        confidence: l.confidence,
        words: l.text
          .split(/\s+/)
          .filter((w: string) => w.length > 0)
          .map((w: string) => ({ text: w, confidence: l.confidence })),
      })),
    };

    return {
      text: text || "[No text found in image]",
      ocr,
      ...(vision.extraction !== undefined ? { visionExtraction: vision.extraction } : {}),
    };
  } catch (err) {
    console.error("[Parser] Gemini Vision OCR failed:", err);
    return { text: "[Could not extract text from image]" };
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
