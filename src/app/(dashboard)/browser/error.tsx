// /src/app/(dashboard)/browser/error.tsx
"use client";

import { useTranslation } from "@/lib/i18n";

export default function BrowserAgentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-lg font-semibold">{t("browserAgent.errorTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("browserAgent.errorDescription")}</p>
      <button onClick={reset} className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">{t("browserAgent.retry")}</button>
    </div>
  );
}