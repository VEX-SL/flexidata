import type { AIClient, OcrDocument, PipelineState } from "@/lib/pipeline/types";
import { runPipeline } from "@/lib/pipeline/defaults";
import { ocrPassagesStage, MAX_OCR_PASSAGES } from "@/lib/pipeline/stages/ocr-passages";
import { test, ok, equal, assert } from "./harness.ts";

/**
 * OCR-passages fallback: a dynamic extraction that surfaced NO fields must
 * still hand the reviewer the document's content. The OCR lines themselves
 * become label-less passages, each with line-indexed (and boxed) evidence, so
 * the Inspector highlights every line of text regardless of what the model
 * returned. Only dynamic mode, only when zero fields exist, verbatim lines.
 */

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

const SURAH_LINES = [
  "سورة الفاتحة",
  "بسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ",
  "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ",
  "الرَّحْمَنِ الرَّحِيمِ مَالِكِ يَوْمِ الدِّينِ",
];

const SURAH_OCR: OcrDocument = {
  text: SURAH_LINES.join("\n"),
  confidence: 0.99,
  lines: SURAH_LINES.map((text, i) => ({
    text,
    confidence: 0.99,
    words: text.split(/\s+/).map((w) => ({ text: w })),
    bbox: { x: 10, y: 40 + i * 30, width: 300, height: 22 },
  })),
};

test("fallback: a zero-field dynamic extraction surfaces every OCR line as a passage", async () => {
  const out = await runPipeline(
    {
      sourceText: SURAH_LINES.join("\n"),
      ocr: SURAH_OCR,
      profileType: "unknown",
      extractionMode: "dynamic",
    },
    { ai: fakeAI(JSON.stringify({ data: {} })) }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  const extraction = out.job!.extraction;

  equal(extraction.fields.length, SURAH_LINES.length, "every non-empty OCR line surfaced");
  equal(extraction.cleanFields.passage_1, SURAH_LINES[0], "first line verbatim");
  equal(extraction.cleanFields.passage_4, SURAH_LINES[3], "last line verbatim");
  assert(
    extraction.fields.every((f) => f.field.label === ""),
    "passages are label-less — no invented titles"
  );

  const ev = extraction.fields[2].value.evidence?.[0];
  equal(ev?.lineIndex, 2, "evidence points at the OCR line it came from");
  ok(ev?.bbox !== undefined, "boxed evidence so the overlay can highlight the line");
  ok(ev?.quote === SURAH_LINES[2], "evidence quote is the verbatim OCR line");
});

test("fallback: never duplicates lines the extraction already surfaced", async () => {
  const out = await runPipeline(
    {
      sourceText: SURAH_LINES.join("\n"),
      ocr: SURAH_OCR,
      profileType: "unknown",
      extractionMode: "dynamic",
    },
    {
      ai: fakeAI(
        JSON.stringify({
          data: {
            "سورة": {
              raw: SURAH_LINES[0],
              value: SURAH_LINES[0],
              type: "string",
              label: "Surah name",
              confidence: 0.99,
              evidence: SURAH_LINES[0],
            },
          },
        })
      ),
    }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  const extraction = out.job!.extraction;

  ok("سورة" in extraction.cleanFields, "the discovered field kept its place");
  equal(extraction.cleanFields["سورة"], SURAH_LINES[0]);

  // The title line is already represented by the field → skipped; the other
  // verses are free-form content → each still appears as a passage.
  assert(
    !("passage_1" in extraction.cleanFields),
    "the covered title line is not re-surfaced as a passage"
  );
  equal(
    extraction.cleanFields.passage_2,
    SURAH_LINES[1],
    "the first real verse appears as a passage"
  );
  ok("passage_4" in extraction.cleanFields, "later verses are surfaced too");
  equal(
    extraction.fields.filter((f) => f.field.label === "").length,
    SURAH_LINES.length - 1,
    "every unrecovered verse is a label-less passage"
  );
});

test("fallback: legacy (schema) mode is untouched", async () => {
  const out = await runPipeline(
    { sourceText: SURAH_LINES.join("\n"), ocr: SURAH_OCR, profileType: "unknown" },
    { ai: fakeAI(JSON.stringify({ data: {} })) }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  const extraction = out.job!.extraction;
  assert(
    extraction.fields.every((f) => !f.field.key.startsWith("passage_")),
    "legacy mode never synthesizes OCR passages"
  );
});

test("fallback: skips blank lines and caps the review list", () => {
  const ocr: OcrDocument = {
    text: "",
    confidence: 0.8,
    lines: [
      { text: "", words: [] },
      { text: "only this one", words: [{ text: "only" }] },
    ],
  };
  const state = {
    input: { sourceText: "", extractionMode: "dynamic" as const },
    sourceText: "",
    ocr,
    extraction: {
      extractionMode: "dynamic" as const,
      fields: [] as never[],
      fieldsMap: {},
      cleanFields: {},
    },
  };
  // run the stage standalone through a minimal pipeline state
  return runStage(state).then((out) => {
    const fvs = out.extraction.fields as Array<{ field: { key: string }; value: { value: string } }>;
    equal(fvs.length, 1, "only the non-empty line becomes a passage");
    equal(fvs[0].field.key, "passage_2", "keys follow the original line index");
    equal(MAX_OCR_PASSAGES, 80, "cap keeps infinite documents reviewable");
  });

  async function runStage(state: PipelineState): Promise<{ extraction: PipelineState["extraction"] }> {
    const stage = ocrPassagesStage();
    await stage.run(state);
    return { extraction: state.extraction };
  }
});