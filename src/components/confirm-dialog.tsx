"use client";

import { useState, useEffect } from "react";
import { X, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string | React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: "danger" | "warning" | "success" | "info";
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  type = "danger",
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(isOpen);
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  const icon = {
    danger: <AlertTriangle size={24} className="text-destructive" />,
    warning: <AlertTriangle size={24} className="text-yellow-500" />,
    success: <CheckCircle2 size={24} className="text-green-500" />,
    info: <Info size={24} className="text-blue-500" />,
  }[type];

  const confirmButtonClass = {
    danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-destructive/20",
    warning: "bg-yellow-500 text-yellow-950 hover:bg-yellow-500/90 shadow-yellow-500/20",
    success: "bg-green-600 text-white hover:bg-green-600/90 shadow-green-600/20",
    info: "bg-blue-600 text-white hover:bg-blue-600/90 shadow-blue-600/20",
  }[type];

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${
        isVisible ? "opacity-100" : "opacity-0 pointer-events-none"
      } transition-opacity duration-200`}
    >
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onCancel} />

      <div
        className={`relative w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl p-6 transform transition-all duration-200 ${
          isVisible ? "scale-100 translate-y-0" : "scale-95 translate-y-4"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <div className="shrink-0 mt-1">{icon}</div>
          <div className="flex-1 space-y-2">
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            <div className="text-sm text-muted-foreground leading-relaxed">{message}</div>
          </div>
          <button
            onClick={onCancel}
            className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border/60">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-medium text-foreground hover:bg-accent transition-colors border border-border/60"
          >
            {cancelText || t("common.cancel")}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-sm ${confirmButtonClass}`}
          >
            {confirmText || t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}