"use client";

/**
 * زر الميك للإملاء (Dictation) — دايماً موجود جنب زر المحادثة الصوتية/الإرسال:
 *
 * - الحقل فاضي → زر المحادثة الصوتية + الميك جنبه (زي ChatGPT بالظبط).
 * - فيه نص أو مرفق → زر الإرسال + الميك جنبه: تكمل كلام صوتي والنص المنطوق
 *   بيتلحق في نهاية الحقل (وضع الإملاء / Append).
 * - أثناء التسجيل: الزر بيبقى أحمر نابض بأيقونة إيقاف + زر ✕ للإلغاء.
 * - أثناء التحويل: spinner.
 * - التحويل بيحصل في الـ Backend (/api/stt → Speechmatics ar_en bilingual
 *   مع fallback لـ Groq Whisper — النص المختلط عربي/إنجليزي بالحرفين الصح).
 *
 * كل النصوص من نظام i18n بتاع المشروع (useTranslation) — مفاتيح
 * voiceChat.dictation.* في ar.json / en.json.
 */

import { useEffect, useRef } from "react";
import { Loader2, Mic, Square, X } from "lucide-react";
import { useDictation } from "@/lib/hooks/use-dictation";
import { useTranslation } from "@/lib/i18n";

interface DictationMicButtonProps {
  /** تعطيل الزر (مثلًا أثناء رفع ملف) */
  disabled?: boolean;
  /** النص الراجع من STT — الصفحة بتلحقه في حقل الإدخال (شوف INTEGRATION.md) */
  onAppend: (text: string) => void;
  /** سطر حالة تحت الكومبوزر (نص الحالة | null = اخفِ السطر) */
  onStatus?: (text: string | null) => void;
  /** true أثناء التسجيل أو التحويل — عشان الزر يفضل ظاهر حتى لو مسحت النص وهو بيسجل */
  onBusyChange?: (busy: boolean) => void;
}

export function DictationMicButton({
  disabled = false,
  onAppend,
  onStatus,
  onBusyChange,
}: DictationMicButtonProps) {
  const { t } = useTranslation();

  const { status, error, start, stopAndTranscribe, cancel } = useDictation(onAppend);

  // تبليغ الصفحة بالحالة — refs عشان الكولباكات ما تعيدش تشغيل الـ effect
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;

  useEffect(() => {
    const busy = status === "recording" || status === "processing";
    onBusyChangeRef.current?.(busy);
    if (status === "recording") onStatusRef.current?.(t("voiceChat.dictation.recording"));
    else if (status === "processing") onStatusRef.current?.(t("voiceChat.dictation.processing"));
    else if (status === "error" && error) onStatusRef.current?.(error);
    else onStatusRef.current?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, error, t]);

  const recording = status === "recording";
  const processing = status === "processing";

  return (
    <span className="flex items-center gap-1 shrink-0">
      {recording && (
        <button
          type="button"
          onClick={() => void cancel()}
          title={t("voiceChat.dictation.cancel")}
          aria-label={t("voiceChat.dictation.cancel")}
          className="p-2 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        >
          <X size={16} />
        </button>
      )}
      <button
        type="button"
        onClick={() => (recording ? void stopAndTranscribe() : void start())}
        disabled={disabled || processing}
        title={recording ? t("voiceChat.dictation.stop") : t("voiceChat.dictation.start")}
        aria-pressed={recording}
        aria-label={recording ? t("voiceChat.dictation.stop") : t("voiceChat.dictation.start")}
        className={
          recording
            ? "p-2 rounded-xl bg-red-500 text-white hover:bg-red-600 shadow-sm transition-all animate-pulse"
            : "p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
        }
      >
        {processing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : recording ? (
          <Square size={14} fill="currentColor" />
        ) : (
          <Mic size={16} />
        )}
      </button>
    </span>
  );
}
