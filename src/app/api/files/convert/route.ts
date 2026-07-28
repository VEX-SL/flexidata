import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Document, Packer, Paragraph, TextRun } from "docx";
import PDFMerger from "pdf-merger-js";

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  let body: { operation: string; files?: string[]; text?: string; filename?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { operation, files, text, filename } = body;

  try {
    switch (operation) {
      case "merge-pdf":
        return await handleMergePDF(files || []);
      case "text-to-pdf":
        return await handleTextToPDF(text || "", filename || "document.pdf");
      case "text-to-docx":
        return await handleTextToDocx(text || "", filename || "document.docx");
      default:
        return NextResponse.json({ error: `Unknown operation: ${operation}` }, { status: 400 });
    }
  } catch (err: any) {
    console.error(`[FileConvert] ${operation} failed:`, err);
    return NextResponse.json({ error: err.message || "Conversion failed" }, { status: 500 });
  }
}

async function handleMergePDF(pdfUrls: string[]) {
  if (pdfUrls.length < 2) {
    return NextResponse.json({ error: "Need at least 2 PDFs to merge" }, { status: 400 });
  }

  const merger = new PDFMerger();

  for (const url of pdfUrls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch PDF: ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await merger.add(buffer);
  }

  const mergedBuffer = await merger.saveAsBuffer();
  return new NextResponse(new Uint8Array(mergedBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="merged.pdf"`,
    },
  });
}

async function handleTextToPDF(text: string, outFilename: string) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const lineHeight = fontSize * 1.5;
  const margin = 50;
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const maxLineWidth = pageWidth - margin * 2;

  const lines = text.split("\n");
  let page = pdfDoc.addPage();
  let y = pageHeight - margin;

  for (const line of lines) {
    if (y < margin + lineHeight) {
      page = pdfDoc.addPage();
      y = pageHeight - margin;
    }

    const words = line.split(" ");
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const width = font.widthOfTextAtSize(testLine, fontSize);

      if (width > maxLineWidth && currentLine) {
        page.drawText(currentLine, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
        y -= lineHeight;
        if (y < margin + lineHeight) {
          page = pdfDoc.addPage();
          y = pageHeight - margin;
        }
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      page.drawText(currentLine, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
      y -= lineHeight;
    }
  }

  const pdfBytes = await pdfDoc.save();
  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${outFilename}"`,
    },
  });
}

async function handleTextToDocx(text: string, outFilename: string) {
  const paragraphs = text.split("\n").map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line, size: 24 })],
      })
  );

  const doc = new Document({
    sections: [{ children: paragraphs }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new NextResponse(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${outFilename}"`,
    },
  });
}

export const runtime = "nodejs";
