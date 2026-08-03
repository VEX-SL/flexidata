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

// Resolve the CJS require for the emscripten core + wasm-feature-detect.
// Must stay opaque to Turbopack: a statically-resolvable require (createRequire)
// makes Turbopack trace the dynamic path.join and the build fails with
// "Module not found: Can't resolve ... tesseract.js-core". Direct `eval` runs
// in the module scope where Next's bundle provides `require`. Node 24 rejects
// this in type-stripped modules, so the test loader (tests/loader.mjs) swaps
// this line for createRequire when running outside Next.
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

function traineddataFsPaths(lang: string): string[] {
  const f = `${lang}.traineddata`;
  return [
    path.join(/* turbopackIgnore: true */ process.cwd(), "public", "ocr-data", f),
    path.resolve("public", "ocr-data", f),
    `/var/task/public/ocr-data/${f}`,
  ];
}

async function loadTraineddataBytes(lang: string): Promise<Uint8Array> {
  const cached = traineddataCache.get(lang);
  if (cached) return cached;

  let bytes: Buffer | null = null;

  // Prefer the filesystem copy (Vercel ships public/ inside /var/task,
  // so this works locally and in the lambda without any HTTP round-trip).
  for (const p of traineddataFsPaths(lang)) {
    try {
      if (fs.existsSync(p)) { bytes = fs.readFileSync(p); break; }
    } catch {
      // keep trying other candidates
    }
  }

  // Fallback: fetch from the app origin. Avoid the deployment-specific
  // VERCEL_URL, which can return an HTML page for non-routed paths.
  if (!bytes) {
    const bases: string[] = ["https://flexidata.vercel.app"];
    if (process.env.VERCEL_URL) bases.unshift(`https://${process.env.VERCEL_URL}`);
    for (const base of bases) {
      try {
        const resp = await fetch(`${base}/ocr-data/${lang}.traineddata`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (resp.ok && buf.length > 100_000) { bytes = buf; break; }
      } catch {
        // try next base
      }
    }
  }

  if (!bytes) throw new Error(`traineddata "${lang}" unavailable (fs + fetch)`);

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

function setImage(mod: any, api: any, image: Buffer): void {
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
