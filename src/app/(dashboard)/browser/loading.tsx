// /src/app/(dashboard)/browser/loading.tsx
"use client";
import { Loader2 } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

export default function BrowserAgentLoading() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-64 items-center justify-center gap-3 text-muted-foreground" role="status">
      <Loader2 size={20} className="animate-spin" />
      <span>{t("browserAgent.loadingLabel")}</span>
    </div>
  );
}