"use client";

import { useState } from "react";
import { X, AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

interface DeleteAccountDialogProps {
  loading?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const CONFIRM_WORD = "DELETE";

/**
 * Mount this component only while the dialog is open — the typed confirmation
 * resets naturally on every new mount.
 */
export function DeleteAccountDialog({
  loading = false,
  error,
  onConfirm,
  onCancel,
}: DeleteAccountDialogProps) {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState("");

  const canDelete = confirmText === CONFIRM_WORD && !loading;

  function close() {
    if (loading) return;
    onCancel();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={close} />

      {/* Dialog */}
      <div className="relative w-full max-w-md bg-card border border-destructive/40 rounded-2xl shadow-2xl p-6">
        <div className="flex items-start gap-4">
          <div className="shrink-0 mt-1">
            <AlertTriangle size={24} className="text-destructive" />
          </div>

          <div className="flex-1 space-y-2">
            <h3 className="text-lg font-semibold text-foreground">
              {t("settings.deleteAccountConfirmTitle")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("settings.deleteAccountConfirmMessage")}
            </p>
          </div>

          <button
            onClick={close}
            disabled={loading}
            className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
            aria-label={t("common.cancel")}
          >
            <X size={20} />
          </button>
        </div>

        <div className="mt-5 space-y-2">
          <label
            htmlFor="delete-account-confirm"
            className="block text-xs font-medium text-muted-foreground"
          >
            {t("settings.deleteAccountConfirmLabel")}
          </label>
          <input
            id="delete-account-confirm"
            type="text"
            dir="ltr"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={loading}
            placeholder={CONFIRM_WORD}
            className="w-full px-3 py-2 rounded-xl border border-border bg-background text-foreground text-sm font-mono tracking-[0.2em] placeholder:tracking-normal placeholder:font-sans placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-destructive/40 focus:border-destructive/50 disabled:opacity-60"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border/60">
          <button
            onClick={close}
            disabled={loading}
            className="px-4 py-2 rounded-xl text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={onConfirm}
            disabled={!canDelete}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white bg-destructive hover:bg-destructive/90 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-destructive transition-all"
          >
            {loading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Trash2 size={15} />
            )}
            {loading ? t("settings.deletingAccount") : t("settings.deleteAccount")}
          </button>
        </div>
      </div>
    </div>
  );
}
