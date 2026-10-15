import * as fs from "node:fs";
import * as path from "node:path";
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { toVisualOrder } from "@/lib/ocr/arabic/visual";
import { isEmptyValue } from "./extractor/post-processor";
import type { ExportResult, ExtractionResult } from "./types";
import type { ExportMeta } from "./exporter";

/**
 * PDF export — a rendered extraction report that mirrors the Word export:
 * title, the verbatim OCR lines, then the extracted fields as a table.
 *
 * Two things make this "just work" for an Arabic-first product:
 *
 *  1. **A real Arabic font.** Amiri (SIL OFL, bundled in `public/fonts`) is
 *     embedded through fontkit, so Arabic glyphs come from the file rather
 *     than from a Latin-only standard font that could not draw them at all.
 *  2. **Shaping + bidi.** pdf-lib draws a run left-to-right and never applies
 *     GSUB, so `toVisualOrder()` pre-shapes every Arabic letter (isolated /
 *     final / initial / medial + lam-alef) and reorders the run right-to-left
 *     before the text is measured or drawn. Numbers and embedded Latin stay
 *     left-to-right.
 *
 * Everything is laid out right-aligned, like the document it transcribes.
 * If the font files cannot be reached at all, the report still ships using the
 * built-in Latin fonts — Arabic text is then dropped by the charset filter
 * instead of crashing the export.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const RIGHT = PAGE_W - MARGIN;
const MAX_W = PAGE_W - MARGIN * 2;

const PAD = 6;
const ROW_H = 11;
const LH = ROW_H * 1.6;

const INK = rgb(0.12, 0.12, 0.12);
const MUTED = rgb(0.44, 0.44, 0.44);
const RULE = rgb(0.8, 0.8, 0.8);
const HEAD_BG = rgb(0.93, 0.93, 0.93);
const ZEBRA = rgb(0.972, 0.972, 0.972);
const WHITE = rgb(1, 1, 1);

const FONT_FILES = {
  regular: "Amiri-Regular.ttf",
  bold: "Amiri-Bold.ttf",
} as const;

const fontCache = new Map<string, Uint8Array>();

/**
 * Load a bundled font. Same strategy as the OCR traineddata loader: the
 * filesystem copy first (Vercel ships `public/` inside `/var/task`), then an
 * HTTP fetch from the app origin as a last resort.
 */
async function fontBytes(fileName: string): Promise<Uint8Array | null> {
  const cached = fontCache.get(fileName);
  // Hand out a copy: the embedder keeps the buffer alive for the life of the
  // document, so two concurrent exports must never share one instance.
  if (cached) return cached.slice();

  const candidates = [
    path.join(/* turbopackIgnore: true */ process.cwd(), "public", "fonts", fileName),
    path.resolve("public", "fonts", fileName),
    `/var/task/public/fonts/${fileName}`,
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const bytes = new Uint8Array(fs.readFileSync(candidate));
        if (bytes.length > 1_000) {
          fontCache.set(fileName, bytes);
          return bytes;
        }
      }
    } catch {
      // try the next candidate
    }
  }

  const bases: string[] = ["https://flexidata.vercel.app"];
  if (process.env.VERCEL_URL) bases.unshift(`https://${process.env.VERCEL_URL}`);
  for (const base of bases) {
    try {
      const resp = await fetch(`${base}/fonts/${fileName}`);
      if (resp.ok) {
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (bytes.length > 1_000) {
          fontCache.set(fileName, bytes);
          return bytes;
        }
      }
    } catch {
      // try the next base
    }
  }

  return null;
}

/** Embedded Arabic font, or the built-in Latin fonts when it is unavailable. */
async function loadFonts(pdf: PDFDocument): Promise<[PDFFont, PDFFont]> {
  try {
    const [regular, bold] = await Promise.all([
      fontBytes(FONT_FILES.regular),
      fontBytes(FONT_FILES.bold),
    ]);
    if (regular && bold) {
      pdf.registerFontkit(fontkit);
      return [
        await pdf.embedFont(regular, { subset: true }),
        await pdf.embedFont(bold, { subset: true }),
      ];
    }
  } catch {
    // fall through to the built-in fonts
  }
  return [
    await pdf.embedFont(StandardFonts.Helvetica),
    await pdf.embedFont(StandardFonts.HelveticaBold),
  ];
}

