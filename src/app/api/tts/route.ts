/**
 * POST /api/tts
 * يستقبل { text } (نص الرد الخام فيه Markdown) ويرجّع أجزاء صوتية base64 بالترتيب.
 *
 * تدفق المعالجة:
 * 1) sanitizeForSpeech: تنظيف Markdown لنص منطوق (أكواد/روابط → جمل منطوقة).
 * 2) chunkForSpeech: تقطيع لجمل وتجميعها حسب اللغة (عربي/لاتيني) وحجم آمن.
 * 3) كل مقطع عربي → صوت عربي (canopylabs/orpheus-arabic-saudi)،
 *    وكل مقطع إنجليزي → صوت إنجليزي (canopylabs/orpheus-v1-english).
 *    يعني "yo bro ازيك" هتتنطق "yo bro" بصوت إنجليزي + "ازيك" بصوت عربي.
 * 4) الطلبات متسلسلة مش متوازية — احترامًا لحدود الفري تير (10 طلبات/دقيقة).
 *
 * عايز كل حاجة بصوت عربي حتى لو فيها إنجليزي؟ ضع GROQ_TTS_SINGLE_VOICE=1
 */

import { NextResponse } from "next/server";
import { groqSpeech, GroqHttpError } from "@/lib/voice/groq";
import { chunkForSpeech, sanitizeForSpeech } from "@/lib/voice/sanitizer";
import type { TtsPart, TtsResponse } from "@/lib/voice/types";

export const runtime = "nodejs";
// الردود الطويلة بتتقسم لمقاطع متسلسلة — نسمح وقت كافي
export const maxDuration = 60;

export async function POST(req: Request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY مش متظبط في ملف .env" },
      { status: 500 },
    );
  }

  let body: { text?: string };
  try {
    body = (await req.json()) as { text?: string };
  } catch {
    return NextResponse.json({ error: "الـ body لازم يكون JSON فيه text" }, { status: 400 });
  }

  const raw = (body.text ?? "").trim();
  if (!raw) {
    return NextResponse.json({ error: "مفيش نص للتحويل" }, { status: 400 });
  }

  const speakable = sanitizeForSpeech(raw);
  if (!speakable) {
    return NextResponse.json(
      { error: "النص بقى فاضي بعد التنظيف (مثلًا كان كود بس)" },
      { status: 422 },
    );
  }

  const singleVoice = process.env.GROQ_TTS_SINGLE_VOICE === "1";
  const arModel = process.env.GROQ_TTS_ARABIC_MODEL ?? "canopylabs/orpheus-arabic-saudi";
  const arVoice = process.env.GROQ_TTS_ARABIC_VOICE ?? "fahad";
  const enModel = process.env.GROQ_TTS_ENGLISH_MODEL ?? "canopylabs/orpheus-v1-english";
  const enVoice = process.env.GROQ_TTS_ENGLISH_VOICE ?? "austin";

  const chunks = chunkForSpeech(speakable);

  try {
    const parts: TtsPart[] = [];
    // متسلسلة عمدًا — الطلبات المتوازية ممكن تضرب حد 10 RPM في الفري تير
    for (const chunk of chunks) {
      const arabicVoice = singleVoice || chunk.lang === "ar";
      const buffer = await groqSpeech(chunk.text, apiKey, {
        model: arabicVoice ? arModel : enModel,
        voice: arabicVoice ? arVoice : enVoice,
      });
      parts.push({
        lang: arabicVoice ? "ar" : "en",
        audio: Buffer.from(buffer).toString("base64"),
      });
    }

    const response: TtsResponse = { mime: "audio/wav", parts };
    return NextResponse.json(response);
  } catch (err) {
    // التشخيص الكامل بيتطبع في تيرمينال الـ dev — والرسالة في الرد بتوصل للـ tooltip
    const status = err instanceof GroqHttpError ? err.status : undefined;
    const upstream = err instanceof GroqHttpError ? err.upstream : undefined;
    console.error(
      "[tts] فشل تحويل النص لصوت:",
      status ? `Groq HTTP ${status}` : "",
      upstream ?? err,
    );

    const message = err instanceof Error ? err.message : "فشل تحويل النص لصوت";

    if (err instanceof GroqHttpError && err.status === 429) {
      return NextResponse.json({ error: message }, { status: 429 });
    }

    // ⚠️ السبب الأشهر لفشل TTS مع مفتاح شغال: موديلات Orpheus محتاجة قبول
    // شروطها مرة واحدة من console.groq.com قبل أول استخدام — لحد ما تتقبل،
    // الطلبات بتفشل (عادة 403/404) حتى لو نفس المفتاح شغال مع الـ STT عادي.
    const needsTerms =
      err instanceof GroqHttpError &&
      (err.status === 403 ||
        err.status === 404 ||
        /terms|accept|not available|not supported|unavailable|provision/i.test(err.upstream));
    if (needsTerms) {
      return NextResponse.json(
        {
          error:
            "موديلات Orpheus محتاجة قبول الشروط مرة واحدة: افتح console.groq.com → Models → canopylabs/orpheus-arabic-saudi و canopylabs/orpheus-v1-english → Accept terms، وبعدها جرب تاني. (Groq HTTP " +
            (err.status ?? "?") +
            `: ${err.upstream})`,
          upstreamStatus: err.status,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { error: message, ...(upstream ? { upstream } : {}) },
      { status: 502 },
    );
  }
}
