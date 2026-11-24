/**
 * تنظيف نص Markdown وتحويله إلى نص "منطوق" طبيعي قبل إرساله لمحرك TTS،
 * ثم تقطيعه إلى مقاطع حسب اللغة (عربي/إنجليزي) والحجم الآمن لحدود الفري تير.
 *
 * يعمل على السيرفر فقط — بدون أي dependencies خارجية.
 */

import type { SpeechChunk, SpeechLang } from "./types";

// حروف عربية (مصرية/فصحى/إمتدادات) + الأرقام العربية الهندية
const ARABIC_CHARS = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_CHARS = /[A-Za-z]/;

/** نسبة الحروف العربية من مجموع الحروف العربية + اللاتينية (0 → 1) */
export function arabicRatio(text: string): number {
  const ar = (text.match(new RegExp(ARABIC_CHARS.source, "g")) ?? []).length;
  const en = (text.match(new RegExp(LATIN_CHARS.source, "g")) ?? []).length;
  if (ar + en === 0) return 0;
  return ar / (ar + en);
}

/**
 * تحديد لغة المقطع لاختيار الصوت المناسب.
 * مائل للعربي عمدًا: أي مقطع فيه 25%+ حروف عربية يروح لصوت عربي،
 * لأن الصوت العربي بيتعامل مع كلمات إنجليزية مدمجة أفضل من العكس.
 */
export function isArabicDominant(text: string): boolean {
  return arabicRatio(text) >= 0.25;
}

function langOf(text: string): SpeechLang {
  return isArabicDominant(text) ? "ar" : "en";
}

const CODE_PLACEHOLDER = "\u0000CODE\u0000";
const LINK_PLACEHOLDER = "\u0000LINK\u0000";

const CODE_NOTICE_AR = "فيه مقطع كود برمجي في الرد.";
const CODE_NOTICE_EN = "There is a code snippet in this reply.";
const LINK_NOTICE_AR = "لينك مرفق في الرد.";
const LINK_NOTICE_EN = "There is a link attached in this reply.";

/**
 * تحويل Markdown إلى نص منطوق:
 * - الأكواد والروابط تتحول لجُمل منطوقة بدل رموز متنكرة.
 * - رموز التنسيق (#, **, -, |...) تُشال مع الحفاظ على علامات الترقيم
 *   (النقطة والفاصلة وعلامة الاستفهام) لأنها بتتحكم في الوقفات والنبرة.
 */
