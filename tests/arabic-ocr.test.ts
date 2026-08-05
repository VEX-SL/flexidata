import { postProcessOcr } from "@/lib/ocr/arabic";
import { normalizeArabicText } from "@/lib/ocr/arabic/normalize";
import { repairLineWords, type RepairToken } from "@/lib/ocr/arabic/repair";
import { reconstructWords } from "@/lib/ocr/arabic/reconstruct";
import { normalizeText } from "@/lib/pipeline/ocr";
import {
  assessOcrLineQuality,
  NOISE_THRESHOLD,
} from "@/lib/pipeline/text-quality";
import type { OcrDocument, OcrWord } from "@/lib/pipeline/types";
import { test, ok, equal, includes } from "./harness.ts";
import { SUPERYPAY_RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";

function docFrom(text: string): OcrDocument {
  return {
    text,
    lines: text.split("\n").map((t) => ({
      text: t,
      words: t
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => ({ text: w })),
    })),
  };
}

function toks(xs: string[], confs?: number[]): RepairToken[] {
  return xs.map((t, i) => ({ text: t, confidence: confs?.[i] }));
}

function word(text: string, x: number): OcrWord {
  return { text, bbox: { x, y: 0, width: 10, height: 10 } };
}

const join = (t: RepairToken[]): string => t.map((x) => x.text).join(" ");
const lineTexts = (r: ReturnType<typeof repairLineWords>): string[] =>
  r.lines.map((l) => join(l));

// ─── Arabic normalization layer ────────────────────────────────────────────

test("normalization collapses alef, yeh and ta-marbuta variants", () => {
  equal(normalizeArabicText("أحمد آل إبراهيم آدم ٱبن"), "احمد ال ابراهيم ادم ابن");
  equal(normalizeArabicText("على هذا الملكی"), "علي هذا الملكي");
  equal(normalizeArabicText("ناجحة شركة"), "ناجحه شركه");
});

test("normalization unifies Arabic-Indic and Persian digits", () => {
  equal(normalizeArabicText("٦٨٫٣٨"), "68.38");
  equal(normalizeArabicText("١٢٣٤٥٦٧٨٩٠"), "1234567890");
  equal(normalizeArabicText("۱۲۳"), "123");
});

test("normalization strips invisible characters, RTL markers and kashida", () => {
  const dirty = "\u200e\u061c\u200b\u200c\u200d\u2068\u202e\u0640ال\u0640رحيم\u202c";
  equal(normalizeArabicText(dirty), "الرحيم");
});

test("normalization applies NFKC (Arabic presentation forms + ligatures)", () => {
  equal(normalizeArabicText("\ufefb"), "لا"); // lam-alef ligature
  equal(normalizeArabicText("\ufedd"), "ل"); // lam presentation form
});
test("normalizeText canonicalizes Arabic symmetrically for matching", () => {
  equal(normalizeText("الإجمالي"), normalizeText("الاجمالي"));
  equal(normalizeText("عملية ناجحة"), normalizeText("عملية ناجحه"));
  equal(normalizeText("المبلغ"), normalizeText("المبلغ"));
  equal(normalizeText("02-07-2028"), "02-07-2028");
});

// ─── Arabic OCR repair ─────────────────────────────────────────────────────

test("isolated Arabic letters are reassembled into words", () => {
  const r = repairLineWords(toks(["ا", "ل", "ر", "ح", "ي", "م"]));
  equal(lineTexts(r).join("|"), "الرحيم");
  ok(!r.lines.some((l) => l.length > 1), "single word must be one token");
});

test("isolated letters are joined only when consecutive", () => {
  const r = repairLineWords(toks(["ا", "0", "ل", "1"]));
  equal(lineTexts(r).join("|"), "ا 0 ل 1");
});

