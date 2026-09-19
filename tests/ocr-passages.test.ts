import type { AIClient, OcrDocument, PipelineState } from "@/lib/pipeline/types";
import { runPipeline } from "@/lib/pipeline/defaults";
import { ocrPassagesStage, MAX_OCR_PASSAGES } from "@/lib/pipeline/stages/ocr-passages";
import { test, ok, equal, assert } from "./harness.ts";

/**
 * OCR-content fallback: a dynamic extraction that surfaced NO fields must
 * still hand the reviewer the document's content. The OCR's unrecovered lines
 * are folded into ONE label-less `content` field whose evidence still anchors
 * every source line, so the review shows a single reviewable block while the
 * Inspector can highlight the whole region. Dynamic mode only, verbatim text.
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

test("fallback: a zero-field dynamic extraction surfaces the OCR as ONE content field", async () => {
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

  equal(extraction.fields.length, 1, "the whole reading is one field");
  const content = extraction.fields[0];
  equal(content.field.key, "content", "single content field key");
  equal(content.field.label, "", "content is label-less — no invented titles");
  equal(extraction.cleanFields.content, SURAH_LINES.join("\n"), "full OCR text verbatim");
  equal(content.value.value, SURAH_LINES.join("\n"), "value holds the whole reading");

  const evidence = content.value.evidence ?? [];
  equal(evidence.length, SURAH_LINES.length, "every line is still anchored");
  equal(evidence[0]?.lineIndex, 0, "evidence points at the OCR line it came from");
  ok(evidence[0]?.bbox !== undefined, "boxed evidence so the overlay can highlight the line");
  equal(evidence[2]?.quote, SURAH_LINES[2], "evidence quotes the verbatim OCR line");
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
  // verses are free-form content → they land in the single content block.
  equal(
    extraction.cleanFields.content,
    SURAH_LINES.slice(1).join("\n"),
    "only the unrecovered lines form the content field"
  );
  const content = extraction.fields.find((f) => f.field.key === "content")!;
  equal(
    (content.value.evidence ?? []).length,
    SURAH_LINES.length - 1,
    "covered title line has no evidence entry"
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
    !("content" in extraction.fieldsMap),
    "legacy mode never synthesizes the OCR content field"
  );
});

test("fallback: skips blank lines and caps the content field", () => {
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
    equal(fvs.length, 1, "only the non-empty line becomes the content field");
    equal(fvs[0].field.key, "content", "single content field");
    equal(fvs[0].value.value, "only this one", "blank lines are dropped");
    equal(MAX_OCR_PASSAGES, 500, "cap keeps enormous documents reviewable");
  });

  async function runStage(state: PipelineState): Promise<{ extraction: PipelineState["extraction"] }> {
    const stage = ocrPassagesStage();
    await stage.run(state);
    return { extraction: state.extraction };
  }
});