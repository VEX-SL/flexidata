/**
 * استدعاءات Groq (STT + TTS) — بدون أي SDK خارجي، fetch native فقط.
 * المفتاح بيقرأ من process.env وقت الطلب، وبيستخدم في السيرفر فقط.
 */

const GROQ_BASE = "https://api.groq.com/openai/v1";

/** خطأ HTTP من Groq مع الكود الأصلي — عشان الـ route يبني رسالة حلول */
export class GroqHttpError extends Error {
  status: number;
  /** رسالة Groq الأصلية كما وصلت (للتشخيص) */
  upstream: string;
  constructor(status: number, message: string, upstream: string) {
    super(message);
    this.name = "GroqHttpError";
    this.status = status;
    this.upstream = upstream;
  }
}

export interface SttResult {
  text: string;
  /** اللغة المهيمنة اللي رجعها الموديل (ممكن يكون النص نفسه مخلوط عربي/إنجليزي) */
  language: string | null;
}

/** تحويل صوت → نص (Whisper بيكتشف اللغة تلقائيًا لما ما نبعتهاش) */
export async function groqTranscribe(
  audio: Blob,
  filename: string,
  apiKey: string,
): Promise<SttResult> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", process.env.GROQ_STT_MODEL ?? "whisper-large-v3");
  // verbose_json بيرجع حقل language (اللغة المهيمنة) + segments
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw await groqError(res);

  const data = (await res.json()) as { text?: string; language?: string };
  return {
    text: (data.text ?? "").trim(),
    language: data.language ?? null,
  };
}

/** تحويل نص → صوت (يرجع raw audio bytes) */
export async function groqSpeech(
  text: string,
  apiKey: string,
  opts: { model: string; voice: string },
): Promise<ArrayBuffer> {
  const res = await fetch(`${GROQ_BASE}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      voice: opts.voice,
      input: text,
      response_format: "wav",
    }),
  });
  if (!res.ok) throw await groqError(res);
  return res.arrayBuffer();
}

/** رسالة خطأ واضحة بالعربي حسب كود الاستجابة — الرسالة الأصلية بتتحفظ في .upstream */
async function groqError(res: Response): Promise<GroqHttpError> {
  let msg = `Groq HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) msg = body.error.message;
  } catch {
    // الرد مش JSON — نسيب الرسالة الافتراضية
  }

  let friendly: string;
  if (res.status === 429) {
    friendly =
      "خلصت الحد المجاني مؤقتًا (Rate limit). استنى شوية أو جرب تاني بعد دقيقة.";
  } else if (res.status === 401 || res.status === 403) {
    friendly = "مفتاح GROQ_API_KEY غلط أو ناقص.";
  } else if (res.status === 413) {
    friendly = "الملف أو النص أكبر من الحد المسموح.";
  } else {
    friendly = msg;
  }
  return new GroqHttpError(res.status, friendly, msg);
}
