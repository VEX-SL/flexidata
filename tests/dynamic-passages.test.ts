import type { AIClient, ExtractionResult, OcrDocument } from "@/lib/pipeline/types";
import { extractDocument } from "@/lib/pipeline/extractor";
import { buildDynamicPrompt } from "@/lib/pipeline/extractor/prompt-builder";
import { normalizeDynamicFields } from "@/lib/pipeline/extractor/normalizer";
import {
  fieldSchemaForDynamicField,
  parseDynamicPassages,
} from "@/lib/pipeline/extractor/dynamic";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { test, ok, equal, assert, includes } from "./harness.ts";

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

const TEXTBOOK = [
  "حكاية من سيرة عمر بن الخطاب رضي الله عنه",
  "ذهب عمر إلى الشام فخرج الناس يستقبلونه",
  "فقال لهم إنما جئت اعرف لكم أمركم",
  "وقد سار معه غلامه",
].join("\n");

test("dynamic prompt carries the passages contract for free-form prose", () => {
  const p = buildDynamicPrompt(TEXTBOOK);
  includes(p, '"passages"');
  includes(p, "one contiguous run");
  includes(p, "full response shape");
  includes(p, "free-form body text");
});

test("parseDynamicPassages accepts verbatim prose and clamps confidence", () => {
  const raw = {
    data: {},
    passages: [
      { text: "ذهب عمر إلى الشام فخرج الناس يستقبلونه", evidence: "ذهب عمر إلى الشام", confidence: 0.97 },
      { text: "فقال لهم إنما جئت اعرف لكم أمركم", confidence: 2 },
      "not-an-object",
      null,
      42,
      { text: 123 },
      { text: "123", confidence: 0.5 },
      { text: "x", confidence: 0.5 },
      { text: "12345 !!!", confidence: 0.5 },
    ],
  };

  const specs = parseDynamicPassages(raw as never);
  equal(specs.length, 2, "only the two real prose passages survive");
  equal(specs[0].text, "ذهب عمر إلى الشام فخرج الناس يستقبلونه");
  equal(specs[0].confidence, 0.97);
  equal(specs[1].confidence, 1, "out-of-range confidence clamps to [0,1]");
});

test("parseDynamicPassages tolerates missing / malformed channels", () => {
  equal(parseDynamicPassages({ data: {} } as never).length, 0);
  equal(parseDynamicPassages({ data: {}, passages: "nope" } as never).length, 0);
  // A malformed confidence is ignored; the passage itself is still real prose.
  equal(parseDynamicPassages({ data: {}, passages: [{ text: "بدون عنوان", confidence: "x" }] } as never).length, 1);
  equal(
    parseDynamicPassages({ data: {}, passages: [{ text: "بدون" }] } as never).length,
    0,
    "single-token strings are fragments, not passages"
  );
});

test("normalizeDynamicFields ingests passages as label-less dynamic entries", () => {
  const profile = getProfileManager().get("invoice");
  const raw = {
    data: {
      "الكاتب": { raw: "ابن الجوزي", value: "ابن الجوزي", type: "string", label: "الكاتب", confidence: 0.9 },
    },
    passages: [
      { text: "ذهب عمر إلى الشام فخرج الناس يستقبلونه", confidence: 0.95 },
      { text: "فقال لهم إنما جئت اعرف لكم أمركم", confidence: 0.9 },
    ],
  };

  const map = normalizeDynamicFields(profile!, raw as never);

  ok("passage_1" in map, "first passage keyed passage_1");
  ok("passage_2" in map, "second passage keyed passage_2");
  equal(map.passage_1.value, "ذهب عمر إلى الشام فخرج الناس يستقبلونه");
  equal(map.passage_1.rawValue, "ذهب عمر إلى الشام فخرج الناس يستقبلونه");
  ok(map.passage_1.meta && map.passage_1.meta.dynamicPassage === true, "passage marker set");
  ok(map.passage_1.meta && map.passage_1.meta.dynamicType === "text", "passage typed text");
  ok("الكاتب" in map, "discovered data field still present");
});

test("passage keys never collide with model field names", () => {
  const profile = getProfileManager().get("invoice");
  const raw = {
    data: { "Passage 1": { raw: "x", value: "x" } },
    passages: [{ text: "جملة نصية حقيقية من كتاب" }],
  };
  const map = normalizeDynamicFields(profile!, raw as never);
  ok("passage_1" in map, "data field kept its name");
  ok("passage_2" in map, "the actual passage shifted to passage_2");
  equal(map.passage_1.value, "x");
  equal(map.passage_2.value, "جملة نصية حقيقية من كتاب");
});

test("e2e: a multi-line passage survives extraction and anchors every covered line", async () => {
  const profile = getProfileManager().get("invoice");
  const ai = {
    data: {
      "الفصل": {
        raw: "حكاية من سيرة عمر",
        value: "حكاية من سيرة عمر",
        type: "string",
        label: "الفصل",
        confidence: 0.9,
        evidence: "حكاية من سيرة عمر بن الخطاب رضي الله عنه",
      },
    },
    passages: [
      {
        text: "ذهب عمر إلى الشام فخرج الناس يستقبلونه فقال لهم إنما جئت اعرف لكم أمركم",
        evidence: "ذهب عمر إلى الشام فخرج الناس يستقبلونه",
        confidence: 0.94,
      },
    ],
  };

  const result = await extractDocument(
    { profile: profile!, sourceText: TEXTBOOK, extractionMode: "dynamic" },
    fakeAI(JSON.stringify(ai))
  );

  ok("passage_1" in result.cleanFields, "passage committed as extracted content");
  equal(result.fieldsMap.passage_1?.value, "ذهب عمر إلى الشام فخرج الناس يستقبلونه فقال لهم إنما جئت اعرف لكم أمركم");

  const evidence = result.fieldsMap.passage_1?.evidence ?? [];
  const lineIdx = evidence.map((e) => e.lineIndex).sort((a, b) => (a ?? 0) - (b ?? 0));
  ok(lineIdx.includes(1), "line covering the passage start is anchored");
  ok(lineIdx.includes(2), "line covering the passage end is anchored");
});

