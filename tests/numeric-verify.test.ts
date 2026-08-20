import {
  applyVerifiedValue,
  canonicalNumeric,
  cropRegionPng,
  decideVerification,
  detectNumericCandidates,
  validateCandidate,
  verifyNumericCandidates,
  whitelistFor,
  MAX_CANDIDATES,
  MIN_VERIFIED_CONFIDENCE,
} from "@/lib/ocr/numeric-verify";
import type { NumericCandidate, RegionReader } from "@/lib/ocr/numeric-verify";
import type { OcrDocument, OcrWord } from "@/lib/pipeline/types";
import { test, ok, equal } from "./harness.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function line(text: string, conf = 0.9): OcrDocument["lines"][number] {
  const words: OcrWord[] = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t, i) => ({
      text: t,
      confidence: conf,
      bbox: { x: i * 12, y: 0, width: 10, height: 12 },
    }));
  return { text, words, confidence: conf, bbox: { x: 0, y: 0, width: words.length * 12, height: 12 } };
}

function docOf(...lines: OcrDocument["lines"][]): OcrDocument {
  return { text: lines.map((l) => l.text).join("\n"), lines };
}

function tinyPng(): Buffer {
  // 24x12 white image with a black 8x8 square at (4,2) — valid crop source.
  const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
  const c = createCanvas(24, 12);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 24, 12);
  ctx.fillStyle = "black";
  ctx.fillRect(4, 2, 8, 8);
  return Buffer.from(c.toBuffer("image/png"));
}

function stubReader(
  reads: Array<{ text: string; confidence: number } | null>
): { reread: RegionReader; calls: Array<{ whitelist: string }> } {
  const calls: Array<{ whitelist: string }> = [];
  let i = 0;
  const reread: RegionReader = async (_crop, whitelist) => {
    calls.push({ whitelist });
    const r = reads[Math.min(i++, reads.length - 1)];
    return r === null ? null : { ...r };
  };
  return { reread, calls };
}

const txn = "8870218308113215";

// ─── 1. Candidate detection ────────────────────────────────────────────────

test("detection: label-anchored lines map to their numeric kind", () => {
  const doc = docOf(
    line("رقم العملية: 8870218308113215["),
    line("التاريخ: 02-07-2028"),
    line("الإجمالي: 68.38"),
    line("الحساب: 391003452"),
    line("المشتري: 9640833767")
  );
  const cands = detectNumericCandidates(doc, 6);
  equal(
    cands.map((c) => c.kind),
    ["transaction", "date", "amount", "account", "customer"]
  );
  equal(cands[0].primaryText, "8870218308113215[");
  equal(cands[1].primaryText, "02-07-2028");
});

test("detection: standalone long digit token on an unlabeled line", () => {
  const doc = docOf(line(txn));
  const cands = detectNumericCandidates(doc, 6);
  equal(cands.length, 1);
  equal(cands[0].kind, "number");
  equal(cands[0].primaryText, txn);
  ok(cands[0].bbox.width > 0, "pattern candidate carries a bbox");
});

test("detection: RTL visual-order 'value : label' line is caught by colon adjacency", () => {
  // Arabic repair could not reorder this line, so the number leads; the " : "
  // separator marks the value position structurally (no label assumption).
  // The thermal "انعمليه" variant is a known label-group word, so the line is
  // anchored as a transaction candidate.
  const doc = docOf(line("607021830113216] : رقم انعمليه"));
  const cands = detectNumericCandidates(doc, 6);
  equal(cands.length, 1);
  equal(cands[0].kind, "transaction");
  equal(cands[0].primaryText, "607021830113216]");
});

test("detection: date tokens next to ':' stay excluded (digit ratio guard)", () => {
  // "02-07-2026" has ratio 0.8 < 0.85 — never treated as a bare ID token,
  // so a date can never be re-read with the digits-only whitelist.
  const doc = docOf(line("18:30:12 02-07-2026 : قسم الدعم"));
  const cands = detectNumericCandidates(doc, 6);
  equal(cands.length, 0);
});

test("detection: label-anchored date line with a time token stays a date", () => {
  const doc = docOf(line("18:30:12 02-07-2026 : تاريخ انتوقت"));
  const cands = detectNumericCandidates(doc, 6);
  equal(cands.length, 1);
  equal(cands[0].kind, "date");
  equal(cands[0].primaryText, "18:30:12 02-07-2026");
});

test("detection: phone/quantity-like tokens are excluded", () => {
  const doc = docOf(line("(0123456789); 15468"));
  const cands = detectNumericCandidates(doc, 6);
  equal(cands.length, 0);
});

