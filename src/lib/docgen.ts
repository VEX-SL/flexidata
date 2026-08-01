import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  NumberFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";

/* ── Inline markdown parsing ─────────────────────────────────────────── */

export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

const INLINE_RE =
  /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) segments.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) segments.push({ text: m[2], italic: true });
    else if (m[3] !== undefined) segments.push({ text: m[3], code: true });
    else if (m[4] !== undefined) segments.push({ text: m[4], strike: true });
    else if (m[5] !== undefined && m[6] !== undefined)
      segments.push({ text: m[5], link: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

export function containsRtl(text: string): boolean {
  return /[\u0590-\u08FF]/.test(text);
}

/* ── Block parsing ───────────────────────────────────────────────────── */

export type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string }
  | { type: "bullet"; items: string[] }
  | { type: "ordered"; items: string[] }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "table"; header: string[]; rows: string[][] };

const HR_RE = /^\s*(?:([-*_])\s*){3,}$/;
const BULLET_RE = /^\s*[-+*]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const stripped = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return stripped.split("|").map((c) => c.trim());
}

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  const pushParagraph = (texts: string[]) => {
    const joined = texts.join(" ").replace(/\s+/g, " ").trim();
    if (joined) blocks.push({ type: "paragraph", text: joined });
  };

  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) {
      i++;
      continue;
    }

    if (line.startsWith("```") || line.startsWith("~~~")) {
      const fence = line.slice(0, 3);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        code.push(lines[i]);
        i++;
      }
      i++;
      if (code.length) blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (/^\|?[\s:|-]+\|?$/.test(next) && next.includes("-")) {
        const header = splitTableRow(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim().includes("|")) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        blocks.push({ type: "table", header, rows });
        continue;
      }
    }

    const b = BULLET_RE.exec(line);
    if (b) {
      const items = [b[1].trim()];
      i++;
      while (i < lines.length) {
        const nb = BULLET_RE.exec(lines[i].trim());
        if (nb) {
          items.push(nb[1].trim());
          i++;
        } else if (!lines[i].trim()) {
          i++;
          break;
        } else break;
      }
      blocks.push({ type: "bullet", items });
      continue;
    }

    const o = ORDERED_RE.exec(line);
    if (o) {
      const items = [o[1].trim()];
      i++;
      while (i < lines.length) {
        const no = ORDERED_RE.exec(lines[i].trim());
        if (no) {
          items.push(no[1].trim());
          i++;
        } else if (!lines[i].trim()) {
          i++;
          break;
        } else break;
      }
      blocks.push({ type: "ordered", items });
      continue;
    }

    const q = QUOTE_RE.exec(line);
    if (q) {
      blocks.push({ type: "quote", text: q[1].trim() });
      i++;
      continue;
    }

    const texts: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim()) {
      const next = lines[i].trim();
      if (
        HEADING_RE.test(next) ||
        HR_RE.test(next) ||
        BULLET_RE.test(next) ||
        ORDERED_RE.test(next) ||
        QUOTE_RE.test(next) ||
        next.startsWith("```") ||
        (next.includes("|") && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()))
      )
        break;
      texts.push(next);
      i++;
    }
    pushParagraph(texts);
  }

  return blocks;
}

/* ── DOCX generation ─────────────────────────────────────────────────── */

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

function levelToHeading(level: number) {
  return HEADINGS[Math.min(Math.max(level, 1), 6) - 1];
}

function runsToChildren(
  text: string,
  opts?: { size?: number; color?: string }
): (TextRun | ExternalHyperlink)[] {
  return parseInline(text).map((s) => {
    if (s.link) {
      return new ExternalHyperlink({
        children: [new TextRun({ text: s.text, style: "Hyperlink" })],
        link: s.link,
      });
    }
    const props: Record<string, unknown> = {
      text: s.text,
      bold: s.bold || undefined,
      italics: s.italic || undefined,
      strike: s.strike || undefined,
    };
    if (s.code) {
      props.font = "Consolas";
      props.size = opts?.size ? Math.max(16, Math.round(opts.size * 0.85)) : 20;
      props.shading = { type: ShadingType.CLEAR, fill: "EEEEEE", color: "auto" };
    } else if (opts?.size) {
      props.size = opts.size;
    }
    if (opts?.color) props.color = opts.color;
    if (containsRtl(s.text)) props.rightToLeft = true;
    return new TextRun(props as never);
  });
}

