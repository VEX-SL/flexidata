"use client";

/**
 * useDictation — تسجيل صوتي من الميكروفون وتحويله لنص عبر /api/stt.
 *
 * وضع الإملاء (Append): النص الراجع بيتلحق بالنص المكتوب حاليًا
 * عبر joinForDictation (بمسافة واحدة، بدون مسافات مزدوجة) —
 * يعني تكتب نص، تضغط الميك، تكمل صوت، والنصين يبقوا في حقل واحد.
 *
 * كل التسجيل بيحصل بـ MediaRecorder (تسجيل صوت فقط — بدون Web Speech API)
 * والتحويل بيحصل في الـ Backend: Speechmatics ar_en bilingual (عربي+إنجليزي
 * بالحرفين الصح) مع fallback تلقائي لـ Groq Whisper — التفاصيل في /api/stt.
 *
 * كل النصوص من نظام i18n بتاع المشروع (useTranslation) — مفاتيح
 * voiceChat.dictation.* و voiceChat.errors.* في ar.json / en.json.
 */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  voiceApiErrorMessage,
  warnVoiceApiError,
  type VoiceApiError,
} from "@/lib/voice/voice-errors";

export type DictationStatus = "idle" | "recording" | "processing" | "error";

interface UseDictationReturn {
  status: DictationStatus;
  error: string | null;
  /** ابدأ التسجيل (يطلب إذن الميكروفون) */
  start: () => Promise<void>;
  /** وقف التسجيل وابعت الصوت للتحويل → النص بيرجع في onText */
  stopAndTranscribe: () => Promise<void>;
  /** وقف التسجيل واستبعد الصوت من غير تحويل */
  cancel: () => void;
}

/**
 * دمج النص المنطوق مع النص الموجود:
 * - مسافة واحدة بينهم (عربي/إنجليزي الاتنين محتاجينها).
 * - من غير مسافات مزدوجة أو أسطر فاضية.
 */
export function joinForDictation(current: string, addition: string): string {
  const right = addition.trim();
  if (!right) return current;
  const left = current.replace(/[ \t]+$/, "");
  if (!left) return right;
  return `${left} ${right}`;
}

/** اختيار أفضل صيغة تسجيل مدعومة في المتصفح.
 * الترتيب مهم: Speechmatics (المزوّد الأدق للعربي/الإنجليزي المختلط)
 * بيقبل mp4/ogg بس — **مش webm** — فبنحاول mp4 (كروم 113+/سفاري/إيدج)
 * وبعدين ogg (فايرفوكس)، وwebm آخر حل بنروح بيه لـ Groq Whisper مباشرة. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/webm;codecs=opus",
    "audio/webm",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

export function useDictation(onText: (text: string) => void): UseDictationReturn {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // نخزن آخر callback في ref — يسمح بتغييره بدون إعادة إنشاء التسجيل
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const cleanupTracks = useCallback(() => {
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(1000); // chunk كل ثانية — يضمن تسجيلات طويلة كاملة
      recorderRef.current = recorder;
      setStatus("recording");
    } catch {
      setError(t("voiceChat.dictation.micAccess"));
      setStatus("error");
      cleanupTracks();
    }
  }, [cleanupTracks, t]);

  const finish = useCallback(
    async (transcribe: boolean) => {
      const recorder = recorderRef.current;
      if (!recorder) return;

      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.stop();
      await stopped;

      const mimeType = recorder.mimeType || pickMimeType() || "audio/webm";
      recorder.stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;

      if (!transcribe) {
        chunksRef.current = [];
        setStatus("idle");
        return;
      }

      setStatus("processing");
      try {
        const blob = new Blob(chunksRef.current, { type: mimeType.split(";")[0] });
        chunksRef.current = [];
        if (blob.size < 800) {
          throw new Error(t("voiceChat.dictation.noAudio"));
        }
        const ext = mimeType.includes("mp4")
          ? "m4a"
          : mimeType.includes("ogg")
            ? "ogg"
            : "webm";

        const form = new FormData();
        form.append("file", blob, `dictation.${ext}`);
        const res = await fetch("/api/stt", { method: "POST", body: form });
        const data = (await res.json().catch(() => ({}))) as {
          text?: string;
          notice?: string;
          provider?: string;
        } & VoiceApiError;
        if (!res.ok) {
          // التفاصيل التقنية في الكونسول — والرسالة المترجمة للمستخدم
          warnVoiceApiError("stt", data);
          throw new Error(voiceApiErrorMessage(data, t));
        }

        const text = (data.text ?? "").trim();
        if (text) onTextRef.current(text);
        // ملاحظات غير فادحة (fallback/نصيحة المفتاح) — بتتطبع في الـ console
        if (data.notice) console.info(`[stt:${data.provider}] ${data.notice}`);
        setStatus("idle");
      } catch (e) {
        const msg =
          e instanceof Error && e.message
            ? e.message
            : t("voiceChat.dictation.transcribeFailed");
        console.warn("[stt] فشل التحويل:", msg);
        setError(msg);
        setStatus("error");
      }
    },
    [t],
  );

  const stopAndTranscribe = useCallback(() => finish(true), [finish]);
  const cancel = useCallback(() => finish(false), [finish]);

  return { status, error, start, stopAndTranscribe, cancel };
}
