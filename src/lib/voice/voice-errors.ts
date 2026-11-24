/**
 * تحويل أخطاء الـ API الصوتية لنصوص مترجمة:
 * الـ routes بترجع `code` مع الخطأ (rate_limit / missing_key / ...) —
 * الـ client بيترجم الكود بمفاتيح voiceChat.errors.*، ولو مفيش كود معروف
 * بيعرض نص السيرفر الأصلي (بيبقى فيه التفاصيل التقنية).
 */

/** شكل رد الخطأ من /api/stt و /api/tts */
export interface VoiceApiError {
  code?: string;
  error?: string;
  /** تفاصيل تقنية إضافية من المزوّد (للعرض في الكونسول فقط) */
  upstream?: string;
}

/** الكود → مفتاح الترجمة في voiceChat.errors */
const CODE_TO_KEY: Record<string, string> = {
  rate_limit: "voiceChat.errors.rateLimit",
  missing_key: "voiceChat.errors.missingKey",
  file_too_large: "voiceChat.errors.fileTooLarge",
  not_understood: "voiceChat.errors.notUnderstood",
  terms_not_accepted: "voiceChat.errors.termsNotAccepted",
  empty_after_sanitize: "voiceChat.errors.nothingToSpeak",
};

/** شكل دالة الترجمة t() — مطابق لاستخدام useTranslation في المشروع */
export type VoiceTranslate = (key: string) => string;

/**
 * يترجم رد الخطأ لنص مناسب للعرض:
 * 1) لو الكود معروف والترجمة موجودة → النص المترجم.
 * 2) غير كده → نص السيرفر الأصلي (فيه التفاصيل)، وإن مش موجود → نص عام.
 */
export function voiceApiErrorMessage(data: VoiceApiError, t: VoiceTranslate): string {
  const key = data.code ? CODE_TO_KEY[data.code] : undefined;
  if (key) {
    const msg = t(key);
    // بعض أنظمة i18n بترجع المفتاح نفسه لو مش موجود — وقتها نرجع لنص السيرفر
    if (msg && msg !== key) return msg;
  }
  return data.error ?? t("voiceChat.errors.upstreamFailed");
}

/** تسجيل تفاصيل الخطأ التقنية في الكونسول (برة النص اللي بيتعرض للمستخدم) */
export function warnVoiceApiError(scope: string, data: VoiceApiError): void {
  const details = [data.code, data.error, data.upstream].filter(Boolean).join(" | ");
  console.warn(`[${scope}] ${details || "خطأ غير معروف"}`);
}
