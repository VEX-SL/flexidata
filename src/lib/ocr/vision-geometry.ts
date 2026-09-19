import type { BBox } from "@/lib/pipeline/types";
import { normalizeText } from "@/lib/pipeline/ocr";
import { unionBoxes } from "@/lib/pipeline/geometry";

/**
 * Geometry recovery for the Vision OCR path.
 *
 * The Gemini reading is excellent at text but sometimes returns NO per-line
 * bounding boxes at all (screenshots, glyph-heavy docs, flash models). Without
 * pixel boxes the Inspector cannot show where a field lives on the image. The
 * local Tesseract engine (same one the scanned-PDF path uses) always emits
 * real word-level boxes, so we borrow ONLY its geometry: match each Vision
 * line to the Tesseract lines whose normalized token sets overlap, and union
 * their boxes (a Vision "line" may be a merged span of several visual rows).
 *
 * The Vision text is never replaced — the boxes are the only thing borrowed.
 * Pure function, no I/O.
 */

/** Arabic combining marks / diacritics (harakat, shadda, dagger alef). */
const DIACRITICS = /[\u064b-\u065f\u0670\u0640]/g;
/** Punctuation and separators — irrelevant for row association. */
const PUNCT = /[\u066b\u066c\u060c\u061b\u061f,.;:!?\u060d"'()\[\]{}<>/\\+\-_=*#@~`|&%$^]+/g;

/** A Tesseract line's most relevant surface for matching: its tokens. */
function tokens(lineText: string): string[] {
  return normalizeText(lineText)
    .replace(DIACRITICS, "")
    .replace(PUNCT, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Attach a pixel bbox to every Vision line whose text overlaps Tesseract rows.
 * A line may map to several tesseract rows (Vision merges rows) — their boxes
 * are unioned so the highlight covers the whole region.
 */
export function matchVisionLinesToGeometry(
  visionLines: Array<{ text: string }>,
  geoLines: Array<{ text: string; bbox?: BBox }>
): Map<number, BBox> {
  const geo = geoLines
    .map((g, index) => {
      const words = new Set(tokens(g.text));
      const b = g.bbox;
      const usable = b !== undefined && b.width > 0 && b.height > 0;
      return { index, words, bbox: usable ? b : undefined };
    })
    .filter((g) => g.words.size > 0 && g.bbox !== undefined);

  const out = new Map<number, BBox>();
  visionLines.forEach((line, vi) => {
    const vw = tokens(line.text);
    if (vw.length === 0) return;
    // Only rows sharing a meaningful share of the Vision line's words count.
    const hits: BBox[] = [];
    for (const g of geo) {
      let shared = 0;
      for (const w of vw) if (g.words.has(w)) shared += 1;
      const share = shared / Math.max(1, Math.min(vw.length, g.words.size));
      if (share >= 0.45) hits.push(g.bbox!);
    }
    const box = unionBoxes(hits);
    if (box) out.set(vi, box);
  });
  return out;
}