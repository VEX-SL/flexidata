/**
 * Main-thread OCR using tesseract.js-core directly.
 *
 * The tesseract.js worker_thread path hangs forever on Vercel (the worker's
 * `error` event is never surfaced and recognition inside the wasm worker
 * never progresses). Running the wasm on the request's own thread sidesteps
 * that entirely — the emscripten module is instantiated once and reused.
 *
 * Improvements on top of the raw engine:
 *  - Image preprocessing (deskew, perspective, contrast, adaptive threshold,
 *    sharpen, resize, EXIF orientation) before recognition — see
 *    @/lib/ocr/preprocess. A poor preprocessed result falls back to the raw
 *    image so we never return worse output than before.
 *  - Real per-word / per-line confidence from the ResultIterator
 *    (RIL_WORD level), instead of stamping one page-mean value on every line.
 *    The old AllWordConfidences binding marshals an empty vector, and
 *    MeanTextConf returns 0 for perfectly readable images — both unusable.
 */
import fs from "fs";
import path from "path";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import {
  canvasFromImage,
  isCanvasAvailable,
  jpegOrientation,
  preprocessBuffer,
  preprocessImage,
} from "@/lib/ocr/preprocess";
import type { RawImage } from "@/lib/ocr/preprocess";
import type { OcrPreset } from "@/lib/ocr/preprocess";

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
  configureApi(api);
  sharedApi = { mod, api, langs };
  return { mod, api };
}

/**
 * Receipt-friendly engine variables. Safe, generic, and never content-
 * specific: keep inter-word spaces, prefer word-based segmentation at the
 * working resolution, avoid dictionary penalties that fight merchant/customer
 * names, and give Tesseract a fallback DPI so its size heuristics are sane
 * for camera photos (JPEGs carry no DPI).
 */
function configureApi(api: any): void {
  const vars: Record<string, string> = {
    "tessedit_pageseg_mode": "3", // PSM.AUTO
    "preserve_interword_spaces": "1",
    "user_defined_dpi": "300",
    "textord_min_xheight": "10",
    "language_model_penalty_non_dict_word": "0.2",
    "language_model_penalty_non_freq_dict_word": "0.2",
  };
  for (const [k, v] of Object.entries(vars)) {
    try {
      api.SetVariable(k, v);
    } catch {
      // optional variable on this build
    }
  }
}

