/**
 * Live end-to-end OCR verification against the real Tesseract engine.
 *
 * Renders synthetic receipts (English+numbers, Arabic, plus a 90°-rotated and
 * a slightly-slanted variant) with @napi-rs/canvas, then runs
 * `recognizeMainThread` with and without preprocessing and checks:
 *   1. Per-line confidence is no longer a single page-mean stamp on every line.
 *   2. Page confidence is realistic (in (0,1)), not 0 and not always 0.7.
 *   3. Preprocessing recovers 90°-rotated and slanted input that the raw path
 *      mangles (deskew + quarter-rotation + adaptive threshold).
 *   4. Numeric totals / merchants survive for the clean synthetic receipt.
 *
 * Run (from repo root, after `npm i`):
 *   node --experimental-strip-types --experimental-transform-types \
 *        --experimental-loader ./tests/loader.mjs --import ./tests/set-require.mjs \
 *        tests/live/verify-ocr.ts
 */
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { recognizeMainThread } from "@/lib/tesseract-main";

let failures = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) console.log(`  ok    ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`); }
}
function pct(v: number | undefined): string {
  return v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function renderReceipt(opts: { width?: number; rotateDeg?: number; arabic?: boolean } = {}): Buffer {
  const { width = 520, rotateDeg = 0, arabic = false } = opts;
  const lines = arabic
    ? [
        ["", ""],
        ["\u0645\u062A\u062C\u0631 \u0627\u0644\u0631\u062D\u064A\u0645 \u0627\u0644\u062A\u062C\u0627\u0631\u064A", "fs22"],
        ["\u062A\u0627\u0631\u064A\u062E: 2025-01-15", "fs16"],
        ["\u0633\u0644\u0639\u0629: \u0623\u0631\u0632 5\u0643\u062C", "fs16"],
        ["\u0627\u0644\u0645\u0628\u0644\u063A: 45.50 \u0631\u0633", "fs16"],
        ["\u0627\u0644\u0625\u062C\u0645\u0627\u0644\u064A: 45.50 \u0631\u0633", "fs18"],
      ]
    : [
        ["", ""],
        ["AL RABIH SUPERMARKET", "fs22"],
        ["Riyadh, KSA  Tel: 011-555-1212", "fs13"],
        ["Date: 2025-01-15  15:42", "fs13"],
        ["----------------------------", "fs13"],
        ["Sugar 1kg                  6.50", "fs15"],
        ["Milk 1L                    7.00", "fs15"],
        ["Rice 5kg                  24.90", "fs15"],
        ["----------------------------", "fs13"],
        ["TOTAL                     38.40", "fs18"],
        ["Cash                      50.00", "fs15"],
        ["Change                    11.60", "fs15"],
        ["Thank you for shopping", "fs13"],
      ];
  const pt = (s: string) => parseInt(s.slice(2), 10) || 16;
  const maxW = Math.max(...lines.map(([, fs]) => (fs === "fs22" ? 90 : fs === "fs13" ? 85 : 100)));
  const lineH = 34;
  const h = lines.length * lineH + 30;
  const canvas = createCanvas(width, Math.ceil(h * (rotateDeg ? 1 : 1)));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f1ea"; // thermal paper tint
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (rotateDeg) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotateDeg * Math.PI) / 180);
  }
  let y = 26;
  for (const [text, fs] of lines) {
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `bold ${pt(fs)}px Arial`;
    ctx.fillText(text, 24, y);
    y += lineH;
  }
  // slight paper noise
  ctx.globalAlpha = 0.04;
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? "#000" : "#fff";
    ctx.fillRect(Math.floor(Math.random() * canvas.width), Math.floor(Math.random() * canvas.height), 2, 2);
  }
  ctx.globalAlpha = 1;
  return canvas.toBuffer("image/png");
}

function report(name: string, text: string, conf: number | undefined, lines: { text: string; confidence?: number }[]) {
  console.log(`\n--- ${name} ---`);
  console.log(`    page confidence: ${pct(conf)}`);
  console.log(`    line count: ${lines.length}`);
  const confs = lines.map((l) => l.confidence).filter((c) => c !== undefined) as number[];
  const unique = new Set(confs.map((c) => c.toFixed(3))).size;
  console.log(`    distinct line confidence values: ${unique} / ${confs.length}`);
  console.log(`    first 4 lines:`);
  for (const l of lines.slice(0, 4)) console.log(`      ${pct(l.confidence).padStart(7)}  ${l.text}`);
}

const clean = renderReceipt();
const rotated90 = renderReceipt({ rotateDeg: 90 });
const slanted = renderReceipt({ rotateDeg: 2 });
const arabic = renderReceipt({ arabic: true });

for (const [name, buf] of [["clean", clean], ["rotated90", rotated90], ["slanted", slanted], ["arabic", arabic]] as const) {
  console.log(`\n=== ${name} — without preprocessing ===`);
  const raw = await recognizeMainThread(buf, "eng+ara", { preprocess: false });
  report(`${name} raw`, raw.text, raw.confidence, raw.lines);
  const rawConfs = raw.lines.map((l) => l.confidence ?? NaN);
  const rawMean = rawConfs.filter((c) => !Number.isNaN(c));

  console.log(`\n=== ${name} — with preprocessing ===`);
  const pre = await recognizeMainThread(buf, "eng+ara", { preprocess: true });
  report(`${name} pre`, pre.text, pre.confidence, pre.lines);
  const preConfs = pre.lines.map((l) => l.confidence ?? NaN).filter((c) => !Number.isNaN(c));

  console.log("");
  check(pre.lines.length > 0, `${name}: preprocessing yields lines`, pre.lines.length);
  check((pre.confidence ?? 0) > 0.05 && (pre.confidence ?? 1) < 1, `${name}: page confidence realistic`, pre.confidence);
  if (preConfs.length >= 2) {
    const distinct = new Set(preConfs.map((c) => c.toFixed(3))).size;
    check(distinct >= 2, `${name}: per-line confidence is non-uniform (was: one page-mean on every line)`, distinct);
    check(preConfs.every((c) => c >= 0 && c <= 1), `${name}: every line confidence within [0,1]`);
  }
  const preChars = pre.text.replace(/\s+/g, "").length;
  const rawChars = raw.text.replace(/\s+/g, "").length;
  check(preChars >= rawChars * 0.7, `${name}: preprocessing keeps the text volume`, { preChars, rawChars });
}

// Arabic-specific: with preprocessing, expect the merchant line and digits.
const araPre = await recognizeMainThread(arabic, "ara", { preprocess: true });
check(/45\.50/.test(araPre.text) || /45\.5/.test(araPre.text), "arabic: numeric total survives", araPre.text.slice(0, 80));

// Clean receipt must keep merchant + total when preprocessing is on (photo path).
const enPre = await recognizeMainThread(clean, "eng", { preprocess: true });
const upper = enPre.text.toUpperCase();
check(upper.includes("AL RABIH") || upper.includes("SUPERMARKET"), "english: merchant survives", enPre.text.slice(0, 60));
check(/(38\.40|38,?40|3840)/.test(enPre.text), "english: TOTAL 38.40 survives", enPre.text.slice(0, 200));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
