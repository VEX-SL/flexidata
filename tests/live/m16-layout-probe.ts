/**
 * M16 read-only probe — layout path (production shape).
 * Builds a structured OCR (per-word boxes + confidences) for an itemized
 * receipt and runs the exact production ground stage (layout evidence
 * provider). Verifies line_items receive evidence through the LAYOUT ladder
 * too, not just the OCR-only path.
 */
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import {
  createLayoutEvidenceProvider,
  layoutReaderFor,
} from "@/lib/extraction/layout-aware-evidence";
import { unionBoxes } from "@/lib/pipeline/geometry";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";

const SRC = "CORNER STORE\nMILK 3.50\nBREAD 2.00\nTOTAL 5.50";
const AI_CONF = 0.9;
const WORD_CONF = 0.768;

function mkWord(text: string, x: number, y: number): OcrWord {
  return { text, confidence: WORD_CONF, bbox: { x, y, width: 30, height: 12 } };
}

function buildDoc(): OcrDocument {
  const lines = SRC.split(/\r?\n/);
  const out: OcrLine[] = lines.map((text, li) => {
    const y = li * 16;
    const words = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w, wi) => mkWord(w, wi * 40, y));
    return { text, originalText: text, words, bbox: unionBoxes(words.map((w) => w.bbox!))! };
  });
  return { text: SRC, lines: out };
}

const profile = getProfileManager().get("receipt")!;
const ocr = buildDoc();
const fv = {
  value: [
    { description: "MILK", quantity: 1, unit_price: 3.5, amount: 3.5 },
    { description: "BREAD", quantity: 1, unit_price: 2, amount: 2 },
  ],
  rawValue: "MILK 3.50\nBREAD 2.00",
  confidence: AI_CONF,
  source: "ai" as const,
  status: "extracted" as const,
};
const lineItemsField = profile.schema.fields.find((f) => f.key === "line_items")!;

const extraction = {
  profileType: "receipt" as const,
  profileVersion: 1,
  fields: [{ field: lineItemsField, value: fv }],
  fieldsMap: { line_items: fv },
  cleanFields: { line_items: fv.value },
  droppedFields: {} as Record<string, string>,
};

const provider = createLayoutEvidenceProvider(layoutReaderFor(ocr));
const grounded = groundExtraction(profile, extraction, SRC, ocr, provider);

const items = grounded.fieldsMap.line_items;
console.log("=== M16 layout-path probe ===");
if (!items) {
  console.log("DROPPED:", grounded.droppedFields.line_items);
  process.exit(1);
}
console.log(`evidence: ${(items.evidence ?? []).map((e) => `L${e.lineIndex} [${"scope" in e ? e.scope : "?"}] "${e.quote}"`).join(" | ")}`);
console.log(`reasons: [${(items.reasons ?? []).join(", ")}]`);
console.log(`confidence: ${items.confidence?.toFixed(4)}`);
console.log(`no_direct_evidence present: ${(items.reasons ?? []).includes("no_direct_evidence")}`);