test("detection: words without a bbox are skipped (crop needs bbox space)", () => {
  const noBox: OcrDocument["lines"][number] = {
    text: `رقم العملية: ${txn}`,
    words: [{ text: "رقم" }, { text: "العملية:" }, { text: txn }],
  };
  const cands = detectNumericCandidates(docOf(noBox), 6);
  equal(cands.length, 0);
});

test("detection: capped at max candidates in document order", () => {
  const many = Array.from({ length: 8 }, (_, i) => line(`خط ${i}: ${txn.slice(0, 8)}${i}`));
  const cands = detectNumericCandidates(docOf(...many), MAX_CANDIDATES);
  equal(cands.length, MAX_CANDIDATES);
  equal(cands[0].primaryText, `${txn.slice(0, 8)}0`);
});

// ─── 2. Deterministic validation ───────────────────────────────────────────

test("validation: ID kinds follow the digits + length contract", () => {
  equal(validateCandidate("transaction", txn), "valid");
  equal(validateCandidate("reference", "2013438351"), "valid");
  equal(validateCandidate("account", "391003452"), "valid");
  equal(validateCandidate("customer", "9640833767"), "valid");
  equal(validateCandidate("transaction", "8870218308113215["), "invalid");
  equal(validateCandidate("transaction", "abc123"), "invalid");
  equal(validateCandidate("transaction", "12345"), "ambiguous");
  equal(validateCandidate("transaction", "1234567890123456789012345"), "ambiguous");
  equal(validateCandidate("transaction", "12345678901234567890123456"), "invalid");
});

test("validation: amount format rules", () => {
  equal(validateCandidate("amount", "68.38"), "valid");
  equal(validateCandidate("amount", "68,38"), "valid");
  equal(validateCandidate("amount", "1,234.56"), "valid");
  equal(validateCandidate("amount", "1.234,56"), "valid");
  equal(validateCandidate("amount", "abc"), "invalid");
  equal(validateCandidate("amount", "12.3.4"), "ambiguous");
  // "68.388" is well-formed under the grouped-thousands rule (68,388).
  equal(validateCandidate("amount", "68.388"), "valid");
});

test("validation: date rules check day/month only — never business context", () => {
  equal(validateCandidate("date", "02-07-2028"), "valid");
  equal(validateCandidate("date", "02-07-2026"), "valid");
  equal(validateCandidate("date", "02/07/2026"), "valid");
  equal(validateCandidate("date", "02.07.2026"), "valid");
  equal(validateCandidate("date", "32-13-2020"), "invalid");
  equal(validateCandidate("date", "12/2024"), "ambiguous");
});

test("validation: NO business-assumption invention — both years are equally valid", () => {
  // The verifier must never prefer 2026 over 2028 (or vice versa) from context:
  // both are syntactically valid, and only the actual verification read decides.
  equal(validateCandidate("date", "02-07-2028"), "valid");
  equal(validateCandidate("date", "02-07-2026"), "valid");
  equal(canonicalNumeric("68,38"), "6838");
  equal(canonicalNumeric("68.38"), "6838");
});

// ─── 3. Decision table ─────────────────────────────────────────────────────

test("decide: no verification read → keep primary", () => {
  const { decision, reason } = decideVerification(
    { text: txn, confidence: 0.4, status: "valid" },
    null
  );
  equal(decision, "keep_primary");
  equal(reason, "verifier_unusable");
});

test("decide: verifier read is invalid → keep primary", () => {
  const { decision, reason } = decideVerification(
    { text: txn, confidence: 0.4, status: "valid" },
    { text: "abc", confidence: 0.9, status: "invalid" }
  );
  equal(decision, "keep_primary");
  equal(reason, "verifier_invalid");
});

test("decide: agreement keeps primary, confidence untouched", () => {
  const { decision, reason } = decideVerification(
    { text: "391003452", confidence: 0.55, status: "valid" },
    { text: "391003452", confidence: 0.95, status: "valid" }
  );
  equal(decision, "keep_primary");
  equal(reason, "primary_valid_verifier_agrees");
});

test("decide: verifier ambiguous → keep primary", () => {
  const { decision, reason } = decideVerification(
    { text: txn, confidence: 0.4, status: "valid" },
    { text: "12345", confidence: 0.9, status: "ambiguous" }
  );
  equal(decision, "keep_primary");
  equal(reason, "verifier_ambiguous");
});

test("decide: weak verifier read is never accepted", () => {
  const { decision, reason } = decideVerification(
    { text: txn, confidence: 0.4, status: "invalid" },
    { text: "8870218308113214", confidence: MIN_VERIFIED_CONFIDENCE - 0.05, status: "valid" }
  );
  equal(decision, "keep_primary");
  equal(reason, "verifier_low_confidence");
});