test("duplicated Arabic letters collapse only when confidence supports it", () => {
  equal(lineTexts(repairLineWords(toks(["الللرحيم"], [0.5]))).join("|"), "الرحيم");
  equal(lineTexts(repairLineWords(toks(["الللرحيم"], [0.95]))).join("|"), "الللرحيم");
  equal(lineTexts(repairLineWords(toks(["الله"], [0.5]))).join("|"), "الله");
  equal(lineTexts(repairLineWords(toks(["اللللرحيم"], [0.95]))).join("|"), "الرحيم");
});

test("spacing corruption at script/digit boundaries is repaired", () => {
  equal(lineTexts(repairLineWords(toks(["SuperPay60"]))).join("|"), "SuperPay 60");
  equal(lineTexts(repairLineWords(toks(["رقم2013"]))).join("|"), "رقم 2013");
  equal(lineTexts(repairLineWords(toks(["ZahraAman"]))).join("|"), "ZahraAman");
  equal(lineTexts(repairLineWords(toks(["X8"]))).join("|"), "X8");
  equal(lineTexts(repairLineWords(toks(["F-1"]))).join("|"), "F-1");
});

test("alphanumeric references with short prefixes are never split", () => {
  // IBAN-like references and codes must stay verbatim so values keep
  // grounding against the OCR surface.
  equal(lineTexts(repairLineWords(toks(["SA1234567890"]))).join("|"), "SA1234567890");
  equal(lineTexts(repairLineWords(toks(["CT2025881"]))).join("|"), "CT2025881");
  equal(lineTexts(repairLineWords(toks(["ABC123456"]))).join("|"), "ABC123456");
});

test("line-edge fragments are detached, never deleted", () => {
  const r = repairLineWords(toks(["gla", "المطلوب", ":", "68.38", ";"]));
  equal(lineTexts(r).join("|"), "المطلوب : 68.38 ;|gla");
});

test("edge fragments with symbols ride along but digits protect values", () => {
  equal(
    lineTexts(repairLineWords(toks(["glad", "|", "العلى", ":", "68.38"]))).join("|"),
    "العلي : 68.38|glad |"
  );
  equal(
    lineTexts(repairLineWords(toks(["له", "SuperPay", "60"]))).join("|"),
    "SuperPay 60|له"
  );
  equal(
    lineTexts(repairLineWords(toks(["B", "انرقم", "المرجقي", ":", "2013438351"]))).join("|"),
    "انرقم المرجقي : 2013438351|B"
  );
  // Values are never touched by detachment.
  equal(
    lineTexts(repairLineWords(toks(["رقم", "الحساب", ":", "391803452"]))).join("|"),
    "رقم الحساب : 391803452"
  );
});

test("genuine mixed lines and pure-Arabic lines are left intact", () => {
  equal(lineTexts(repairLineWords(toks(["فندق", "الحرم", "Hyatt"]))).join("|"), "فندق الحرم Hyatt");
  equal(lineTexts(repairLineWords(toks(["السلام", "عليكم"]))).join("|"), "السلام عليكم");
  equal(lineTexts(repairLineWords(toks(["Zahra", "Aman", "="]))).join("|"), "Zahra Aman =");
});

// ─── RTL line reconstruction ───────────────────────────────────────────────

test("visual-order RTL lines are rebuilt into reading order", () => {
  // Bank hotline line emitted left-to-right: reading order reverses the runs.
  const ws = [word("8001241222", 10), word("هاتف", 40), word("الراجحي", 70)];
  equal(reconstructWords(ws).map((w) => w.text).join(" "), "الراجحي هاتف 8001241222");
});

test("Arabic values around numbers keep reading order", () => {
  const ws = [word("ريال", 10), word("68.38", 40), word("المطلوب", 70)];
  equal(reconstructWords(ws).map((w) => w.text).join(" "), "المطلوب 68.38 ريال");
});