test("e2e: an invented (non-verbatim) passage is dropped, never surfaced", async () => {
  const profile = getProfileManager().get("invoice");
  const ai = {
    data: {},
    passages: [
      {
        text: "هذا النص غير موجود في المستند أصلا",
        evidence: "هذا النص غير موجود في المستند أصلا",
        confidence: 0.99,
      },
    ],
  };

  const result = await extractDocument(
    { profile: profile!, sourceText: TEXTBOOK, extractionMode: "dynamic" },
    fakeAI(JSON.stringify(ai))
  );

  equal(result.droppedFields.passage_1, "passage not found in source text");
  assert(!("passage_1" in result.cleanFields), "invented passage must never reach the result");
});

test("e2e: passage text is preserved verbatim (no normalization/rewrite)", async () => {
  const profile = getProfileManager().get("invoice");
  const exact = "وقد سار معه غلامه";
  const ai = {
    data: {},
    passages: [{ text: exact, evidence: exact, confidence: 0.9 }],
  };

  const result = await extractDocument(
    { profile: profile!, sourceText: TEXTBOOK, extractionMode: "dynamic" },
    fakeAI(JSON.stringify(ai))
  );

  equal(result.fieldsMap.passage_1?.value, exact, "passage kept as printed");
  ok(result.fieldsMap.passage_1?.evidence?.length === 1, "single-line passage anchors one line");
  equal(result.fieldsMap.passage_1?.evidence?.[0]?.lineIndex, 3);
});

// ── bounding boxes: the Inspector highlights the covered region ─────────────

function dynamicPassageExtraction(text: string): ExtractionResult {
  const fv = {
    value: text,
    rawValue: text,
    confidence: 0.9,
    source: "ai" as const,
    status: "extracted" as const,
    meta: { dynamicPassage: true, dynamicType: "text" },
  };
  return {
    profileType: "invoice",
    profileVersion: 1,
    extractionMode: "dynamic" as const,
    fields: [{ field: fieldSchemaForDynamicField("passage_1", fv), value: fv }],
    fieldsMap: { passage_1: fv },
    cleanFields: { passage_1: text },
    droppedFields: {},
  };
}

function ocrWithBoxes(lines: Array<{ text: string; box: { x: number; y: number; width: number; height: number } }>): OcrDocument {
  return {
    text: lines.map((l) => l.text).join("\n"),
    lines: lines.map((l) => ({
      text: l.text,
      words: l.text.split(/\s+/).map((w) => ({ text: w, bbox: l.box })),
      bbox: l.box,
    })),
  };
}

test("grounding attaches a per-line bbox to every covered passage line", () => {
  const docs = [
    { text: "ذهب عمر إلى الشام فخرج الناس يستقبلونه", box: { x: 10, y: 40, width: 300, height: 18 } },
    { text: "فقال لهم إنما جئت اعرف لكم أمركم", box: { x: 10, y: 66, width: 280, height: 18 } },
  ];
  const passage = "ذهب عمر إلى الشام فخرج الناس يستقبلونه" + " " + "فقال لهم إنما جئت اعرف لكم أمركم";

  const out = groundExtraction(
    getProfileManager().get("invoice")!,
    dynamicPassageExtraction(passage),
    docs.map((d) => d.text).join("\n"),
    ocrWithBoxes(docs)
  );

  const fv = out.fieldsMap.passage_1;
  ok(fv, "passage survives grounding");
  ok((fv?.evidence ?? []).length >= 2, "every covered line anchored");
  const lens = (fv?.evidence ?? []).map((e) => e.lineIndex ?? -1).sort((a, b) => a - b);
  equal(lens[0], 0);
  equal(lens[1], 1);
  const withBbox = (fv?.evidence ?? []).filter((e) => e.bbox !== undefined);
  ok(withBbox.length >= 2, "each covered line carries a box for the overlay");
  ok((withBbox[0]?.bbox?.y ?? 0) > 0, "the first covered box comes from the page");
});

test("a passage that ends mid-line still anchors the exact covered lines", async () => {
  const profile = getProfileManager().get("invoice");
  const partial = "ذهب عمر إلى الشام فخرج"; // ends inside line 1
  const ai = {
    data: {},
    passages: [{ text: partial, evidence: partial, confidence: 0.9 }],
  };

  const result = await extractDocument(
    { profile: profile!, sourceText: TEXTBOOK, extractionMode: "dynamic" },
    fakeAI(JSON.stringify(ai))
  );

  equal(result.fieldsMap.passage_1?.value, partial);
  ok((result.fieldsMap.passage_1?.evidence ?? []).length === 1, "mid-line passage anchors its own line");
});