/**
 * Main-thread OCR using tesseract.js-core directly.
 *
 * The tesseract.js worker_thread path hangs forever on Vercel (the worker's
 * `error` event is never surfaced and recognition inside the wasm worker
 * never progresses). Running the wasm on the request's own thread sidesteps
 * that entirely — the emscripten module is instantiated once and reused.
 */
import fs from "fs";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runtimeRequire = eval("require");

const CORE_VARIANTS = [
  { js: "tesseract-core-relaxedsimd.js", wasm: "tesseract-core-relaxedsimd.wasm", test: "relaxedSimd" },
  { js: "tesseract-core-simd.js", wasm: "tesseract-core-simd.wasm", test: "simd" },
  { js: "tesseract-core.js", wasm: "tesseract-core.wasm", test: null },
];

function findCoreDir(): string {
  const candidates = [
    path.join(process.cwd(), "node_modules", "tesseract.js-core"),
    "/var/task/node_modules/tesseract.js-core",
    path.resolve("node_modules/tesseract.js-core"),
  ];
  for (const d of candidates) {
    if (fs.existsSync(path.join(d, "tesseract-core.js"))) return d;
  }
  throw new Error("tesseract.js-core not found");
}

let modulePromise: Promise<any> | null = null;

async function getTesseractModule(): Promise<any> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const coreDir = findCoreDir();

      let variant = CORE_VARIANTS[0];
      try {
        const detect = runtimeRequire("wasm-feature-detect");
        for (const v of CORE_VARIANTS) {
          if (v.test && (await detect[v.test]())) { variant = v; break; }
        }
      } catch {
        variant = CORE_VARIANTS[2];
      }

      const wasmBinary = fs.readFileSync(path.join(coreDir, variant.wasm));
      const Core = runtimeRequire(path.join(coreDir, variant.js));
      return Core({ wasmBinary });
    })();
  }
  return modulePromise;
}

const traineddataCache = new Map<string, Uint8Array>();

async function loadTraineddataBytes(lang: string): Promise<Uint8Array> {
  const cached = traineddataCache.get(lang);
  if (cached) return cached;

  let bytes: Buffer;
  if (process.env.VERCEL) {
    const base =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "https://flexidata.vercel.app";
    const resp = await fetch(`${base}/ocr-data/${lang}.traineddata`);
    if (!resp.ok) throw new Error(`traineddata ${lang} fetch failed: ${resp.status}`);
    bytes = Buffer.from(await resp.arrayBuffer());
  } else {
    bytes = fs.readFileSync(
      path.join(process.cwd(), "public", "ocr-data", `${lang}.traineddata`)
    );
  }

  const data = new Uint8Array(bytes);
  traineddataCache.set(lang, data);
  return data;
}

const loadedLangs = new Set<string>();

async function ensureLangsLoaded(mod: any, langs: string): Promise<void> {
  for (const lang of langs.split("+")) {
    if (!lang || loadedLangs.has(lang)) continue;
    const data = await loadTraineddataBytes(lang);
    mod.FS.writeFile(`/${lang}.traineddata`, data);
    loadedLangs.add(lang);
  }
}

export async function __testGetModule(): Promise<any> {
  return getTesseractModule();
}

export async function __testLoadTraineddata(lang: string): Promise<Uint8Array> {
  return loadTraineddataBytes(lang);
}

let sharedApi: { mod: any; api: any; langs: string } | null = null;

async function getApi(langs: string): Promise<{ mod: any; api: any }> {
  if (sharedApi && sharedApi.langs === langs) return sharedApi;
  const mod = await getTesseractModule();
  await ensureLangsLoaded(mod, langs);
  const api = new mod.TessBaseAPI();
  const status = api.Init(null, langs, 3 /* OEM.DEFAULT */);
  if (status === -1) throw new Error(`tesseract init failed for "${langs}"`);
  sharedApi = { mod, api, langs };
  return { mod, api };
}

export function setImage(mod: any, api: any, image: Buffer): void {
  // Same logic as tesseract.js worker-script/utils/setImage.js
  const isBmp =
    (image[0] === 66 && image[1] === 77) ||
    (image[1] === 66 && image[0] === 77);

  const exifMatch = image.slice(0, 500).join(" ").match(/1 18 0 3 0 0 0 1 0 (\d)/);
  const exif = parseInt(exifMatch?.[1] || "", 10) || 1;

  if (isBmp) {
    const bmp = runtimeRequire("bmp-js");
    const buf = Buffer.from(Array.from({ ...image, length: Object.keys(image).length }));
    const bmpBuf = bmp.decode(buf);
    mod.FS.writeFile("/input", bmp.encode(bmpBuf).data);
  } else {
    mod.FS.writeFile("/input", image);
  }

  const res = api.SetImageFile(exif, 0);
  if (res === 1) throw new Error("Error attempting to read image.");
}

export type OcrInput = Buffer | Uint8Array | { data: ArrayLike<number>; width: number; height: number };

export async function recognizeMainThread(input: OcrInput, langs = "eng"): Promise<string> {
  const { mod, api } = await getApi(langs);

  let buf: Buffer;
  if (input instanceof Uint8Array) {
    buf = Buffer.from(input);
  } else {
    const { createCanvas } = await import("@/lib/pdf-canvas");
    const canvas = createCanvas(input.width, input.height);
    const ctx = canvas.getContext("2d");
    ctx.putImageData(input as any, 0, 0);
    buf = Buffer.from(canvas.toBuffer("image/png"));
  }

  setImage(mod, api, buf);
  api.Recognize(null);
  return (api.GetUTF8Text() || "").trim();
}
