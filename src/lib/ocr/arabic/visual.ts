/**
 * Visual-order transform for RTL (Arabic) text.
 *
 * Text primitives (pdf-lib, canvas 2D, Word run layout handled by the host
 * engine, …) draw a run of glyphs left-to-right from a fixed origin. Arabic is
 * written and read right-to-left, and each letter only takes the correct shape
 * for the neighbours it touches. This module turns a *logical* Arabic string
 * into the exact glyph sequence that must be drawn left-to-right to read
 * correctly:
 *
 *   1. **Shaping** — every Arabic letter is replaced by its presentation form
 *      (isolated / final / initial / medial) selected from its neighbours,
 *      including the mandatory lam-alef ligature. Ligature + joining decisions
 *      follow the Unicode Arabic joining rules (right-joining letters such as
 *      alef, dal, ra and waw only ever connect to the letter *before* them).
 *   2. **Reordering** — the shaped string is reversed right-to-left, then every
 *      embedded left-to-right run (Latin words, numbers and their separators)
 *      is reversed back so it still reads correctly.
 *
 * Everything is script-agnostic: no keywords, no vendors, no document-specific
 * rules. A string without a single Arabic letter is returned unchanged, so
 * ASCII-only payloads take the cheap path and never get touched.
 */

/** Combining marks (harakat, Quranic annotations) — transparent for joining. */
const COMBINING =
  /[\u064B-\u065F\u0670\u0610-\u061A\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/u;

/**
 * Arabic letters (basic block + tatweel + the extended Arabic blocks used by
 * Persian/Urdu). Presentation forms are handled as-is and are not re-shaped.
 */
const AR_LETTER = /[\u0621-\u064A\u066E-\u066F\u0671-\u06D3]/u;

/**
 * True when the text contains something written in the Arabic script — a base
 * letter or an already-shaped presentation form. Digits alone (Arabic-Indic or
 * Western) do NOT qualify: numbers are laid out left-to-right on their own, so
 * a digits-only line must never be reversed.
 */
const ARABIC_SCRIPT =
  /[\u0621-\u064A\u066E-\u066F\u0671-\u06D3\uFB50-\uFDFF\uFE70-\uFEFF]/u;

/** Right-joining letters of the basic block (never join forward). */
const RIGHT_JOINING = new Set([
  "\u0622", // آ
  "\u0623", // أ
  "\u0624", // ؤ
  "\u0625", // إ
  "\u0627", // ا
  "\u0629", // ة
  "\u062F", // د
  "\u0630", // ذ
  "\u0631", // ر
  "\u0632", // ز
  "\u0648", // و
  "\u0649", // ى
]);

/** Right-joining letters of the extended blocks (Persian/Urdu/Sindhi). */
const RIGHT_JOINING_EXT = new Set(
  Array.from(
    "\u0671\u0672\u0673\u0675\u0688\u0689\u068A\u068B\u068C\u068D\u068E\u068F\u0690" +
      "\u0691\u0692\u0693\u0694\u0695\u0696\u0697\u0698\u0699\u06C0\u06C3\u06C4\u06C5" +
      "\u06C6\u06C7\u06C8\u06C9\u06CA\u06CB\u06CD\u06CF\u06D2\u06D3\u06D5"
  )
);

/**
 * Presentation forms per letter: `[isolated, final, initial, medial]`, with a
 * 2-tuple where only isolated/final exist (right-joining letters) and a 1-tuple
 * where the letter never joins (hamza).
 */
const PRESENTATION_FORMS: Record<string, readonly number[]> = {
  "\u0621": [0xfe80], // ء
  "\u0622": [0xfe81, 0xfe82], // آ
  "\u0623": [0xfe83, 0xfe84], // أ
  "\u0624": [0xfe85, 0xfe86], // ؤ
  "\u0625": [0xfe87, 0xfe88], // إ
  "\u0626": [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c], // ئ
  "\u0627": [0xfe8d, 0xfe8e], // ا
  "\u0628": [0xfe8f, 0xfe90, 0xfe91, 0xfe92], // ب
  "\u0629": [0xfe93, 0xfe94], // ة
  "\u062A": [0xfe95, 0xfe96, 0xfe97, 0xfe98], // ت
  "\u062B": [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c], // ث
  "\u062C": [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0], // ج
  "\u062D": [0xfea1, 0xfea2, 0xfea3, 0xfea4], // ح
  "\u062E": [0xfea5, 0xfea6, 0xfea7, 0xfea8], // خ
  "\u062F": [0xfea9, 0xfeaa], // د
  "\u0630": [0xfeab, 0xfeac], // ذ
  "\u0631": [0xfead, 0xfeae], // ر
  "\u0632": [0xfeaf, 0xfeb0], // ز
  "\u0633": [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4], // س
  "\u0634": [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8], // ش
  "\u0635": [0xfeb9, 0xfeba, 0xfebb, 0xfebc], // ص
  "\u0636": [0xfebd, 0xfebe, 0xfebf, 0xfec0], // ض
  "\u0637": [0xfec1, 0xfec2, 0xfec3, 0xfec4], // ط
  "\u0638": [0xfec5, 0xfec6, 0xfec7, 0xfec8], // ظ
  "\u0639": [0xfec9, 0xfeca, 0xfecb, 0xfecc], // ع
  "\u063A": [0xfecd, 0xfece, 0xfecf, 0xfed0], // غ
  "\u0641": [0xfed1, 0xfed2, 0xfed3, 0xfed4], // ف
  "\u0642": [0xfed5, 0xfed6, 0xfed7, 0xfed8], // ق
  "\u0643": [0xfed9, 0xfeda, 0xfedb, 0xfedc], // ك
  "\u0644": [0xfedd, 0xfede, 0xfedf, 0xfee0], // ل
  "\u0645": [0xfee1, 0xfee2, 0xfee3, 0xfee4], // م
  "\u0646": [0xfee5, 0xfee6, 0xfee7, 0xfee8], // ن
  "\u0647": [0xfee9, 0xfeea, 0xfeeb, 0xfeec], // ه
  "\u0648": [0xfeed, 0xfeee], // و
  "\u0649": [0xfeef, 0xfef0], // ى
  "\u064A": [0xfef1, 0xfef2, 0xfef3, 0xfef4], // ي
};

/** lam + alef variant → `[isolated, final]` (mandatory Arabic ligature). */
const LAM_ALEF: Record<string, readonly number[]> = {
  "\u0622": [0xfef5, 0xfef6],
  "\u0623": [0xfef7, 0xfef8],
  "\u0625": [0xfef9, 0xfefa],
  "\u0627": [0xfefb, 0xfefc],
};

/** Characters that stay left-to-right inside an RTL line. */
const LTR_RUN =
  /^[0-9A-Za-z\u0660-\u0669\u06F0-\u06F9\u066A\u066B\u066C.,:;/\-+%()#&@_'"]$/u;

type JoiningType = "D" | "R" | "U" | "T";

/** Split into clusters: a base character plus its trailing combining marks. */
function clustersOf(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    if (COMBINING.test(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

function joiningType(ch: string): JoiningType | null {
  if (COMBINING.test(ch)) return "T";
  if (ch === "\u0640") return "D"; // tatweel joins on both sides
  if (!AR_LETTER.test(ch)) return null; // Latin, digits, punctuation, presentation forms
  if (ch === "\u0621") return "U"; // lone hamza never joins
  if (RIGHT_JOINING.has(ch) || RIGHT_JOINING_EXT.has(ch)) return "R";
  return "D";
}

/** Index of the nearest base (non-mark) cluster at or before `i`. */
function baseBefore(clusters: readonly string[], i: number): number {
  for (let k = i; k >= 0; k--) if (!COMBINING.test(clusters[k][0])) return k;
  return -1;
}

/** Index of the nearest base (non-mark) cluster after `i`. */
function baseAfter(clusters: readonly string[], i: number): number {
  for (let k = i + 1; k < clusters.length; k++)
    if (!COMBINING.test(clusters[k][0])) return k;
  return -1;
}

/**
 * Replace Arabic letters with their presentation forms, following the Unicode
 * joining rules. Marks ride along on the base letter they belong to.
 */
function shapeArabic(text: string): string {
  const clusters = clustersOf(text);
  const out: string[] = [];

  for (let i = 0; i < clusters.length; i++) {
    const base = clusters[i][0];
    const marks = clusters[i].slice(1);
    const jt = joiningType(base);

    // Non-Arabic characters and combining marks pass through untouched.
    if (jt === null || jt === "T") {
      out.push(clusters[i]);
      continue;
    }

    // lam-alef is a mandatory ligature — never drawn as lam + alef.
    if (base === "\u0644") {
      const next = baseAfter(clusters, i);
      const alt = next === -1 ? undefined : LAM_ALEF[clusters[next][0]];
      if (alt) {
        const prev = baseBefore(clusters, i - 1);
        const joinsPrev =
          prev !== -1 && joiningType(clusters[prev][0]) === "D";
        out.push(String.fromCodePoint(joinsPrev ? alt[1] : alt[0]) + marks);
        // keep the alef's own marks, skip the alef cluster itself
        out.push(clusters[next].slice(1));
        i = next;
        continue;
      }
    }

    const forms = PRESENTATION_FORMS[base];
    if (!forms) {
      out.push(clusters[i]); // extended letter with no mapped form
      continue;
    }

    // Connects to the previous letter only if that letter joins *forward*
    // (dual-joining) and this one joins *backward* (right- or dual-joining).
    let connectPrev = false;
    if (jt === "D" || jt === "R") {
      const prev = baseBefore(clusters, i - 1);
      connectPrev = prev !== -1 && joiningType(clusters[prev][0]) === "D";
    }

    // Connects to the next letter only if this one joins forward (dual).
    let connectNext = false;
    if (jt === "D") {
      const next = baseAfter(clusters, i);
      if (next !== -1) {
        const njt = joiningType(clusters[next][0]);
        connectNext = njt === "D" || njt === "R";
      }
    }

    let idx = 0; // isolated
    if (connectPrev && connectNext) idx = forms.length === 4 ? 3 : 0;
    else if (connectPrev) idx = forms.length >= 2 ? 1 : 0;
    else if (connectNext) idx = forms.length === 4 ? 2 : 0;

    out.push(String.fromCodePoint(forms[idx]) + marks);
  }

  return out.join("");
}

/**
 * Reorder an already-shaped string right-to-left, keeping embedded
 * left-to-right runs (Latin, numbers) readable.
 */
function reorder(shaped: string): string {
  const clusters = clustersOf(shaped);

  // Base direction is RTL: the first logical element becomes the last drawn.
  clusters.reverse();

  // Flip back the runs that must stay left-to-right (68.38, SuperPay, ١٢٣ …).
  let i = 0;
  while (i < clusters.length) {
    if (!LTR_RUN.test(clusters[i][0])) {
      i++;
      continue;
    }
    let j = i;
    while (j < clusters.length && LTR_RUN.test(clusters[j][0])) j++;
    const run = clusters.slice(i, j).reverse();
    clusters.splice(i, run.length, ...run);
    i = j;
  }

  return clusters.join("");
}

/** True when `text` is written in the Arabic script (letters or forms). */
export function hasArabic(text: string): boolean {
  return ARABIC_SCRIPT.test(text);
}

/**
 * Convert logical Arabic text into the glyph sequence to draw left-to-right.
 * Pure ASCII/Latin/digit text is returned unchanged.
 */
export function toVisualOrder(text: string): string {
  if (!hasArabic(text)) return text;
  return reorder(shapeArabic(text));
}
