/**
 * POST /api/stt
 * يستقبل ملف صوتي (FormData field: "file") ويرجّع النص + المزوّد المستخدم.
 *
 * سلسلة المزودين (Provider Fallback):
 * 1) Speechmatics `ar_en` bilingual — عربي+إنجليزي في نفس التسجيل بالحرفين
 *    الصح: "اهلا وسهلا how can you help me" → "اهلا وسهلا How can you help me"
 *    (ده Whisper بيفشل فيه وبرجّع "Ahlan wa sahlan" بحروف لاتيني).
 *    محتاج SPEECHMATICS_API_KEY (كريدت مجاني $100 بدون كارت).
 * 2) Groq Whisper large-v3 — اكتشاف لغة تلقائي، fallback مجاني دائم.
 *
 * ⚠️ Speechmatics مش بيقبل webm (الصيغة اللي كروم بيسجلها افتراضيًا) —
 * use-dictation بيسجل audio/mp4 أو ogg؛ لو الملف webm بيتجاهل Speechmatics
 * وبيروح لـ Groq مباشرة.
 */

import { NextResponse } from "next/server";
import { groqTranscribe } from "@/lib/voice/groq";
import { speechmaticsTranscribe, SpeechmaticsHttpError } from "@/lib/voice/speechmatics";
import type { SttResponse } from "@/lib/voice/types";

export const runtime = "nodejs";
// تسجيلات المحادثة قصيرة عادة — سقف 60 ثانية كافي ومبيمنعش تعليق الطلب
export const maxDuration = 60;

// Groq الفري تير: أقصى حجم ملف 25MB — منسمح بـ 24MB هامش أمان
const MAX_BYTES = 24 * 1024 * 1024;

/** Speechmatics بيقبل mp4/m4a/aac/ogg/flac/wav/mp3 بس — webm لا */
const SPEECHMATICS_OK_MIME = /\.(mp4|m4a|aac|ogg|opus|flac|wav|mp3|mpeg)$/;

export async function POST(req: Request) {
  const smKey = process.env.SPEECHMATICS_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!smKey && !groqKey) {
    return NextResponse.json(
      { error: "مفيش مفتاح STT: ضيف GROQ_API_KEY (إلزامي) أو SPEECHMATICS_API_KEY في .env" },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "الطلب لازم يكون FormData" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "مفيش ملف صوت في الطلب (الحقل: file)" },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "الملف فاضي" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "الملف أكبر من الحد المسموح (25MB)" },
      { status: 413 },
    );
  }

  const mime = file.type || "audio/webm";
  const ext = mime.includes("mp4")
    ? "m4a"
    : mime.includes("ogg")
      ? "ogg"
      : mime.includes("wav")
        ? "wav"
        : mime.includes("mpeg")
          ? "mp3"
          : "webm";
  const filename = `dictation.${ext}`;

  // 1) Speechmatics ar_en — أدق عربي/إنجليزي مختلط (لو المفتاح موجود والصيغة مدعومة)
  const smSupported = SPEECHMATICS_OK_MIME.test(filename);
  let smError: string | null = null;
  if (smKey && smSupported) {
    try {
      const result = await speechmaticsTranscribe(file, filename, smKey);
      if (result.text) {
        const body: SttResponse = {
          text: result.text,
          language: result.language,
          provider: "speechmatics",
        };
        return NextResponse.json(body);
      }
      smError = "رجع نص فاضي";
    } catch (err) {
      smError = err instanceof SpeechmaticsHttpError
        ? err.message
        : err instanceof Error
          ? err.message
          : "خطأ غير معروف";
      console.error("[stt] Speechmatics فشل → fallback لـ Groq:", smError);
    }
  }

  // 2) Groq Whisper — fallback (مجاني دائم، لكن العربي المختلط ممكن يطلع Latin)
  if (groqKey) {
    try {
      const result = await groqTranscribe(file, filename, groqKey);
      if (!result.text) {
        return NextResponse.json(
          { error: "ماقدرناش نفهم الصوت — جرب تسجل أقرب وأوضح." },
          { status: 422 },
        );
      }
      const notice = !smKey
        ? "شغال بـ Groq Whisper — للخلط العربي/الإنجليزي الأدق أضف SPEECHMATICS_API_KEY مجانًا (شوف INTEGRATION.md)."
        : smError
          ? `Speechmatics فشل (${smError}) — اتستخدم Groq Whisper بداله.`
          : undefined;
      const body: SttResponse = {
        text: result.text,
        language: result.language,
        provider: "groq",
        notice,
      };
      return NextResponse.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : "فشل تحويل الصوت";
      const status = message.includes("Rate limit") ? 429 : 502;
      return NextResponse.json(
        { error: message, ...(smError ? { speechmaticsError: smError } : {}) },
        { status },
      );
    }
  }

  // Speechmatics فقط (مفيش Groq) وفشل
  return NextResponse.json(
    { error: smError ?? "Speechmatics رجع نتيجة فاضية — جرب تاني." },
    { status: 502 },
  );
}
