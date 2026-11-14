"use client";

import { useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

// ✅ Full-screen image viewer (الشاشة المنبثقة): opens when clicking an
// attached image — both the composer preview thumbnail and the image inside
// a sent user message. Shows the image's FILE NAME as a caption. Closes via
// the ✕ button, clicking the backdrop, or the Escape key. `common.close`
// keeps the label localized (AR/EN/FR/ZH).
export function ImageLightbox({
  url,
  name,
  alt,
  onClose,
}: {
  url: string | null;
  name?: string;
  alt?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!url) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [url, handleKeyDown]);

  if (!url) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm animate-fade-in p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={name || t("chat.viewImage")}
    >
      <button
        onClick={onClose}
        aria-label={t("common.close")}
        title={t("common.close")}
        className="absolute top-4 end-4 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
      >
        <X size={20} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt || name || "Image"}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[92vw] max-h-[80vh] object-contain rounded-2xl shadow-2xl select-none"
        draggable={false}
      />
      {/* ✅ The image's file name */}
      {name && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="max-w-[80vw] px-3.5 py-1.5 rounded-full bg-white/10 text-white/90 text-xs font-medium truncate"
        >
          {name}
        </div>
      )}
    </div>
  );
}

export default ImageLightbox;
