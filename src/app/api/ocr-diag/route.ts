import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export async function GET() {
  const out: Record<string, unknown> = { node: process.version, time: new Date().toISOString() };
  const statuses: Array<{ at: number; status: string; progress?: number }> = [];
  const tStart = Date.now();

  const cachePath = path.join(os.tmpdir(), "tesseract-ocr-diag");
  try {
    fs.mkdirSync(cachePath, { recursive: true });
  } catch {}

  try {
    const Tesseract = require("tesseract.js");
    const api = Tesseract.default || Tesseract;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64"
    );
    const result = (await withTimeout(
      api.recognize(png, "eng", {
        logger: (m: { status: string; progress?: number }) => {
          statuses.push({ at: Date.now() - tStart, status: m.status, progress: m.progress });
        },
        cachePath,
        langPath: `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"}/ocr-data`,
        gzip: false,
      }),
      60000
    )) as { data?: { text?: string } };
    out.ok = true;
    out.ms = Date.now() - tStart;
    out.text = (result.data?.text || "").trim().slice(0, 200);
  } catch (e) {
    out.ok = false;
    out.ms = Date.now() - tStart;
    out.error = String(e);
  }
  out.statuses = statuses;
  return NextResponse.json(out);
}
