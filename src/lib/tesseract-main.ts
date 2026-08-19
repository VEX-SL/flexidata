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
 *  - Arabic-first OCR post-processing (normalization, generic repair, RTL line
 *    reconstruction) applied to every recognized document before the pipeline
 *    consumes it — see @/lib/ocr/arabic.
 */
import fs from "fs";
import path from "path";
import type { OcrDocument, OcrLine, OcrWord, BBox } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import { postProcessOcr } from "@/lib/ocr/arabic";
import {
  canvasFromImage,
  isCanvasAvailable,
  jpegOrientation,
  preprocessBuffer,
  preprocessImage,
} from "@/lib/ocr/preprocess";
import type { RawImage } from "@/lib/ocr/preprocess";
import type { OcrPreset } from "@/lib/ocr/preprocess";
import type { RegionReader, RegionRead } from "@/lib/ocr/numeric-verify";
import { verifyNumericCandidates } from "@/lib/ocr/numeric-verify";
import {
  runRecallRecovery,
  OCR_TIMEOUT_MS,
  type RecallRecoveryRecord,
} from "@/lib/ocr/recall";
import { runPaddleRescue, type PaddleRescueRecord } from "@/lib/ocr/paddle-rescue";

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
  /**
   * Secondary numeric verification (opt-in): invalid or low-confidence numeric
   * fields are re-read from the winning image with a constrained engine
   * configuration (digits whitelist, PSM 7). Never changes the pipeline
   * contract — the report is attached to `doc.meta.numericVerifications`.
   */
  verifyNumerics?: boolean;
  /**
   * Recall recovery (opt-in): after the existing raw-image fallback, a
   * deterministic detector checks for a silently-collapsed OCR result
   * (few lines / low coverage / junk). On suspicion, up to 3 targeted
   * recovery passes run inside the remaining OCR timeout budget and the
   * best candidate replaces the primary only when it clearly wins on the
   * deterministic score. Additive — the decision is attached to
   * `doc.meta.recallRecovery`, and a healthy result costs nothing.
   */
  recoverRecall?: boolean;
  /**
   * Recovery budget override (default: OCR_TIMEOUT_MS - elapsedPrimary).
   * Multi-page callers (PDF) use this to cap total recovery spend.
   */
  recoveryBudgetMs?: number;
  /**
   * Gated PaddleOCR rescue (opt-in, additive): when recall recovery detected
   * a silently-collapsed document AND numeric evidence is missing or
   * suspicious, up to 3 regions are re-read by an external PaddleOCR service
   * (PADDLE_OCR_URL). Accepted readings only replace invalid/ambiguous
   * candidates (valid primaries are never touched) or insert missing
   * "LABEL value" lines with high confidence. Never fails the request — the
   * decision is attached to `doc.meta.paddleRescue`.
   */
  rescuePaddle?: boolean;
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

  const startedAt = Date.now();

  const attempt = async (buf: Buffer, exif: number, psm?: number): Promise<OcrDocument> => {
    if (psm !== undefined) {
      try {
        api.SetVariable("tessedit_pageseg_mode", String(psm));
      } catch {
        // optional variable on this build
      }
    }
    try {
      setImage(mod, api, buf, exif);
      api.Recognize(null);
      // The Arabic-first OCR layer (normalization + generic repair + RTL line
      // reconstruction) runs on every recognized document before it reaches the
      // pipeline. It never inflates confidence and never invents text.
      return postProcessOcr(buildDocument(api, langs)).doc;
    } finally {
      if (psm !== undefined) {
        try {
          api.SetVariable("tessedit_pageseg_mode", "3");
        } catch {
          // optional variable on this build
        }
      }
    }
  };

  const primary = await prepareImage(input, preset, doPreprocess);
  let doc = await attempt(primary.buf, primary.exif);
  let winning = primary;

  // Preprocessing must never serve worse input than the untouched image:
  // when it produced garbage or only mediocre confidence, retry with the raw
  // bytes and keep whichever result is clearly better. PRESERVED — the recall
  // recovery layer below is strictly additive on top of this fallback.
  if (doPreprocess && (isPoorResult(doc) || isMediocreResult(doc))) {
    const raw = await prepareImage(input, preset, false);
    const rawDoc = await attempt(raw.buf, raw.exif);
    if (isBetterThan(rawDoc, doc)) {
      doc = rawDoc;
      winning = raw;
    }
  }

  // Opt-in recall recovery: detector → targeted attempts → deterministic
  // selection, all inside the remaining OCR timeout budget. Never fails the
  // request; the decision is recorded in doc.meta.recallRecovery.
  if (opts.recoverRecall) {
    try {
      const elapsedPrimary = Date.now() - startedAt;
      const budgetMs =
        opts.recoveryBudgetMs ?? Math.max(0, OCR_TIMEOUT_MS - elapsedPrimary);
      const rec = await runRecallRecovery(doc, winning, {
        budgetMs,
        recognize: attempt,
      });
      doc = rec.doc;
      winning = rec.image;
      const record: RecallRecoveryRecord = rec.record;
      if (record.detected || record.skippedReason !== undefined) {
        doc = {
          ...doc,
          meta: { ...(doc.meta ?? {}), recallRecovery: record },
        };
      }
    } catch {
      // Recovery is additive observability — never fail OCR because of it.
    }
  }

  // Opt-in secondary numeric verification: crops and re-reads bbox regions of
  // the winning image only, within a hard budget, and only records decisions.
  if (opts.verifyNumerics) {
    try {
      const out = await verifyNumericCandidates(doc, {
        buffer: winning.buf,
        exif: winning.exif,
        reread: rereadNumericRegion,
      });
      doc = out.doc;
    } catch {
      // Verification is additive observability — never fail OCR because of it.
    }
  }

  // Opt-in gated PaddleOCR rescue: only fires when recall recovery detected a
  // collapse AND the document still lacks/suspicious numeric values; re-reads
  // up to 3 regions via the external service inside the remaining OCR timeout
  // budget. Additive — the decision is attached to doc.meta.paddleRescue.
  if (opts.rescuePaddle) {
    try {
      const elapsedBeforePaddle = Date.now() - startedAt;
      const out = await runPaddleRescue(doc, {
        buffer: winning.buf,
        exif: winning.exif,
        engine: langs.includes("ara") ? "paddleocr-ar" : "paddleocr-en",
        budgetMs: Math.max(0, OCR_TIMEOUT_MS - elapsedBeforePaddle),
      });
      doc = out.doc;
      const record: PaddleRescueRecord = out.record;
      if (record.triggered || record.skippedReason !== undefined) {
        doc = {
          ...doc,
          meta: { ...(doc.meta ?? {}), paddleRescue: record },
        };
      }
    } catch {
      // Rescue is additive observability — never fail OCR because of it.
    }
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

interface WalkedWord {
  text: string;
  confidence?: number;
  lineStart: boolean;
  /** Word box in the processed-image coordinate space, when available. */
  bbox?: BBox;
}

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
        let bbox: BBox | undefined;
        try {
          const r = it.getBoundingBox(3);
          if (r && typeof r.x0 === "number") {
            bbox = {
              x: r.x0,
              y: r.y0,
              width: Math.max(0, r.x1 - r.x0),
              height: Math.max(0, r.y1 - r.y0),
            };
          }
        } catch {
          bbox = undefined;
        }
        let lineStart = false;
        try {
          lineStart = Boolean(it.IsAtBeginningOf(2));
        } catch {
          lineStart = false;
        }
        out.push({ text: trimmed, confidence, lineStart, bbox });
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
    let cur: WalkedWord[] = [];
    const pushLine = () => {
      if (cur.length === 0) return;
      const confs = cur
        .map((w) => w.confidence)
        .filter((c): c is number => typeof c === "number");
      const boxes = cur
        .map((w) => w.bbox)
        .filter((b): b is BBox => b !== undefined);
      lines.push({
        text: cur.map((w) => w.text).join(" "),
        confidence: confs.length > 0 ? mean(confs) : undefined,
        words: cur.map(({ text: t, confidence: c, bbox: b }) => ({
          text: t,
          confidence: c,
          bbox: b,
        })),
        bbox: boxes.length > 0 ? unionBoxes(boxes) : undefined,
      });
      cur = [];
    };
    for (let i = 0; i < walked.length; i++) {
      if (i > 0 && walked[i].lineStart) pushLine();
      cur.push(walked[i]);
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

/** Decent-but-not-great preprocessing: still worth a raw comparison pass. */
function isMediocreResult(doc: OcrDocument): boolean {
  const c = meanConf(doc);
  return c !== undefined && c < 0.75;
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

// ─── Secondary numeric verification (region re-read) ───────────────────────

let verifyApi: { mod: any; api: any } | null = null;

/**
 * Dedicated eng-only TessBaseAPI for verification re-reads. Kept separate from
 * the recognition api so per-call configuration (PSM 7, digit whitelists)
 * never leaks into the main recognition settings. `eng` traineddata is always
 * loaded already (the main api loads it via "ara+eng"), so this is cheap.
 */
async function getVerifyApi(): Promise<{ mod: any; api: any }> {
  if (!verifyApi) {
    const mod = await getTesseractModule();
    await ensureLangsLoaded(mod, "eng");
    const api = new mod.TessBaseAPI();
    const status = api.Init(null, "eng", 3 /* OEM.DEFAULT */);
    if (status === -1) throw new Error("tesseract verify init failed for \"eng\"");
    configureApi(api);
    verifyApi = { mod, api };
  }
  return verifyApi;
}

/**
 * One constrained re-read of a cropped region: single-line PSM, digits
 * whitelist (empty = unrestricted for the independent second read). Returns
 * null when the read produced no usable confidence — callers treat that as
 * "verification unusable", never as a signal to replace anything.
 */
const rereadNumericRegion: RegionReader = async (
  cropPng: Buffer,
  whitelist: string
): Promise<RegionRead | null> => {
  const { mod, api } = await getVerifyApi();
  try {
    api.SetVariable("tessedit_pageseg_mode", "7"); // PSM.SINGLE_LINE
    api.SetVariable("tessedit_char_whitelist", whitelist);
  } catch {
    // optional variable on this build
  }
  setImage(mod, api, cropPng, 1); // crop is already orientation-normalized
  api.Recognize(null);

  const text = (api.GetUTF8Text() || "").trim();
  const walked = readWordConfidences(api);
  let confidence: number | undefined;
  if (walked && walked.length > 0) {
    const confs = walked
      .map((w) => w.confidence)
      .filter((c): c is number => typeof c === "number");
    if (confs.length > 0) confidence = mean(confs);
  }
  if (confidence === undefined) confidence = pageMeanConfidence(api);
  if (confidence === undefined || !text) return null;
  return { text, confidence };
};