test("already-ordered lines, single-script and LTR lines are never touched", () => {
  // Logical order already (tesseract applied bidi): visual ≠ emitted → untouched.
  const logical = [word("له", 70), word("SuperPay", 40), word("60", 10)];
  equal(reconstructWords(logical).map((w) => w.text).join(" "), "له SuperPay 60");
  // Pure Arabic already in reading order → untouched.
  const pureAr = [word("السلام", 70), word("عليكم", 40)];
  equal(reconstructWords(pureAr).map((w) => w.text).join(" "), "السلام عليكم");
  // LTR-dominant mixed line → untouched.
  const ltr = [word("له", 10), word("Zahra", 40), word("Aman", 70)];
  equal(reconstructWords(ltr).map((w) => w.text).join(" "), "له Zahra Aman");
});

test("reconstruction requires word boxes", () => {
  const noBox = [{ text: "60" }, { text: "SuperPay" }, { text: "له" }];
  equal(reconstructWords(noBox).map((w) => w.text).join(" "), "60 SuperPay له");
});

// ─── Quality scoring ───────────────────────────────────────────────────────

test("per-line quality scores identify garbage before extraction", () => {
  // Real line-merge artifact (letters+digits glued) → garbage.
  const garbage = assessOcrLineQuality({
    text: "Hostinger;Description…)0123456788(",
    words: [],
  });
  ok(garbage.noiseScore > NOISE_THRESHOLD, "line-merge artifact must be garbage");
  // Common punctuation alone must never flag a line.
  const cleanAr = assessOcrLineQuality({ text: "المطلوب : 68.38", words: [] });
  equal(cleanAr.arabicRatio, 1);
  ok(cleanAr.noiseScore <= NOISE_THRESHOLD, "clean Arabic line must be clean");
  const cleanEn = assessOcrLineQuality({ text: "Zahra Aman", words: [] });
  equal(cleanEn.latinRatio, 1);
});

// ─── postProcessOcr on the real SuperPay receipt ──────────────────────────

test("postProcessOcr repairs the real SuperPay OCR without losing text", () => {
  const before = docFrom(SUPERYPAY_RECEIPT_OCR);
  const { doc, report } = postProcessOcr(before);

  const texts = doc.lines.map((l) => l.text);
  ok(report.linesChanged > 0, "repair must change lines");
  includes(texts.join("\n"), "SuperPay 60", "merchant line keeps a clean span");
  includes(texts.join("\n"), "له", "detached fragment is preserved, not deleted");
  includes(texts.join("\n"), "انرقم المرجقي : 2013438351", "account line kept");
  includes(texts.join("\n"), "68.38", "amount kept");
  ok(
    texts.some((t) => t === "المطلوب : 68.38 ;"),
    "leading fragment detached from the amount line"
  );
  ok(
    texts.some((t) => t === "العلي : 68.38"),
    "leading fragment detached from the total line"
  );

  // Text is never invented: the multiset of canonical characters (ignoring
  // whitespace and canonicalization differences — alef/yeh/ta-marbuta
  // variants, presentation forms) must be preserved exactly. Repair only
  // reorders/spaces/joins.
  const chars = (s: string) =>
    [...normalizeArabicText(s)].filter((c) => !/\s/.test(c)).sort().join("");
  equal(chars(doc.text), chars(before.text), "no character may be added or removed");
});

test("repair reports a change only when the line actually changed", () => {
  // A clean LTR line the repair layer must not touch produces zero change
  // events (regression: splitBoundaryTokens always returned a fresh array, so
  // a no-op "insert-boundary-spaces" event was recorded for every line).
  const { report } = postProcessOcr(
    docFrom("Payment: Bank transfer SA1234567890\nRiyadh KSA")
  );
  equal(report.changes.length, 0, "no spurious change events");
  equal(report.linesChanged, 0, "no line is marked changed");

  // A line the repair layer actually alters still reports exactly one change.
  const { report: r2 } = postProcessOcr(docFrom("SuperPay60"));
  equal(r2.linesChanged, 1, "glued token line is changed");
  ok(
    r2.changes.some((c) => c.kind === "insert-boundary-spaces"),
    "the boundary change is reported once"
  );
});

