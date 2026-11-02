"use client";

import { X, LogOut, Settings, MessageSquare } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

interface UserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettings: () => void;
  onLogout: () => void;
}

export function UserModal({
  isOpen,
  onClose,
  onSettings,
  onLogout,
}: UserModalProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center ${
        isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
      } transition-opacity duration-200`}
    >
      <div className={`bg-card border border-border rounded-2xl shadow-2xl p-6 w-full max-w-sm transform transition-all ${
        isOpen ? "scale-100" : "scale-95"
      }`}>
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center">
            <MessageSquare size={28} className="text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-foreground">User Name</h2>
            <p className="text-sm text-muted-foreground">user@email.com</p>
          </div>
        </div>

        <div className="space-y-2">
          <button
            onClick={() => {
              onSettings();
              onClose();
            }}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-left hover:bg-accent hover:text-foreground transition-colors"
          >
            <Settings size={18} />
            {t("settings.title")}
          </button>

          <button
            onClick={onLogout}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-left hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <LogOut size={18} />
            {t("nav.logout")}
          </button>
        </div>

        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-lg hover:bg-accent transition-colors"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}