test("decide: invalid primary + valid verifier → use verifier", () => {
  const { decision, reason } = decideVerification(
    { text: "8870218308113215[", confidence: 0.4, status: "invalid" },
    { text: txn, confidence: 0.9, status: "valid" }
  );
  equal(decision, "use_verified");
  equal(reason, "primary_invalid_verifier_valid");
});

test("decide: clearly stronger verifier evidence wins over a valid primary", () => {
  const { decision, reason } = decideVerification(
    { text: "8870218308113215", confidence: 0.7, status: "valid" },
    { text: "8870218308113214", confidence: 0.95, status: "valid" }
  );
  equal(decision, "use_verified");
  equal(reason, "verifier_clearly_stronger_evidence");
});

test("decide: no decisive evidence → ambiguous, keep primary", () => {
  const { decision, reason } = decideVerification(
    { text: "8870218308113215", confidence: 0.8, status: "valid" },
    { text: "8870218308113214", confidence: 0.85, status: "valid" }
  );
  equal(decision, "ambiguous_keep_primary");
  equal(reason, "no_decisive_evidence");
});

test("decide: primary ambiguous → never replaced", () => {
  const { decision, reason } = decideVerification(
    { text: "12345", confidence: 0.4, status: "ambiguous" },
    { text: "8870218308113214", confidence: 0.95, status: "valid" }
  );
  equal(decision, "keep_primary");
  equal(reason, "primary_ambiguous_no_replacement");
});

test("decide: 2028 vs 2026 — only the verification evidence decides, never business rules", () => {
  // Primary "2028" is valid; a weak verifier read of "2026" must NOT replace it.
  const weak = decideVerification(
    { text: "02-07-2028", confidence: 0.7, status: "valid" },
    { text: "02-07-2026", confidence: 0.8, status: "valid" }
  );
  equal(weak.decision, "ambiguous_keep_primary");
  equal(weak.reason, "no_decisive_evidence");

  // A strong verifier read may — that is evidence, not a year assumption.
  const strong = decideVerification(
    { text: "02-07-2028", confidence: 0.7, status: "valid" },
    { text: "02-07-2026", confidence: 0.95, status: "valid" }
  );
  equal(strong.decision, "use_verified");
});

// ─── 4. Apply ──────────────────────────────────────────────────────────────

test("apply: multi-word candidate collapses into the verified reading", () => {
  const doc = docOf(line(`رقم العملية: ${txn}[`));
  const cand: NumericCandidate = {
    kind: "transaction",
    lineIndex: 0,
    wordIndices: [2, 3],
    bbox: { x: 24, y: 0, width: 22, height: 12 },
    primaryText: `${txn}[ 7`,
    primaryConfidence: 0.4,
  };
  const out = applyVerifiedValue(doc, cand, txn, 0.92);
  equal(out.lines[0].text, "رقم العملية: " + txn);
  equal(out.lines[0].words.length, 3);
  equal(out.lines[0].words[2].text, txn);
  equal(out.lines[0].words[2].confidence, 0.92);
  equal(out.lines[0].words[2].bbox, cand.bbox);
  equal(out.text, "رقم العملية: " + txn);
});

// ─── 5. Orchestration (end-to-end with stub re-read) ───────────────────────

test("verify: invalid primary replaced when the verifier read is valid", async () => {
  const doc = docOf(line(`رقم العملية: ${txn}[`));
  const { reread, calls } = stubReader([{ text: txn, confidence: 0.92 }, { text: txn, confidence: 0.9 }]);
  const out = await verifyNumericCandidates(doc, {
    buffer: tinyPng(),
    exif: 1,
    reread,
  });

  equal(out.doc.lines[0].text, `رقم العملية: ${txn}`);
  equal(calls[0].whitelist, "0123456789 ");
  equal(calls[1].whitelist, "", "second independent read is unrestricted");
  const rec = out.report.verifications[0];
  equal(rec.decision, "use_verified");
  equal(rec.reason, "primary_invalid_verifier_valid");
  equal(rec.verifiedValue, txn);
  ok(rec.doubleReadAgreed, "both reads agree");
  equal(out.report.stoppedEarly, false);
  equal(out.doc.meta?.numericVerifications, out.report.verifications, "report attached to meta");
});

test("verify: valid + confident primary is skipped (no re-read, no record)", async () => {
  const doc = docOf(line(`رقم العملية: ${txn}`));
  const { reread, calls } = stubReader([{ text: txn, confidence: 0.9 }]);
  const out = await verifyNumericCandidates(doc, { buffer: tinyPng(), exif: 1, reread });
  equal(calls.length, 0);
  equal(out.report.verifications.length, 0);
  equal(out.doc.meta, undefined, "no verification → no meta payload");
});