/** Drop anything the font cannot draw (control chars, glyphs outside cmap). */
function sanitize(text: string, font: PDFFont): string {
  const allowed = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") continue;
    if (ch === "\t") {
      out += " ";
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (allowed.has(code)) out += ch;
  }
  return out;
}

/** Logical text → the glyph sequence to draw left-to-right. */
function toGlyphs(font: PDFFont, logical: string): string {
  return toVisualOrder(sanitize(logical, font));
}

function measure(font: PDFFont, size: number, glyphs: string): number {
  if (!glyphs) return 0;
  try {
    return font.widthOfTextAtSize(glyphs, size);
  } catch {
    return glyphs.length * size * 0.5;
  }
}

/**
 * Wrap *logical* text to `maxWidth`. Wrapping happens before shaping so each
 * produced line is shaped independently — which is exactly right, because a
 * line break terminates the joining context in Arabic anyway.
 */
function wrap(
  font: PDFFont,
  size: number,
  maxWidth: number,
  logical: string
): string[] {
  const fits = (candidate: string) =>
    measure(font, size, toGlyphs(font, candidate)) <= maxWidth;

  const lines: string[] = [];
  const words = logical.split(/\s+/).filter((w) => w.length > 0);
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (fits(word)) {
      current = word;
      continue;
    }
    // A single token is wider than the column — break it by characters so it
    // can never run off the page (long URLs, hashes, machine IDs).
    let rest = word;
    while (rest.length > 0) {
      if (fits(rest)) {
        lines.push(rest);
        break;
      }
      let take = rest.length;
      while (take > 1 && !fits(rest.slice(0, take))) take--;
      lines.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface Column {
  label: string;
  x: number;
  width: number;
}

export async function exportPdf(
  extraction: ExtractionResult,
  meta: ExportMeta,
  fileName: string
): Promise<ExportResult> {
  const pdf = await PDFDocument.create();
  const [regular, bold] = await loadFonts(pdf);

  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  const ensure = (height: number) => {
    if (y - height < MARGIN) newPage();
  };

  /** Draw one logical line, right-aligned; returns nothing. */
  const line = (
    logical: string,
    opts: { size: number; font?: PDFFont; color?: ReturnType<typeof rgb>; gap: number }
  ) => {
    const font = opts.font ?? regular;
    const glyphs = toGlyphs(font, logical);
    if (glyphs) {
      const width = measure(font, opts.size, glyphs);
      page.drawText(glyphs, {
        x: Math.max(MARGIN, RIGHT - width),
        y,
        size: opts.size,
        font,
        color: opts.color ?? INK,
      });
    }
    y -= opts.gap;
  };

  const heading = (logical: string, size: number) => {
    ensure(size * 3);
    line(logical, { size, font: bold, gap: size * 2.1 });
  };

  /* ── Title ──────────────────────────────────────────────────────────── */
  line("مستند الاستخراج", { size: 20, font: bold, gap: 30 });

  const count = extraction.fields.filter((f) => !isEmptyValue(f.value.value)).length;
  const subtitle =
    (count > 0 ? `${count} حقل مستخرج` : "بدون حقول مستخرجة") +
    (typeof meta.confidence === "number"
      ? ` · الثقة ${Math.round(meta.confidence * 100)}٪`
      : "");
  line(subtitle, { size: 11, color: MUTED, gap: 24 });

  page.drawRectangle({ x: MARGIN, y, width: MAX_W, height: 0.7, color: RULE });
  y -= 24;

  /* ── Verbatim OCR text ──────────────────────────────────────────────── */
  heading("النص المستخرج من OCR", 14);

  const ocrLines = (meta.ocrText ?? "").split("\n").filter((l: string) => l.length > 0);
  if (ocrLines.length === 0) {
    line("(لا يوجد نص OCR)", { size: ROW_H, color: MUTED, gap: 20 });
  } else {
    for (const ocrLine of ocrLines) {
      const wrapped = wrap(regular, ROW_H, MAX_W, ocrLine);
      for (const piece of wrapped) {
        ensure(LH);
        line(piece, { size: ROW_H, gap: LH });
      }
      y -= 4;
    }
  }
  y -= 12;

  /* ── Extracted fields table ─────────────────────────────────────────── */
  const rows = extraction.fields.filter((f) => !isEmptyValue(f.value.value));

  // Reserve the heading, the header row and the first data row together so the
  // heading can never be left orphaned at the foot of a page.
  const firstRowHeight = Math.max(24, PAD * 2 + LH);
  if (rows.length > 0) ensure(14 * 3 + 24 + firstRowHeight);
  heading("الحقول المستخرجة", 14);

  const w1 = MAX_W * 0.26;
  const w2 = MAX_W * 0.54;
  const w3 = MAX_W * 0.2;
  const columns: Column[] = [
    { label: "الحقل", x: RIGHT - w1, width: w1 },
    { label: "القيمة", x: RIGHT - w1 - w2, width: w2 },
    { label: "الثقة", x: RIGHT - w1 - w2 - w3, width: w3 },
  ];

  const drawCell = (pieces: string[], column: Column, top: number) => {
    pieces.forEach((piece, i) => {
      const glyphs = toGlyphs(regular, piece);
      if (!glyphs) return;
      const width = measure(regular, ROW_H, glyphs);
      page.drawText(glyphs, {
        x: Math.max(
          column.x + PAD,
          column.x + column.width - PAD - width
        ),
        y: top - PAD - ROW_H * 0.72 - i * LH,
        size: ROW_H,
        font: regular,
        color: INK,
      });
    });
  };

  const drawHeader = () => {
    const headerH = 24;
    const top = y;
    for (const column of columns) {
      page.drawRectangle({
        x: column.x,
        y: top - headerH,
        width: column.width,
        height: headerH,
        color: HEAD_BG,
        borderColor: RULE,
        borderWidth: 0.5,
      });
      const glyphs = toGlyphs(bold, column.label);
      if (!glyphs) continue;
      const width = measure(bold, ROW_H, glyphs);
      page.drawText(glyphs, {
        x: Math.max(
          column.x + PAD,
          column.x + column.width - PAD - width
        ),
        y: top - (headerH + ROW_H * 0.72) / 2 - 1,
        size: ROW_H,
        font: bold,
        color: INK,
      });
    }
    y -= headerH;
  };

  if (rows.length === 0) {
    line("—", { size: ROW_H, color: MUTED, gap: 16 });
  } else {
    drawHeader();

    rows.forEach((f, index) => {
      const label =
        f.field.label && f.field.label !== f.field.key
          ? f.field.label
          : f.field.key;
      const value =
        typeof f.value.value === "string"
          ? f.value.value
          : JSON.stringify(f.value.value);
      const confidence = `${Math.round((f.value.confidence ?? 0) * 100)}٪`;

      const cells = [
        wrap(regular, ROW_H, columns[0].width - PAD * 2, label),
        wrap(regular, ROW_H, columns[1].width - PAD * 2, value),
        wrap(regular, ROW_H, columns[2].width - PAD * 2, confidence),
      ];
      const lines = Math.max(
        cells[0].length,
        cells[1].length,
        cells[2].length
      );
      const rowHeight = Math.max(24, PAD * 2 + lines * LH);

      if (y - rowHeight < MARGIN) {
        // Start a fresh page and repeat the header so the table stays readable.
        newPage();
        drawHeader();
      }

      const top = y;
      const background = index % 2 === 1 ? ZEBRA : WHITE;
      for (const column of columns) {
        page.drawRectangle({
          x: column.x,
          y: top - rowHeight,
          width: column.width,
          height: rowHeight,
          color: background,
          borderColor: RULE,
          borderWidth: 0.5,
        });
      }

      drawCell(cells[0], columns[0], top);
      drawCell(cells[1], columns[1], top);
      drawCell(cells[2], columns[2], top);

      y -= rowHeight;
    });
  }

  /* ── Footer ─────────────────────────────────────────────────────────── */
  const pages = pdf.getPages();
  const totalPages = pages.length;
  for (let i = 0; i < totalPages; i++) {
    const glyphs = toGlyphs(regular, `صفحة ${i + 1} / ${totalPages}`);
    if (!glyphs) continue;
    const width = measure(regular, 9, glyphs);
    pages[i].drawText(glyphs, {
      x: Math.max(MARGIN, RIGHT - width),
      y: MARGIN - 30,
      size: 9,
      font: regular,
      color: MUTED,
    });
  }

  return {
    format: "pdf",
    // Object streams are valid PDF but make the file harder to inspect with
    // simple tooling; this report is small, so keep the structure plain.
    buffer: await pdf.save({ useObjectStreams: false }),
    mimeType: "application/pdf",
    fileName,
  };
}
