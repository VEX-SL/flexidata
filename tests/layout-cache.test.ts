/**
 * Milestone 9 cache tests — the deterministic layout result cache: canonical
 * OCR hashing (equivalent documents share a key, distinct documents differ),
 * stable keys, exact-object storage, and the pipeline rule that identical OCR
 * always yields the identical frozen `LayoutResult` object while failed
 * results are never cached.
 */
import {
  brokenLayoutContext,
  buildLayoutPipeline,
  canonOcr,
  createLayoutCache,
  deterministicDigest,
  hashOcr,
  layoutCacheGet,
  layoutCacheKey,
  layoutCacheSet,
} from "@/lib/layout";
import type { LayoutResult } from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import { equal, includes, ok, test } from "./harness.ts";

function mkWord(text: string, x: number, y: number, c = 0.9): OcrWord {
  return { text, confidence: c, bbox: { x, y, width: 30, height: 12 } };
}

function mkLine(y: number, words: readonly OcrWord[]): OcrLine {
  const bbox = unionBoxes(words.map((w) => w.bbox!))!;
  return { text: words.map((w) => w.text).join(" "), words: [...words], bbox };
}

function mkDoc(): OcrDocument {
  return {
    text: "INVOICE NO 1234\nItem Total",
    lines: [
      mkLine(0, [mkWord("INVOICE", 0, 0, 0.95), mkWord("NO", 90, 0, 0.9), mkWord("1234", 140, 0, 0.85)]),
      mkLine(24, [mkWord("Item", 0, 24, 0.8), mkWord("Total", 90, 24, 0.9)]),
    ],
  };
}

function mkDocVariant(): OcrDocument {
  return {
    text: "RECEIPT NO 5678\nItem Total",
    lines: [
      mkLine(0, [mkWord("RECEIPT", 0, 0, 0.95), mkWord("NO", 90, 0, 0.9), mkWord("5678", 140, 0, 0.85)]),
      mkLine(24, [mkWord("Item", 0, 24, 0.8), mkWord("Total", 90, 24, 0.9)]),
    ],
  };
}

test("canonOcr is canonical across equivalent documents", () => {
  const a = mkDoc();
  const b = mkDoc();
  ok(a !== b, "fixtures are distinct objects");
  equal(canonOcr(a), canonOcr(b), "equivalent documents canonicalize identically");
});

test("canonOcr distinguishes documents that differ", () => {
  const base = mkDoc();
  const differentText = mkDoc();
  differentText.lines[0].words[0].text = "RECEIPT";
  ok(canonOcr(base) !== canonOcr(differentText), "word text changes the canon");

  const reordered = mkDoc();
  const first = reordered.lines[0].words[0];
  const second = reordered.lines[0].words[1];
  reordered.lines[0].words[0] = second;
  reordered.lines[0].words[1] = first;
  ok(canonOcr(base) !== canonOcr(reordered), "word order changes the canon");
});

test("hashOcr and layoutCacheKey are deterministic and stable", () => {
  const doc = mkDoc();
  equal(hashOcr(doc), hashOcr(doc), "hashing is deterministic");
  equal(layoutCacheKey(doc), layoutCacheKey(doc), "keys are deterministic");
  ok(layoutCacheKey(doc) === layoutCacheKey(mkDoc()), "equivalent documents share a key");
  ok(layoutCacheKey(doc) !== layoutCacheKey(mkDocVariant()), "distinct documents differ");
  includes(layoutCacheKey(doc), "flexidata-layout-canon-v1:", "keys are prefixed and versioned");
});

test("deterministicDigest is stable and content-sensitive", () => {
  equal(deterministicDigest("abc"), deterministicDigest("abc"));
  ok(deterministicDigest("abc") !== deterministicDigest("abd"));
});

test("createLayoutCache stores and returns the exact object", () => {
  const cache = createLayoutCache();
  const result: LayoutResult = { context: brokenLayoutContext() };
  ok(cache.get("missing") === undefined, "unknown keys miss");
  ok(cache.set("k", result) === result, "set returns the stored result");
  ok(cache.get("k") === result, "get returns the exact stored object");
});

test("layoutCacheSet never stores failed results", () => {
  const cache = createLayoutCache();
  const doc = mkDoc();
  const failed: LayoutResult = {
    context: brokenLayoutContext(),
    failure: { reason: "boom", details: [] },
  };
  ok(layoutCacheSet(cache, doc, failed) === failed, "set echoes the failed result");
  ok(layoutCacheGet(cache, doc) === undefined, "failed results are not cached");

  const success: LayoutResult = { context: brokenLayoutContext() };
  layoutCacheSet(cache, doc, success);
  ok(layoutCacheGet(cache, doc) === success, "successful results are cached");
});

test("pipeline build returns the identical cached object for identical OCR", () => {
  const pipeline = buildLayoutPipeline();
  const r1 = pipeline.build(mkDoc());
  const r2 = pipeline.build(mkDoc());
  const r3 = pipeline.build(mkDoc());
  ok(r2 === r1, "repeated builds share the exact result object");
  ok(r3 === r1, "further builds keep returning the same object");
  const r4 = pipeline.build(mkDocVariant());
  ok(r4 !== r1, "a distinct document builds a distinct result");
});
