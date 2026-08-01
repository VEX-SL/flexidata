import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import PDFMerger from "pdf-merger-js";
import { markdownToDocx, markdownToPdf } from "@/lib/docgen";

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
      case "markdown-to-pdf":
        return await handleMarkdownToPDF(text || "", filename || "document.pdf");
      case "text-to-docx":
      case "markdown-to-docx":
        return await handleMarkdownToDocx(text || "", filename || "document.docx");
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

async function handleMarkdownToPDF(text: string, outFilename: string) {
  const pdfBytes = await markdownToPdf(text);
  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${outFilename}"`,
    },
  });
}

async function handleMarkdownToDocx(text: string, outFilename: string) {
  const buffer = await markdownToDocx(text);
  return new NextResponse(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${outFilename}"`,
    },
  });
}

export const runtime = "nodejs";
