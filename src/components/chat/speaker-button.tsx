"use client";

/**
 * زر السماعة جنب رد الـ AI — يقرأ الرد صوتيًا عبر /api/tts:
 *
 * - التنظيف (Markdown) بيحصل في السيرفر؛ مرّر للزر النص القابل للعرض
 *   (getRenderableContent(msg.content) في صفحتك — بيشيل ماركرات
 *   [FILE_EDIT] / [QUICK_RESPONSE] / الصور قبل ما النص يوصل للـ TTS).
 * - المقاطع العربية بتتقرأ بصوت عربي والإنجليزية بصوت إنجليزي بالترتيب
 *   (التوزيع بيحصل تلقائيًا في الـ route).
 * - الحالات: idle → loading (spinner) → playing (اضغط تاني يوقف فورًا)
 *   → error (الزر بيبقى أحمر والتفاصيل في الـ tooltip والكونسول).
 * - لو الرسالة اتشالت من الشاشة والصوت شغال، بيقف لوحده (cleanup).
 *
 * كل النصوص من نظام i18n بتاع المشروع (useTranslation) — مفاتيح
 * voiceChat.speaker.* و voiceChat.errors.* في ar.json / en.json.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import {
  voiceApiErrorMessage,
  warnVoiceApiError,
  type VoiceApiError,
} from "@/lib/voice/voice-errors";

interface SpeakerButtonProps {
  /** نص الرد — يُفضّل getRenderableContent(msg.content) */
  text: string;
  disabled?: boolean;
  /** استبدال نص الـ tooltip المترجم (اختياري — الافتراضي من i18n) */
  title?: string;
  className?: string;
}

type SpeakerStatus = "idle" | "loading" | "playing" | "error";

export function SpeakerButton({
  text,
  disabled = false,
  title,
  className = "",
}: SpeakerButtonProps) {
  const { t } = useTranslation();
  const playTitle = title ?? t("voiceChat.speaker.play");

  const [status, setStatus] = useState<SpeakerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const queueRef = useRef<HTMLAudioElement[]>([]);
  const indexRef = useRef(0);

  const stopPlayback = useCallback(() => {
    queueRef.current.forEach((a) => {
      a.pause();
      a.src = ""; // تحرير الذاكرة
    });
    queueRef.current = [];
    indexRef.current = 0;
  }, []);

  // إيقاف الصوت لو الكومبوننت اتشال (الرسالة اتحذفت / الصفحة اتغيرت)
  useEffect(() => stopPlayback, [stopPlayback]);

  function playNext() {
    const queue = queueRef.current;
    const i = indexRef.current;
    if (i >= queue.length) {
      stopPlayback();
      setStatus("idle");
      return;
    }
    const audio = queue[i];
    audio.onended = () => {
      indexRef.current = i + 1;
      playNext();
    };
    audio.onerror = () => {
      stopPlayback();
      setError(t("voiceChat.speaker.playFailed"));
      setStatus("error");
    };
    audio.play().catch(() => {
      stopPlayback();
      setError(t("voiceChat.speaker.autoplayBlocked"));
      setStatus("error");
    });
  }

  async function play() {
    setError(null);
    setStatus("loading");
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        mime?: string;
        parts?: { audio: string }[];
      } & VoiceApiError;
      if (!res.ok) {
        // التفاصيل التقنية في الكونسول — والرسالة المترجمة للمستخدم
        warnVoiceApiError("tts", data);
        throw new Error(voiceApiErrorMessage(data, t));
      }

      const mime = data.mime ?? "audio/wav";
      const audios = (data.parts ?? []).map(
        (p) => new Audio(`data:${mime};base64,${p.audio}`),
      );
      if (audios.length === 0) throw new Error(t("voiceChat.speaker.noAudio"));

      queueRef.current = audios;
      indexRef.current = 0;
      setStatus("playing");
      playNext();
    } catch (e) {
      const msg =
        e instanceof Error && e.message
          ? e.message
          : t("voiceChat.speaker.requestFailed");
      // السبب الحقيقي بيتطبع هنا + في تيرمينال السيرفر ([tts] ...)
      console.warn("[tts] فشل التحويل:", msg);
      setError(msg);
      setStatus("error");
    }
  }

  function handleClick() {
    if (status === "playing" || status === "loading") {
      stopPlayback();
      setStatus("idle");
    } else {
      void play();
    }
  }

  const busy = status === "loading";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || busy}
      title={status === "error" && error ? `${playTitle} — ${error}` : playTitle}
      aria-label={playTitle}
      className={`p-1.5 rounded-md border border-border bg-card/80 backdrop-blur shadow-xs transition-colors disabled:opacity-50 ${
        status === "error"
          ? "text-red-500"
          : status === "playing"
            ? "text-primary"
            : "text-muted-foreground hover:text-foreground"
      } ${className}`}
    >
      {busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : status === "playing" ? (
        <Square size={12} fill="currentColor" />
      ) : (
        <Volume2 size={13} />
      )}
    </button>
  );
}
