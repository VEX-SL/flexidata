/**
 * Arabic-first OCR post-processing.
 *
 * Applies the normalization layer, the generic Arabic repair layer and the
 * RTL line reconstruction to an OcrDocument so the OCR output is as close as
 * possible to the real Arabic document *before* extraction begins.
 *
 * Guarantees:
 *  - Text is never invented and, apart from the confidence-gated duplicate
 *    collapse, never deleted (edge fragments move to their own lines).
 *  - Confidence is never inflated: joined words take the minimum confidence of
 *    their parts; split words inherit the original word's confidence; line
 *    confidence is recomputed from the repaired words.
 *  - Every line carries per-line quality metrics (Arabic/Latin/printable
 *    ratios, script consistency, OCR confidence, noise score) so garbage lines
 *    are identifiable before extraction.
 */
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import { assessOcrLineQuality } from "@/lib/pipeline/text-quality";
import { repairLineWords, type RepairChange, type RepairToken } from "./repair";
import { reconstructWords } from "./reconstruct";

export interface OcrRepairReport {
  linesChanged: number;
  changes: RepairChange[];
}

/** Repair an OcrDocument in place-copy and return the repaired document plus
 *  a machine-readable report of every change for before/after tooling. */
export function postProcessOcr(
  doc: OcrDocument
): { doc: OcrDocument; report: OcrRepairReport } {
  const lines: OcrLine[] = [];
  const changes: RepairChange[] = [];
  let linesChanged = 0;

  let sourceLine = 0;
  for (const line of doc.lines) {
    const tokens: RepairToken[] = line.words.map((w) => ({
      text: w.text,
      confidence: w.confidence,
      bbox: w.bbox,
    }));
    const { lines: repairedTokenLines, changes: lineChanges } =
      repairLineWords(tokens);
    changes.push(...lineChanges);

    for (const rt of repairedTokenLines) {
      let words: OcrWord[] = rt.map((t) => ({
        text: t.text,
        confidence: t.confidence,
        bbox: t.bbox,
      }));
      if (words.every((w) => w.bbox?.x !== undefined)) {
        words = reconstructWords(words);
      }
      const text = words.map((w) => w.text).join(" ");
      const changed = text !== line.text;
      if (changed) linesChanged += 1;
      const boxes = words
        .map((w) => w.bbox)
        .filter((b): b is NonNullable<typeof b> => b !== undefined);
      const confs = words
        .map((w) => w.confidence)
        .filter((c): c is number => c !== undefined);
      lines.push({
        text,
        words,
        confidence: confs.length > 0 ? mean(confs) : line.confidence,
        bbox: unionBoxes(boxes) ?? line.bbox,
        originalText: line.text,
        repaired: changed,
        sourceLine,
        quality: assessOcrLineQuality({ text, words }),
      });
    }
    sourceLine += 1;
  }

  return {
    doc: { ...doc, lines, text: lines.map((l) => l.text).join("\n") },
    report: { linesChanged, changes },
  };
}

function mean(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}
