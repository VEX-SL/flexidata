/**
 * Speechmatics STT — موديل ar_en bilingual: عربي + إنجليزي في نفس التسجيل
 * بالحرفين الصح (العربي بحروف عربية + الإنجليزي بحروف لاتينية) — ده اللي
 * Whisper بيفشل فيه ("اهلا وسهلا how can you help me" → "Ahlan wa sahlan...").
 *
 * الـ API: POST /v2/jobs/?wait=60&format=txt → 201 { id, status, txt }
 * لو status لسه "created" → GET /v2/jobs/{id}/transcript?wait=30&format=txt
 * مصدر: docs.speechmatics.com/speech-to-text/batch/synchronous
 *
 * ⚠️ الصيغ المدعومة: wav / mp3 / aac / ogg / m4a / mp4 / flac — **webm مش مدعوم**
 * (عشان كده use-dictation بيسجل بـ audio/mp4 أو ogg الأول، وwebm بيروح لـ Groq).
 *
 * الكريدت: $100 مجاني بدون كارت من console.speechmatics.com — الاستهلاك
 * بالساعة الصوتية (~$0.12/ساعة) يعني مئات الساعات للإملاء اليومي.
 */

const SM_BASE = process.env.SPEECHMATICS_BASE_URL ?? "https://eu1.asr.api.speechmatics.com";

/** خطأ HTTP من Speechmatics مع الكود الأصلي — عشان الـ route يبني رسالة واضحة */
export class SpeechmaticsHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SpeechmaticsHttpError";
    this.status = status;
  }
}

async function smError(res: Response): Promise<SpeechmaticsHttpError> {
  let detail = "";
  try {
    const body = (await res.json()) as { detail?: unknown; error?: unknown };
    detail =
      typeof body.detail === "string"
        ? body.detail
        : body.detail
          ? JSON.stringify(body.detail).slice(0, 300)
          : typeof body.error === "string"
            ? body.error
            : "";
  } catch {
    // الرد مش JSON
  }
  let friendly: string;
  if (res.status === 401 || res.status === 403) {
    friendly = "مفتاح SPEECHMATICS_API_KEY غلط أو منتهي.";
  } else if (res.status === 429) {
    friendly = "خلصت حد الطلبات في Speechmatics مؤقتًا — استنى دقيقة.";
  } else if (res.status === 402) {
    friendly = "خلص كريدت Speechmatics المجاني — استخدم Groq Whisper أو اعمل حساب جديد.";
  } else if (res.status === 400) {
    friendly = `Speechmatics رفض الملف (${detail || "صيغة مش مدعومة؟"})`;
  } else {
    friendly = `Speechmatics HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
  }
  return new SpeechmaticsHttpError(res.status, friendly);
}

/**
 * تحويل صوت → نص بموديل عربي/إنجليزي bilingual.
 * يرمي SpeechmaticsHttpError عند فشل — الـ route بيعمل fallback لـ Groq.
 */
export async function speechmaticsTranscribe(
  audio: Blob,
  filename: string,
  apiKey: string,
): Promise<{ text: string; language: string }> {
  const language = process.env.SPEECHMATICS_STT_LANGUAGE ?? "ar_en";
  const model = process.env.SPEECHMATICS_STT_MODEL ?? "enhanced";
  const auth = { Authorization: `Bearer ${apiKey}` };

  const config = JSON.stringify({
    type: "transcription",
    transcription_config: { language, model },
  });

  const form = new FormData();
  form.append("data_file", audio, filename);
  form.append("config", config);

  // طلب واحد بيتحجب لحد 60 ثانية — التسجيلات القصيرة بتخلص في ثواني
  const res = await fetch(`${SM_BASE}/v2/jobs/?wait=60&format=txt`, {
    method: "POST",
    headers: auth,
    body: form,
  });
  if (!res.ok) throw await smError(res);

  const data = (await res.json()) as {
    id?: string;
    status?: string;
    txt?: string;
    detail?: unknown;
  };

  if (data.status === "done" && typeof data.txt === "string") {
    return { text: data.txt.trim(), language };
  }
  if (data.status === "rejected") {
    throw new SpeechmaticsHttpError(
      422,
      `Speechmatics رفض الملف (${JSON.stringify(data.detail ?? {}).slice(0, 200)})`,
    );
  }

  // لسه بيتعالج → سؤال متزامن تاني عن الـ transcript
  if (data.id) {
    const t = await fetch(
      `${SM_BASE}/v2/jobs/${data.id}/transcript?wait=30&format=txt`,
      { headers: auth },
    );
    if (t.ok) {
      const text = (await t.text()).trim();
      if (text) return { text, language };
    }
  }
  throw new SpeechmaticsHttpError(504, "Speechmatics أخد وقت أطول من المتوقع — جرب تاني.");
}
