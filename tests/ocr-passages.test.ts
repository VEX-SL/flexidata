import type { AIClient, OcrDocument, PipelineState } from "@/lib/pipeline/types";
import { runPipeline } from "@/lib/pipeline/defaults";
import { ocrPassagesStage, MAX_OCR_PASSAGES } from "@/lib/pipeline/stages/ocr-passages";
import { test, ok, equal, assert } from "./harness.ts";

/**
 * OCR-content fallback: a dynamic extraction that surfaced NO fields must
 * still hand the reviewer the document's content. The OCR reading is folded
 * into label-less `content` fields so the review shows the document's content
 * (exportable, searchable) whose evidence anchors every source line.
 *
 * Paginated OCR is distributed ONE FIELD PER PAGE (`content_page_N`) — an
 * 8-page booklet in a single field is unreviewable: the reviewer cannot tell
 * which page a value came from, and every page chip in the Inspector lights up
 * at once. Un-paginated OCR keeps the single `content` field.
 *
 * Dynamic mode only, verbatim text — and only when the extraction is empty:
 * once the model found fields (schema fields or quoted passages), those ARE the
 * content and a leftover OCR blob would only add stray noise.
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

/**
 * A paginated (whole-document PDF) OCR must be distributed one field per page.
 * This is the regression test for the production complaint: an 8-page booklet
 * arrived as ONE field, so the reviewer could not tell pages apart and the
 * Inspector's page chips all highlighted at once.
 */
const PAGES: Array<{ page: number; lines: string[] }> = [
  { page: 1, lines: ["الصفحة الأولى", "السطر الأول"] },
  { page: 2, lines: ["الصفحة الثانية", "سطر من الصفحة الثانية"] },
  { page: 3, lines: ["الصفحة الثالثة"] },
];

function pagedOcr(): OcrDocument {
  const lines: OcrDocument["lines"] = [];
  PAGES.forEach(({ page, lines: texts }) => {
    texts.forEach((text, i) => {
      lines.push({
        text,
        confidence: 0.95,
        page,
        words: text.split(/\s+/).map((w) => ({ text: w })),
        bbox: { x: 5, y: 10 + i * 20, width: 200, height: 18 },
      });
    });
  });
  return { text: lines.map((l) => l.text).join("\n"), confidence: 0.95, lines };
}

test("fallback: paginated OCR is distributed one field per page, in page order", async () => {
  const ocr = pagedOcr();
  const out = await runPipeline(
    { sourceText: ocr.text, ocr, profileType: "unknown", extractionMode: "dynamic" },
    { ai: fakeAI(JSON.stringify({ data: {} })) }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  const extraction = out.job!.extraction;

  equal(
    extraction.fields.map((f) => f.field.key),
    ["content_page_1", "content_page_2", "content_page_3"],
    "one field per page, in ascending page order"
  );

  const [p1, p2, p3] = extraction.fields;
  equal(p1.value.value, PAGES[0].lines.join("\n"), "page 1 holds only page 1 text");
  equal(p2.value.value, PAGES[1].lines.join("\n"), "page 2 holds only page 2 text");
  equal(p3.value.value, PAGES[2].lines.join("\n"), "page 3 holds only page 3 text");
  assert(
    !p1.value.value.includes(PAGES[1].lines[0]),
    "no other page's text leaks into page 1"
  );

  // Labels stay empty: these are the document's own words, not named fields.
  for (const f of extraction.fields) {
    equal(f.field.label, "", "per-page content is label-less");
  }
  // The page rides in meta so the UI can group/sort without re-deriving it.
  equal((p2.value.meta as { page?: number } | undefined)?.page, 2, "page number in meta");
  // ...and on every piece of evidence, so the Inspector can highlight the page
  // a field was read from.
  for (const e of p2.value.evidence ?? []) {
    equal(e.page, 2, "evidence carries its page");
  }
});

test("fallback: per-page evidence lineIndex points at the original OCR line", async () => {
  const ocr = pagedOcr();
  const out = await runPipeline(
    { sourceText: ocr.text, ocr, profileType: "unknown", extractionMode: "dynamic" },
    { ai: fakeAI(JSON.stringify({ data: {} })) }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  const fields = out.job!.extraction.fields;
  for (const f of fields) {
    const page = (f.value.meta as { page?: number }).page;
    for (const e of f.value.evidence ?? []) {
      const line = ocr.lines[e.lineIndex!];
      equal(line.page, page, "evidence lineIndex resolves to a line on the same page");
      equal(e.quote, line.text, "evidence quotes that exact line verbatim");
      ok(e.bbox !== undefined, "boxed evidence survives the split");
    }
  }
});

test("fallback: a single-page OCR still uses one plain `content` field", async () => {
  const ocr = pagedOcr();
  const single: OcrDocument = {
    ...ocr,
    lines: ocr.lines.filter((l) => l.page === 1),
  };
  const out = await runPipeline(
    { sourceText: single.text, ocr: single, profileType: "unknown", extractionMode: "dynamic" },
    { ai: fakeAI(JSON.stringify({ data: {} })) }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  equal(
    out.job!.extraction.fields.map((f) => f.field.key),
    ["content_page_1"],
    "a one-page document gets exactly one content field"
  );
});

test("fallback: out-of-order pages are emitted in ascending order", async () => {
  const ocr = pagedOcr();
  // OCR emitted page 3 before page 1 — the field list must still read 1,2,3.
  const shuffled: OcrDocument = {
    ...ocr,
    lines: [
      ...ocr.lines.filter((l) => l.page === 3),
      ...ocr.lines.filter((l) => l.page === 1),
      ...ocr.lines.filter((l) => l.page === 2),
    ],
  };
  const out = await runPipeline(
    { sourceText: shuffled.text, ocr: shuffled, profileType: "unknown", extractionMode: "dynamic" },
    { ai: fakeAI(JSON.stringify({ data: {} })) }
  );

  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  equal(
    out.job!.extraction.fields.map((f) => f.field.key),
    ["content_page_1", "content_page_2", "content_page_3"],
    "page order is ascending regardless of OCR emission order"
  );
});

test("fallback: a rerun never stacks a second copy of the per-page content", async () => {
  const ocr = pagedOcr();
  const state: PipelineState = {
    input: { sourceText: ocr.text, extractionMode: "dynamic" as const },
    sourceText: ocr.text,
    ocr,
    extraction: {
      extractionMode: "dynamic" as const,
      fields: [] as never[],
      fieldsMap: {},
      cleanFields: {},
    },
  };
  const stage = ocrPassagesStage();
  await stage.run(state);
  const afterFirst = state.extraction.fields.length;
  await stage.run(state);
  equal(state.extraction.fields.length, afterFirst, "second run is a no-op");
  ok(afterFirst > 0, "the first run did add the per-page fields");
});

test("fallback: stays out of the way once the extraction found fields", async () => {
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
  assert(
    !("content" in extraction.cleanFields),
    "no OCR remainder blob when the model already found content"
  );
  equal(
    extraction.fields.length,
    1,
    "the extraction stays exactly what the model surfaced"
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