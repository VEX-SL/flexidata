"use client";

import { useState, useEffect } from "react";
import { X, AlertTriangle, CheckCircle2 } from "lucide-react";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: "danger" | "warning" | "success";
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  type = "danger",
}: ConfirmDialogProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(isOpen);
  }, [isOpen]);

  const icon = {
    danger: <AlertTriangle size={24} className="text-destructive" />,
    warning: <AlertTriangle size={24} className="text-yellow-500" />,
    success: <CheckCircle2 size={24} className="text-green-500" />,
  }[type];

  const confirmButtonClass = {
    danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    warning: "bg-yellow-500 text-yellow-900 hover:bg-yellow-500/90",
    success: "bg-green-500 text-green-900 hover:bg-green-500/90",
  }[type];

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${
        isVisible ? "opacity-100" : "opacity-0 pointer-events-none"
      } transition-opacity duration-200`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div
        className={`relative w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl p-6 transform transition-all duration-200 ${
          isVisible ? "scale-100 translate-y-0" : "scale-95 translate-y-4"
        }`}
      >
        <div className="flex items-start gap-4">
          {/* Icon */}
          <div className="shrink-0 mt-1">{icon}</div>

          {/* Content */}
          <div className="flex-1 space-y-2">
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {message}
            </p>
          </div>

          {/* Close button */}
          <button
            onClick={onCancel}
            className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border/60">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-medium text-foreground hover:bg-accent transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-xl text-sm font-medium text-white transition-all ${confirmButtonClass}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