function rtlProps(text: string): Record<string, unknown> {
  return containsRtl(text) ? { bidirectional: true } : {};
}

function codeParagraph(code: string): Paragraph {
  const lines = code.split("\n");
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: "F6F8FA", color: "auto" },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "D0D7DE" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D0D7DE" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "D0D7DE" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D0D7DE" },
    },
    spacing: { before: 120, after: 120 },
    children: lines.map(
      (line, idx) =>
        new TextRun({
          text: line,
          font: "Consolas",
          size: 18,
          break: idx > 0 ? 1 : 0,
          color: "24292F",
        })
    ),
  });
}

export async function markdownToDocx(markdown: string): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  const children: (Paragraph | Table)[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        children.push(
          new Paragraph({
            heading: levelToHeading(block.level),
            children: runsToChildren(block.text),
            spacing: { before: 240, after: 120 },
            ...rtlProps(block.text),
          })
        );
        break;
      case "paragraph":
        children.push(
          new Paragraph({
            children: runsToChildren(block.text),
            spacing: { after: 120 },
            ...rtlProps(block.text),
          })
        );
        break;
      case "code":
        children.push(codeParagraph(block.text));
        break;
      case "bullet":
        for (const item of block.items) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              children: runsToChildren(item),
              spacing: { after: 60 },
              ...rtlProps(item),
            })
          );
        }
        break;
      case "ordered":
        for (const item of block.items) {
          children.push(
            new Paragraph({
              numbering: { reference: "ordered-list", level: 0 },
              children: runsToChildren(item),
              spacing: { after: 60 },
              ...rtlProps(item),
            })
          );
        }
        break;
      case "quote":
        children.push(
          new Paragraph({
            children: runsToChildren(block.text),
            spacing: { before: 120, after: 120 },
            indent: { left: 720 },
            border: {
              left: { style: BorderStyle.SINGLE, size: 24, color: "8C8C8C", space: 8 },
            },
            ...rtlProps(block.text),
          })
        );
        break;
      case "hr":
        children.push(
          new Paragraph({
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 },
            },
            spacing: { before: 120, after: 120 },
          })
        );
        break;
      case "table": {
        const rows: TableRow[] = [
          new TableRow({
            tableHeader: true,
            children: block.header.map(
              (cell) =>
                new TableCell({
                  shading: { type: ShadingType.CLEAR, fill: "EFF3F7", color: "auto" },
                  children: [new Paragraph({ children: runsToChildren(cell) })],
                })
            ),
          }),
        ];
        for (const row of block.rows) {
          rows.push(
            new TableRow({
              children: row.map(
                (cell) =>
                  new TableCell({
                    children: [new Paragraph({ children: runsToChildren(cell) })],
                  })
              ),
            })
          );
        }
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows,
          })
        );
        break;
      }
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 } },
      },
    },
    numbering: {
      config: [
        {
          reference: "ordered-list",
          levels: [
            {
              level: 0,
              format: NumberFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

/* ── PDF generation ──────────────────────────────────────────────────── */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const MAX_WIDTH = PAGE_WIDTH - MARGIN * 2;

function sanitizeForPdf(text: string, font: PDFFont): string {
  const allowed = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (allowed.has(code)) out += ch;
  }
  return out;
}

function wrapText(text: string, font: PDFFont, size: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > MAX_WIDTH && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export async function markdownToPdf(markdown: string): Promise<Uint8Array> {
  const blocks = parseMarkdown(markdown);
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const mono = await pdfDoc.embedFont(StandardFonts.Courier);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (height: number) => {
    if (y - height < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  const drawTextLine = (
    text: string,
    opts: { size: number; f: PDFFont; color: any; indent?: number }
  ) => {
    page.drawText(text, {
      x: MARGIN + (opts.indent || 0),
      y,
      size: opts.size,
      font: opts.f,
      color: opts.color,
    });
    y -= opts.size * 1.4;
  };

  const drawParagraph = (
    text: string,
    opts: { size: number; f: PDFFont; color?: any; indent?: number }
  ) => {
    const safe = sanitizeForPdf(text, font);
    const lines = wrapText(safe, opts.f, opts.size);
    for (const line of lines) {
      ensureSpace(opts.size * 1.4);
      drawTextLine(line, { size: opts.size, f: opts.f, color: opts.color, indent: opts.indent });
    }
  };

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const size = [22, 18, 15, 13, 12, 12][Math.min(block.level, 6) - 1];
        ensureSpace(size * 1.6);
        drawTextLine(sanitizeForPdf(block.text, font), {
          size,
          f: fontBold,
          color: rgb(0, 0, 0),
        });
        y -= size * 0.4;
        break;
      }
      case "paragraph":
        drawParagraph(block.text, { size: 11, f: font });
        y -= 6;
        break;
      case "code": {
        const codeLines = sanitizeForPdf(block.text, mono).split("\n");
        const blockHeight = codeLines.length * 12 + 16;
        ensureSpace(blockHeight);
        page.drawRectangle({
          x: MARGIN - 8,
          y: y - codeLines.length * 12 - 8,
          width: MAX_WIDTH + 16,
          height: codeLines.length * 12 + 16,
          color: rgb(0.96, 0.97, 0.98),
        });
        for (const line of codeLines) {
          page.drawText(line, {
            x: MARGIN,
            y,
            size: 8.5,
            font: mono,
            color: rgb(0.13, 0.15, 0.19),
          });
          y -= 12;
        }
        y -= 8;
        break;
      }
      case "bullet":
        for (const item of block.items) {
          ensureSpace(18);
          drawTextLine("•  " + sanitizeForPdf(item, font), {
            size: 11,
            f: font,
            color: rgb(0, 0, 0),
            indent: 18,
          });
        }
        y -= 6;
        break;
      case "ordered":
        block.items.forEach((item, idx) => {
          ensureSpace(18);
          drawTextLine(`${idx + 1}.  ${sanitizeForPdf(item, font)}`, {
            size: 11,
            f: font,
            color: rgb(0, 0, 0),
            indent: 18,
          });
        });
        y -= 6;
        break;
      case "quote":
        for (const line of wrapText(sanitizeForPdf(block.text, font), fontItalic, 11)) {
          ensureSpace(18);
          drawTextLine(line, {
            size: 11,
            f: fontItalic,
            color: rgb(0.35, 0.35, 0.35),
            indent: 30,
          });
        }
        y -= 6;
        break;
      case "hr":
        ensureSpace(20);
        page.drawLine({
          start: { x: MARGIN, y },
          end: { x: PAGE_WIDTH - MARGIN, y },
          thickness: 0.75,
          color: rgb(0.8, 0.8, 0.8) as never,
        });
        y -= 20;
        break;
      case "table": {
        const rowHeight = 20;
        const colWidth = MAX_WIDTH / Math.max(block.header.length, 1);
        const totalHeight = (block.rows.length + 1) * rowHeight + 10;
        ensureSpace(totalHeight);
        block.header.forEach((cell, ci) => {
          page.drawText(sanitizeForPdf(cell, font), {
            x: MARGIN + ci * colWidth + 4,
            y,
            size: 10,
            font: fontBold,
            color: rgb(0, 0, 0),
          });
        });
        y -= rowHeight;
        page.drawLine({
          start: { x: MARGIN, y: y + 4 },
          end: { x: PAGE_WIDTH - MARGIN, y: y + 4 },
          thickness: 1,
          color: rgb(0.6, 0.6, 0.6) as never,
        });
        for (const row of block.rows) {
          row.forEach((cell, ci) => {
            page.drawText(sanitizeForPdf(cell, font), {
              x: MARGIN + ci * colWidth + 4,
              y,
              size: 10,
              font,
              color: rgb(0.1, 0.1, 0.1),
            });
          });
          y -= rowHeight;
        }
        y -= 8;
        break;
      }
    }
  }

  return pdfDoc.save();
}
