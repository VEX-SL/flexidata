/**
 * أنواع مشتركة بين وحدات الصوت (STT / TTS)
 */

/** لغة المقطع كما يحددها تحليل الحروف (عربي أو لاتيني) */
export type SpeechLang = "ar" | "en";

/** مقطع نصي جاهز للنطق، مع لغته */
export interface SpeechChunk {
  text: string;
  lang: SpeechLang;
}

/** جزء صوتي راجع من السيرفر (base64) */
export interface TtsPart {
  lang: SpeechLang;
  /** محتوى ملف الصوت بصيغة base64 */
  audio: string;
}

/** استجابة /api/tts */
export interface TtsResponse {
  mime: string;
  parts: TtsPart[];
}

/** استجابة /api/stt */
export interface SttResponse {
  text: string;
  /** لغة المزوّد الأساسية — النص نفسه ممكن يكون مخلوط عربي/إنجليزي */
  language: string | null;
  /** المزوّد اللي فعلاً نفّذ التحويل: "speechmatics" أو "groq" */
  provider?: string;
  /** ملاحظة غير فادحة (مثلًا fallback من Speechmatics لـ Groq) للعرض في سطر الحالة */
  notice?: string;
}