export function sanitizeForSpeech(raw: string): string {
  const original = raw ?? "";

  // لغة الرد ككل — بنحسبها بعد شيل الأكواد عشان كود إنجليزي طويل ما يأثرش
  const withoutCode = original.replace(/```[\s\S]*?(?:```|$)/g, " ");
  const replyIsArabic = arabicRatio(withoutCode) >= 0.25;

  let text = original;

  // 1) أكواد Fenced ```...``` → إشعار منطوق (نتعامل مع النص غير المقفول كمان)
  text = text.replace(/```[\s\S]*?(?:```|$)/g, `\n${CODE_PLACEHOLDER}\n`);

  // 2) كود سطري `x` → نطق محتواه فقط
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // 3) صور ![alt](url) → شيل
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");

  // 4) روابط [text](url) → النص بس
  text = text.replace(/\[([^\]]+)\]\([^)\s]*[^)]*\)/g, "$1");

  // 5) روابط خام http(s)://... → إشعار منطوق
  text = text.replace(/\bhttps?:\/\/\S+/g, ` ${LINK_PLACEHOLDER} `);

  // 6) وسوم HTML
  text = text.replace(/<[^>\n]+>/g, " ");

  // 7) HTML entities شائعة
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');

  // 8) عناوين # ## ###
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");

  // 9) اقتباسات >
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");

  // 10) خطوط فاصلة --- *** ___
  text = text.replace(/^[ \t]{0,3}([-*_][ \t]*){3,}$/gm, " ");

  // 11) جداول: صف الفواصل |---|---| ثم الـ pipes نفسها
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}[-:| \t]*$/gm, " ");
  text = text.replace(/\|/g, " ");

  // 12) رموز القوائم النقطية
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");

  // 13) القوائم المرقمة: "1)" → "1." والباقي يتسيب (الرقم يتنطق طبيعي)
  text = text.replace(/^[ \t]*(\d+)\)[ \t]+/gm, "$1. ");

  // 14) checkboxes وأحجام الفواصل
  text = text.replace(/\[[ xX]\]/g, " ");

  // 15) إحالات [^1] / [1]
  text = text.replace(/\[\^?\d+\]/g, " ");

  // 16) bold / italic / strikethrough
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/___([^_]+)___/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1$2");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // 17) إيموجي ورموز زخرفية وأسهم (بتتنطق بشكل وحش أو بتتلخبط)
  text = text.replace(
    /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu,
    " ",
  );

  // 18) العبارات المنطوقة بدل الأكواد/الروابط — بلغة الرد
  text = text.replace(
    new RegExp(CODE_PLACEHOLDER, "g"),
    replyIsArabic ? CODE_NOTICE_AR : CODE_NOTICE_EN,
  );
  text = text.replace(
    new RegExp(LINK_PLACEHOLDER, "g"),
    replyIsArabic ? LINK_NOTICE_AR : LINK_NOTICE_EN,
  );

  // 19) تنظيف المسافات والأسطر (مع الحفاظ على الترقيم اللي بيمسك الوقفة)
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+([.,!؟?;:…])/g, "$1");
  text = text.replace(/([.!؟?…]){2,}/g, "$1"); // !!! → !
  text = text.trim();

  return text;
}

/** الحد الافتراضي لحجم المقطع — آمن تحت حدود TPM/TPD لفري تير Groq TTS */
const DEFAULT_MAX_CHUNK = 800;

const SEPARATORS = ["،", ",", "؛", ";", " "];

/**
 * تقطيع النص المنظف لمقاطع:
 * 1) يقسم على الجمل (نقطة / علامة استفهام / سطر جديد).
 * 2) الجملة الطويلة تتقسم على الفواصل ثم مسافات.
 * 3) القطع المتتالية بنفس اللغة تتجمع في مقطع واحد — عشان عدد الطلبات يقل.
 *
 * النتيجة: كل مقطع له لغة واحدة غالبة → بنبعت العربي لصوت عربي
 * والإنجليزي لصوت إنجليزي، والرد يتنطق بالترتيب.
 */
export function chunkForSpeech(text: string, maxLen = DEFAULT_MAX_CHUNK): SpeechChunk[] {
  const sentences = text
    .split(/(?<=[.!؟?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // تقسيم الجمل الأطول من الحد
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxLen) {
      pieces.push(sentence);
      continue;
    }
    let rest = sentence;
    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen);
      let cut = -1;
      // أقرب فاصلة قبل منتصف النافذة تقريبًا
      for (const sep of ["،", ",", "؛", ";"]) {
        const idx = window.lastIndexOf(sep);
        if (idx > maxLen * 0.4) cut = Math.max(cut, idx + 1);
      }
      if (cut <= 0) {
        for (const sep of SEPARATORS) {
          const idx = window.lastIndexOf(sep);
          if (idx > maxLen * 0.4) {
            cut = Math.max(cut, idx + 1);
            break;
          }
        }
      }
      if (cut <= 0) cut = maxLen;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }

  // تجميع القطع المتتالية بنفس اللغة
  const chunks: SpeechChunk[] = [];
  for (const piece of pieces) {
    if (!piece) continue;
    const lang = langOf(piece);
    const last = chunks[chunks.length - 1];
    if (last && last.lang === lang && last.text.length + piece.length + 1 <= maxLen) {
      last.text += " " + piece;
    } else {
      chunks.push({ text: piece, lang });
    }
  }

  return chunks;
}