test("verify: hard budget stops the pass", async () => {
  const doc = docOf(line(`رقم العملية: ${txn}[`), line(`التاريخ: 02-07-2028`));
  const { reread } = stubReader([{ text: txn, confidence: 0.9 }]);
  const out = await verifyNumericCandidates(doc, { buffer: tinyPng(), exif: 1, reread, budgetMs: 0 });
  ok(out.report.stoppedEarly, "budget exhausted");
  ok(
    out.report.skipped.some((s) => s.reason === "budget_exhausted"),
    "later candidates are skipped"
  );
  // Budget is checked before each candidate: the first one may still run when
  // elapsed is 0ms — that is the documented behavior, never an unbounded pass.
  ok(out.report.verifications.length <= 1, "at most the first candidate ran");
});

test("verify: no-invention on dates — weak 2026 read cannot replace 2028", async () => {
  const doc = docOf(line("التاريخ: 02-07-2028", 0.55));
  const { reread } = stubReader([{ text: "02-07-2026", confidence: 0.6 }, { text: "02-07-2026", confidence: 0.6 }]);
  const out = await verifyNumericCandidates(doc, { buffer: tinyPng(), exif: 1, reread });

  equal(out.doc.text, "التاريخ: 02-07-2028", "primary kept verbatim");
  const rec = out.report.verifications[0];
  equal(rec.decision, "ambiguous_keep_primary");
  equal(rec.reason, "no_decisive_evidence");
  equal(rec.primaryValue, "02-07-2028");
  equal(rec.verifiedValue, "02-07-2026");
});

test("verify: strong verifier read may replace — evidence, not a year rule", async () => {
  const doc = docOf(line("التاريخ: 02-07-2028", 0.55));
  const { reread } = stubReader([{ text: "02-07-2026", confidence: 0.95 }, { text: "02-07-2026", confidence: 0.95 }]);
  const out = await verifyNumericCandidates(doc, { buffer: tinyPng(), exif: 1, reread });

  equal(out.doc.text, "التاريخ: 02-07-2026");
  equal(out.report.verifications[0].decision, "use_verified");
});

test("verify: agreement keeps the primary confidence untouched", async () => {
  const doc = docOf(line("الحساب: 391003452", 0.55));
  const { reread } = stubReader([{ text: "391003452", confidence: 0.95 }, { text: "391003452", confidence: 0.95 }]);
  const out = await verifyNumericCandidates(doc, { buffer: tinyPng(), exif: 1, reread });

  const rec = out.report.verifications[0];
  equal(rec.decision, "keep_primary");
  equal(rec.reason, "primary_valid_verifier_agrees");
  equal(rec.primaryConfidence, 0.55, "primary confidence never inflated");
  equal(out.doc.lines[0].words[1].confidence, 0.55);
});

test("verify: unusable verifier read keeps the primary", async () => {
  const doc = docOf(line(`رقم العملية: ${txn}[`));
  const { reread } = stubReader([null]);
  const out = await verifyNumericCandidates(doc, { buffer: tinyPng(), exif: 1, reread });
  equal(out.doc.text, `رقم العملية: ${txn}[`);
  equal(out.report.verifications[0].reason, "verifier_unusable");
});

test("verify: invalid verifier read keeps the primary", async () => {
  const doc = docOf(line(`رقم العملية: ${txn}[`));
  const { reread } = stubReader([{ text: "abc", confidence: 0.9 }, { text: "abc", confidence: 0.9 }]);
  const out = await verifyNumericCandidates(doc, { buffer: tinyPng(), exif: 1, reread });
  equal(out.doc.text, `رقم العملية: ${txn}[`);
  equal(out.report.verifications[0].reason, "verifier_invalid");
});

// ─── 6. Crop pipeline ──────────────────────────────────────────────────────

test("cropRegionPng: returns a usable PNG crop with padding", async () => {
  const png = await cropRegionPng(tinyPng(), 1, { x: 4, y: 2, width: 8, height: 8 });
  ok(png && png.length > 0, "crop produced bytes");
  ok(png![0] === 0x89 && png![1] === 0x50, "crop is a PNG");

  // Decode the crop and verify it carries real ink-on-paper content (a 1-channel
  // RGBA bug renders the whole crop as transparent black — nothing readable).
  const { loadImage } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
  const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
  const img = await loadImage(png!);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  let dark = 0;
  let light = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 128) dark++;
    else light++;
  }
  const darkShare = dark / (dark + light);
  ok(darkShare > 0.05 && darkShare < 0.6, `crop has both ink and paper (dark=${darkShare.toFixed(2)})`);
  ok(light > 0, "crop is not fully black");
});

test("whitelistFor: documented per-kind whitelists", () => {
  equal(whitelistFor("date"), "0123456789./:- ");
  equal(whitelistFor("amount"), "0123456789., ");
  equal(whitelistFor("transaction"), "0123456789 ");
  equal(whitelistFor("reference"), "0123456789 ");
});