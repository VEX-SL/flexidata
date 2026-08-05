/**
 * Deterministic Arabic OCR before/after corpus tests.
 *
 * Runs the Arabic-first post-processing layer over a curated corpus of raw OCR
 * streams (receipts, invoices, contracts, bilingual bills, bank statements)
 * and verifies the milestone guarantees generically across document types:
 *  - text is never invented or lost (canonical character preservation),
 *  - lines are never merged,
 *  - every expected repaired line actually appears,
 *  - garbage lines are identifiable via per-line quality,
 *  - grounded extraction retains fields that only become anchorable AFTER
 *    repair (same AI output, raw vs repaired source).
 */
import { postProcessOcr } from "@/lib/ocr/arabic";
import { normalizeArabicText } from "@/lib/ocr/arabic/normalize";
import { runPipeline } from "@/lib/pipeline/defaults";
import { NOISE_THRESHOLD } from "@/lib/pipeline/text-quality";
import type { AIClient, OcrDocument } from "@/lib/pipeline/types";
import { test, ok, equal, includes } from "./harness.ts";
import { ARABIC_OCR_CORPUS } from "./fixtures/arabic-ocr-corpus.ts";

function docFrom(raw: string): OcrDocument {
  return {
    text: raw,
    lines: raw.split("\n").map((text) => ({
      text,
      words: text
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => ({ text: w })),
    })),
  };
}

const chars = (s: string) =>
  [...normalizeArabicText(s)].filter((c) => !/\s/.test(c)).sort().join("");

function fakeAI(data: Record<string, unknown>): AIClient {
  const payload = JSON.stringify({ data });
  return {
    chatCompletion: async () => ({ content: payload, model: "fake", provider: "test" }),
  };
}

async function pipelineFields(
  sourceText: string,
  profileType: string,
  ocr: OcrDocument | undefined,
  data: Record<string, unknown>
): Promise<{ kept: string[]; dropped: string[] }> {
  const out = await runPipeline({ sourceText, profileType, ocr }, { ai: fakeAI(data) });
  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  const fields = out.job!.extraction;
  return {
    kept: Object.keys(fields.fieldsMap),
    dropped: Object.keys(fields.droppedFields),
  };
}

// ─── Repair guarantees across the corpus ───────────────────────────────────

test("corpus: every document is repaired without losing or inventing text", () => {
  for (const entry of ARABIC_OCR_CORPUS) {
    const before = docFrom(entry.raw);
    const { doc, report } = postProcessOcr(before);
    const rawLines = entry.raw.split("\n").filter((l) => l.trim().length > 0).length;

    // No character may be added or removed beyond canonicalization.
    equal(chars(doc.text), chars(entry.raw), `${entry.id}: characters preserved`);
    // Repair splits lines (edge fragments) but never merges them.
    ok(doc.lines.length >= rawLines, `${entry.id}: lines are never merged`);
    ok(
      doc.lines.length <= rawLines * 3,
      `${entry.id}: at most a 3-way fragment split per line`
    );
    // The raw artifacts must still exist in the raw stream (sanity).
    for (const rawNeedle of entry.expectRaw) {
      includes(entry.raw, rawNeedle, `${entry.id}: raw artifact present`);
    }
    // The repaired evidence must appear in the post-processed text.
    for (const after of entry.expectAfter) {
      includes(doc.text, after, `${entry.id}: repaired line "${after}"`);
    }
    ok(report.linesChanged > 0, `${entry.id}: repair must change at least one line`);
  }
});

test("corpus: every line carries per-line quality metrics", () => {
  for (const entry of ARABIC_OCR_CORPUS) {
    const { doc } = postProcessOcr(docFrom(entry.raw));
    for (const line of doc.lines) {
      ok(line.quality, `${entry.id}: quality present on every line`);
      ok(typeof line.quality!.arabicRatio === "number", "arabicRatio present");
      ok(typeof line.quality!.latinRatio === "number", "latinRatio present");
      ok(typeof line.quality!.printableRatio === "number", "printableRatio present");
      ok(typeof line.quality!.noiseScore === "number", "noiseScore present");
    }
  }
});

test("corpus: garbage lines are flagged via per-line quality", () => {
  for (const entry of ARABIC_OCR_CORPUS) {
    const { doc } = postProcessOcr(docFrom(entry.raw));
    if (!entry.hasGarbage) continue;
    const garbage = doc.lines.find(
      (l) => l.quality && l.quality.noiseScore > NOISE_THRESHOLD
    );
    ok(garbage, `${entry.id}: a garbage line must be flagged`);
    const clean = doc.lines.find((l) => /انرقم المرجقي|المطلوب|الرصيد الحالي/.test(l.text));
    if (clean) ok(clean.quality!.noiseScore <= NOISE_THRESHOLD, "real lines stay clean");
  }
});

// ─── Extraction improvement proof ──────────────────────────────────────────

test("corpus: repaired OCR anchors fields the raw stream cannot ground", async () => {
  // Same model output either way: the values are correct for the document.
  // Grounding keeps them only when the source text actually contains them —
  // isolated letters ("ا ل ر ح ي م") never anchor "الرحيم", the repaired word
  // does. This is the proof that extraction improves without weakening the
  // anti-hallucination guarantee.
  const cases: Array<{
    id: string;
    profileType: string;
    nameKey: string;
    nameValue: string;
    totalKey: string;
    totalValue: string;
  }> = [
    {
      id: "receipt-thermal",
      profileType: "receipt",
      nameKey: "merchant_name",
      nameValue: "متجر الرحيم التجاري",
      totalKey: "total_amount",
      totalValue: "48.75",
    },
    {
      id: "invoice-tax",
      profileType: "invoice",
      nameKey: "seller_name",
      nameValue: "شركة نور التقنية المحدودة",
      totalKey: "total_amount",
      totalValue: "473.25",
    },
    {
      id: "contract-services",
      profileType: "contract",
      nameKey: "party_b_name",
      nameValue: "الشركة الافق العالمية",
      totalKey: "contract_value",
      totalValue: "14000",
    },
  ];

  for (const c of cases) {
    const entry = ARABIC_OCR_CORPUS.find((e) => e.id === c.id)!;
    const data: Record<string, unknown> = {
      [c.nameKey]: { raw: c.nameValue, value: c.nameValue, confidence: 0.95 },
      [c.totalKey]: { raw: c.totalValue, value: Number(c.totalValue), confidence: 0.95 },
    };

    const raw = await pipelineFields(entry.raw, c.profileType, undefined, data);
    ok(!raw.kept.includes(c.nameKey), `${c.id}: name ungroundable on raw OCR`);
    ok(raw.dropped.includes(c.nameKey), `${c.id}: grounding drops the unanchored name`);
    ok(raw.kept.includes(c.totalKey), `${c.id}: total still anchors on raw OCR`);

    const repaired = postProcessOcr(docFrom(entry.raw)).doc;
    const after = await pipelineFields(
      repaired.text,
      c.profileType,
      repaired,
      data
    );
    ok(after.kept.includes(c.nameKey), `${c.id}: name anchored after repair`);
    ok(after.kept.includes(c.totalKey), `${c.id}: total still anchored after repair`);
  }
});