function setImage(mod: any, api: any, image: Buffer, exif: number): void {
  // Same logic as tesseract.js worker-script/utils/setImage.js
  const isBmp =
    (image[0] === 66 && image[1] === 77) ||
    (image[1] === 66 && image[0] === 77);

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

export interface RecognizeOptions {
  /** "photo" (camera captures, default for encoded bytes) vs "scan" (rendered pages). */
  preset?: OcrPreset;
  /** Run image preprocessing before recognition (default true). */
  preprocess?: boolean;
}

function isImageDataInput(input: OcrInput): input is { data: ArrayLike<number>; width: number; height: number } {
  return typeof input === "object" && "width" in input && "height" in input;
}

/**
 * Recognize an image and return a structured OcrDocument with per-word /
 * per-line confidence from Tesseract's ResultIterator, so downstream stages
 * can treat OCR as probabilistic input instead of absolute truth.
 */
export async function recognizeMainThread(
  input: OcrInput,
  langs = "eng",
  opts: RecognizeOptions = {}
): Promise<OcrDocument> {
  const preset: OcrPreset =
    opts.preset ?? (isImageDataInput(input) ? "scan" : "photo");
  const doPreprocess = opts.preprocess ?? true;

  const { mod, api } = await getApi(langs);

  const attempt = async (buf: Buffer, exif: number): Promise<OcrDocument> => {
    setImage(mod, api, buf, exif);
    api.Recognize(null);
    return buildDocument(api, langs);
  };

  const primary = await prepareImage(input, preset, doPreprocess);
  const doc = await attempt(primary.buf, primary.exif);

  // If preprocessing hurt the image (garbage text / implausibly low
  // confidence), retry with the untouched bytes and keep the better result.
  if (doPreprocess && isPoorResult(doc)) {
    const raw = await prepareImage(input, preset, false);
    const rawDoc = await attempt(raw.buf, raw.exif);
    if (isBetterThan(rawDoc, doc)) return rawDoc;
  }
  return doc;
}

interface PreparedImage { buf: Buffer; exif: number }

async function prepareImage(
  input: OcrInput,
  preset: OcrPreset,
  preprocess: boolean
): Promise<PreparedImage> {
  if (isImageDataInput(input)) {
    // Raw RGBA pixels (PDF page renders, canvas captures).
    const raw: RawImage = {
      data: new Uint8ClampedArray(input.data as any),
      width: input.width,
      height: input.height,
    };
    let out: RawImage = raw;
    if (preprocess && isCanvasAvailable()) {
      try {
        out = await preprocessImage(raw, preset);
      } catch {
        out = raw;
      }
    }
    return { buf: Buffer.from(canvasFromImage(out).toBuffer("image/png")), exif: 1 };
  }

  // Encoded bytes (JPEG/PNG/…). Preprocessing bakes EXIF orientation into the
  // bitmap, so the raw fallback still needs the orientation handed to the
  // engine (Tesseract applies it via Leptonica when SetImageFile gets it).
  const bytes = input instanceof Uint8Array ? Buffer.from(input) : input;
  if (!preprocess || !isCanvasAvailable()) {
    return { buf: bytes, exif: jpegOrientation(new Uint8Array(bytes)) };
  }
  try {
    const pre = await preprocessBuffer(bytes, preset);
    return { buf: Buffer.from(canvasFromImage(pre).toBuffer("image/png")), exif: 1 };
  } catch {
    return { buf: bytes, exif: jpegOrientation(new Uint8Array(bytes)) };
  }
}

// ─── Document assembly with per-word confidence ────────────────────────────

interface WalkedWord { text: string; confidence?: number; lineStart: boolean }

/**
 * Walk Tesseract's ResultIterator at RIL_WORD level. Returns null when the
 * iterator binding is unavailable so callers keep the page-mean fallback.
 */
function readWordConfidences(api: any): WalkedWord[] | null {
  let it: any;
  try {
    it = api.GetIterator();
  } catch {
    return null;
  }
  if (!it) return null;

  const out: WalkedWord[] = [];
  try {
    let guard = 0;
    do {
      let t = "";
      try {
        t = it.GetUTF8Text(3) || "";
      } catch {
        t = "";
      }
      const trimmed = t.trim();
      if (trimmed) {
        let confidence: number | undefined;
        try {
          const raw = Number(it.Confidence(3));
          confidence = Number.isFinite(raw) ? raw / 100 : undefined;
        } catch {
          confidence = undefined;
        }
        let lineStart = false;
        try {
          lineStart = Boolean(it.IsAtBeginningOf(2));
        } catch {
          lineStart = false;
        }
        out.push({ text: trimmed, confidence, lineStart });
      }
      guard++;
    } while (it.Next(3) && guard < 100_000);
  } catch {
    // keep whatever words were collected
  }
  try {
    it.delete();
  } catch {
    // binding without a delete() — nothing to release
  }
  return out.length > 0 ? out : null;
}

function buildDocument(api: any, langs: string): OcrDocument {
  const text = (api.GetUTF8Text() || "").trim();
  const walked = readWordConfidences(api);

  if (walked && walked.length > 0) {
    const lines: OcrLine[] = [];
    let cur: OcrWord[] = [];
    const pushLine = () => {
      if (cur.length === 0) return;
      const confs = cur
        .map((w) => w.confidence)
        .filter((c): c is number => typeof c === "number");
      lines.push({
        text: cur.map((w) => w.text).join(" "),
        confidence: confs.length > 0 ? mean(confs) : undefined,
        words: cur,
      });
      cur = [];
    };
    for (let i = 0; i < walked.length; i++) {
      if (i > 0 && walked[i].lineStart) pushLine();
      cur.push({ text: walked[i].text, confidence: walked[i].confidence });
    }
    pushLine();

    const pageConfs = walked
      .map((w) => w.confidence)
      .filter((c): c is number => typeof c === "number");
    return {
      text,
      language: langs,
      confidence: pageConfs.length > 0 ? mean(pageConfs) : pageMeanConfidence(api),
      lines,
    };
  }

  return {
    text,
    language: langs,
    confidence: pageMeanConfidence(api),
    lines: buildLinesFallback(text, pageMeanConfidence(api)),
  };
}

/** Page-mean confidence (0..1) from MeanTextConf, when it reports a sane value. */
function pageMeanConfidence(api: any): number | undefined {
  try {
    if (typeof api.MeanTextConf === "function") {
      const mean = Number(api.MeanTextConf());
      if (Number.isFinite(mean) && mean > 0 && mean <= 100) {
        return Math.min(1, Math.max(0, mean / 100));
      }
    }
  } catch {
    // unavailable
  }
  return undefined;
}

function buildLinesFallback(text: string, pageConfidence?: number): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const lineText of text.split("\n")) {
    const words: OcrWord[] = lineText
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => ({ text: t }));
    lines.push({
      text: lineText,
      confidence: pageConfidence,
      words,
    });
  }
  return lines;
}

/** Preprocessing produced junk when there is barely any text or implausible confidence. */
function isPoorResult(doc: OcrDocument): boolean {
  if (doc.text.trim().length < 25) return true;
  const confs = doc.lines
    .map((l) => l.confidence)
    .filter((c): c is number => typeof c === "number");
  return confs.length > 0 && mean(confs) < 0.45;
}

/** Prefer the raw result when it clearly recovers more/better text. */
function isBetterThan(a: OcrDocument, b: OcrDocument): boolean {
  const aText = a.text.trim().length;
  const bText = b.text.trim().length;
  const aC = meanConf(a);
  const bC = meanConf(b);
  if (aText === 0) return false;
  if (bText === 0) return true;
  if (aC !== undefined && bC !== undefined) {
    return aC > bC + 0.05 || (aText > bText * 1.3 && aC >= bC - 0.05);
  }
  return aText > bText * 1.3;
}

function meanConf(doc: OcrDocument): number | undefined {
  const confs = doc.lines
    .map((l) => l.confidence)
    .filter((c): c is number => typeof c === "number");
  return confs.length > 0 ? mean(confs) : undefined;
}

function mean(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}
