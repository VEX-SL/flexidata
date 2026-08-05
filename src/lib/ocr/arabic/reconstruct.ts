/**
 * Arabic line reconstruction (RTL reading order).
 *
 * When an RTL-base line (Arabic letters outnumber Latin letters) is emitted in
 * pure visual (left-to-right) order — i.e. Tesseract's word stream equals the
 * left-to-right x-sorted word order — the line was not bidi-reordered and
 * reads backwards for an Arabic reader. Using real word boxes we rebuild the
 * reading order by reversing the visual word order: in an RTL paragraph the
 * first logical word sits rightmost, so reading order is the exact reverse of
 * the visual stream (numbers/amounts keep their internal order as single
 * words). This covers the common receipt/invoice cases ("المطلوب 68.38 ريال"
 * emitted as "ريال 68.38 المطلوب", "الراجحي هاتف 8001241222" emitted as
 * "8001241222 هاتف الراجحي").
 *
 * Only fires when all of the following hold, so already-correct lines are
 * never touched:
 *  - the line carries real word boxes (processed-image coordinates),
 *  - the emitted order equals the visual order (proof no bidi was applied),
 *  - the line has Arabic letters and its base direction is RTL (Arabic letters
 *    outnumber Latin letters; Arabic + digit lines qualify too),
 *  - the reconstruction actually changes the line.
 */
import type { OcrWord } from "@/lib/pipeline/types";
import { countArabicLetters, countLatinLetters } from "./scripts";

/** Rebuild a mixed RTL line's words into reading order. Returns the same
 *  words when reconstruction is not warranted. */
export function reconstructWords(words: OcrWord[]): OcrWord[] {
  if (words.length < 2) return words;
  if (!words.every((w) => w.bbox?.x !== undefined)) return words;

  const arabic = words.reduce((n, w) => n + countArabicLetters(w.text), 0);
  const latin = words.reduce((n, w) => n + countLatinLetters(w.text), 0);
  if (arabic === 0) return words; // nothing RTL to reconstruct
  if (arabic < latin) return words; // base direction is LTR

  const visual = [...words].sort((a, b) => a.bbox!.x - b.bbox!.x);
  const emittedIsVisual = words.every((w, i) => w === visual[i]);
  if (!emittedIsVisual) return words; // already in reading order

  const rebuilt = visual.slice().reverse();
  const joined = (ws: OcrWord[]) => ws.map((w) => w.text).join(" ");
  if (joined(rebuilt) === joined(words)) return words;
  return rebuilt;
}
