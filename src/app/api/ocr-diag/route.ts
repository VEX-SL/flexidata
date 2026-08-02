import { NextRequest, NextResponse } from "next/server";
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

export async function POST(req: NextRequest) {
  const out: Record<string, unknown> = { node: process.version, time: new Date().toISOString() };
  try {
    const body = await req.arrayBuffer();
    out.bodyBytes = body.byteLength;
    const t0 = Date.now();
    const { recognizeMainThread } = await import("@/lib/tesseract-main");
    out.importMs = Date.now() - t0;
    const t1 = Date.now();
    const text = await withTimeout(recognizeMainThread(Buffer.from(body), "ara+eng"), 45000);
    out.ocrMs = Date.now() - t1;
    out.text = (text || "").slice(0, 200);
    out.textLen = (text || "").length;
  } catch (e) {
    out.error = String(e);
    out.errorStack = (e as Error).stack?.slice(0, 1500);
  }
  return NextResponse.json(out);
}

export async function GET() {
  const out: Record<string, unknown> = { node: process.version, time: new Date().toISOString() };

  try {
    // locate shipped core
    const coreDirCandidates = [
      path.join(process.cwd(), "node_modules", "tesseract.js-core"),
      "/var/task/node_modules/tesseract.js-core",
      path.resolve("node_modules/tesseract.js-core"),
    ];
    let coreDir: string | null = null;
    for (const d of coreDirCandidates) {
      if (fs.existsSync(path.join(d, "tesseract-core-relaxedsimd.js"))) { coreDir = d; break; }
    }
    out.coreDir = coreDir;
    if (!coreDir) return NextResponse.json({ ...out, fatal: "core dir not found" });

    const wasmBinary = fs.readFileSync(path.join(coreDir, "tesseract-core-relaxedsimd.wasm"));
    out.wasmBytes = wasmBinary.length;

    // eslint-disable-next-line no-eval
    const req = eval("require");
    const Core = req(path.join(coreDir, "tesseract-core-relaxedsimd.js"));
    const progress: number[] = [];
    const t0 = Date.now();
    const mod = (await withTimeout(
      Core({ wasmBinary, TesseractProgress: (p: number) => progress.push(p) }),
      20000
    )) as any;
    out.moduleLoadedMs = Date.now() - t0;

    // load eng traineddata from our CDN into the module FS
    const langUrl = `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"}/ocr-data/eng.traineddata`;
    const t1 = Date.now();
    const resp = await fetch(langUrl);
    const langData = Buffer.from(await resp.arrayBuffer());
    out.langFetchMs = Date.now() - t1;
    out.langBytes = langData.length;
    mod.FS.writeFile("/eng.traineddata", new Uint8Array(langData));

    const api = new mod.TessBaseAPI();
    api.Init(null, "eng", 3 /* OEM.DEFAULT */);

    // tiny BMP 30x15, white bg, black bar
    const w = 30, h = 15;
    const rowSize = Math.floor((w * 3 + 3) / 4) * 4;
    const bmp = Buffer.alloc(14 + 40 + rowSize * h);
    bmp.write("BM", 0, "ascii");
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(w, 18);
    bmp.writeInt32LE(h, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const off = 54 + y * rowSize + x * 3;
        const dark = x >= 8 && x <= 12 && y >= 5 && y <= 9;
        const v = dark ? 0 : 255;
        bmp[off] = v; bmp[off + 1] = v; bmp[off + 2] = v;
      }
    }

    // eslint-disable-next-line no-eval
    const req2 = eval("require");
    const setImage = req2("tesseract.js/src/worker-script/utils/setImage");
    const t2 = Date.now();
    setImage(mod, api, bmp);
    out.setImageMs = Date.now() - t2;

    const t3 = Date.now();
    api.Recognize(null);
    out.recognizeMs = Date.now() - t3;
    out.progressCount = progress.length;
    const text = api.GetUTF8Text();
    out.text = (text || "").trim().slice(0, 100);
    api.Delete();
  } catch (e) {
    out.error = String(e);
    out.errorStack = (e as Error).stack?.slice(0, 400);
  }
  return NextResponse.json(out);
}