test("postProcessOcr flags garbage lines via per-line quality", () => {
  const { doc } = postProcessOcr(docFrom(SUPERYPAY_RECEIPT_OCR));
  const garbage = doc.lines.find(
    (l) => l.quality && l.quality.noiseScore > NOISE_THRESHOLD
  );
  ok(garbage, "at least one line must be flagged as garbage");
  const merchant = doc.lines.find((l) => l.text.includes("SuperPay 60"))!;
  ok(merchant.quality!.noiseScore <= NOISE_THRESHOLD, "merchant line must be clean");
  ok(merchant.quality!.latinRatio > 0.5, "merchant line is Latin-dominant");
});

test("postProcessOcr reconstructs visual-order RTL lines when boxes are available", () => {
  const doc: OcrDocument = {
    text: "",
    lines: [
      {
        text: "ريال 68.38 المطلوب",
        words: [word("ريال", 10), word("68.38", 40), word("المطلوب", 70)],
      },
    ],
  };
  const { doc: out } = postProcessOcr(doc);
  equal(out.lines[0].text, "المطلوب 68.38 ريال");
  ok(out.lines[0].repaired, "line must be marked repaired");
  equal(out.lines[0].originalText, "ريال 68.38 المطلوب");
});

// ─── Arabic invoices, contracts, mixed documents (generality) ─────────────

test("repair is generic across receipts, invoices and contracts", () => {
  const invoice = docFrom(
    [
      "شركة نور التقنية المحدودة",
      "فاتورة ضريبية رقم 11223",
      "المبلغ المستحق 450.75 ريال",
      "x التاريخ 2025-03-14",
      "المجموع 450.75",
    ].join("\n")
  );
  const contract = docFrom(
    [
      "اتفاقية خدمات",
      "رقم الاتفاقية CT-2025-881",
      "بين شركة الافق العالمية",
      "Total 14000",
      "التوقيع 2025-02-20",
    ].join("\n")
  );
  for (const d of [invoice, contract]) {
    const { doc: out } = postProcessOcr(d);
    const chars = (s: string) =>
      [...normalizeArabicText(s)].filter((c) => !/\s/.test(c)).sort().join("");
    equal(chars(out.text), chars(d.text), "no character lost");
    ok(out.lines.length >= d.lines.length, "repair never merges lines");
  }
  includes(postProcessOcr(invoice).doc.text, "المبلغ المستحق 450.75 ريال");
  includes(postProcessOcr(invoice).doc.text, "التاريخ 2025-03-14");
  includes(postProcessOcr(contract).doc.text, "رقم الاتفاقيه CT-2025-881");
});

test("bilingual receipts keep both scripts readable", () => {
  const d = docFrom("معلومات إضافية : Mobile Number");
  const { doc: out } = postProcessOcr(d);
  includes(out.text, "معلومات اضافيه");
  includes(out.text, "Mobile Number");
  const line = out.lines.find((l) => l.text.includes("معلومات"))!;
  ok(
    line.quality!.arabicRatio > 0 && line.quality!.latinRatio > 0,
    "mixed line reports both script ratios"
  );
});

test("confidence is never inflated by repair", () => {
  const r = repairLineWords([
    { text: "ا", confidence: 0.9 },
    { text: "ل", confidence: 0.7 },
    { text: "ر", confidence: 0.8 },
    { text: "ح", confidence: 0.9 },
    { text: "ي", confidence: 0.8 },
    { text: "م", confidence: 0.9 },
  ]);
  const joined = r.lines[0][0];
  equal(joined.text, "الرحيم");
  equal(joined.confidence, 0.7, "joined word takes the minimum confidence");
  const split = repairLineWords([{ text: "رقم2013", confidence: 0.6 }]);
  for (const t of split.lines[0]) equal(t.confidence, 0.6, "split words keep original confidence");
});
