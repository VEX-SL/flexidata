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

  // 1. worker_threads availability
  try {
    const wt = require("worker_threads");
    out.workerThreadsAvailable = true;
    const spawn = new Promise((resolve, reject) => {
      const w = new wt.Worker(
        `const { parentPort } = require('worker_threads'); parentPort.postMessage('worker-alive-' + process.version);`,
        { eval: true }
      );
      w.once("message", resolve);
      w.once("error", reject);
      setTimeout(() => reject(new Error("worker spawn timeout")), 10000);
    });
    out.workerThreadsMessage = await withTimeout(spawn, 15000);
  } catch (e) {
    out.workerThreadsAvailable = false;
    out.workerThreadsError = String(e);
  }

  // 2. tesseract.js-core load directly (no worker thread)
  try {
    const t0 = Date.now();
    const Core = require("tesseract.js-core/tesseract-core-relaxedsimd");
    await withTimeout(
      Core({}).then((m: unknown) => { out.coreLoaded = true; out.coreType = typeof m; }),
      20000
    );
    out.coreLoadMs = Date.now() - t0;
  } catch (e) {
    out.coreLoaded = false;
    out.coreError = String(e);
  }

  // 3. full tesseract recognize with langdata from our CDN, 40s cap
  const cachePath = path.join(os.tmpdir(), "tesseract-ocr-diag");
  try {
    fs.mkdirSync(cachePath, { recursive: true });
  } catch {}
  try {
    const Tesseract = require("tesseract.js");
    const api = Tesseract.default || Tesseract;
    const t0 = Date.now();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64"
    );
    const { data } = await withTimeout(
      api.recognize(png, "eng", {
        logger: () => {},
        cachePath,
        langPath: `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"}/ocr-data`,
        gzip: false,
      }),
      40000
    );
    out.recognizeMs = Date.now() - t0;
    out.recognizeOk = true;
    out.recognizeText = (data.text || "").trim().slice(0, 200);
  } catch (e) {
    out.recognizeOk = false;
    out.recognizeError = String(e);
  }

  return NextResponse.json(out);
}
