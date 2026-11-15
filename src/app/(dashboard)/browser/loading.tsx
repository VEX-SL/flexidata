// /src/app/(dashboard)/browser/loading.tsx
import { Loader2 } from "lucide-react";

export default function BrowserAgentLoading() {
  return (
    <div className="flex h-full min-h-64 items-center justify-center gap-3 text-muted-foreground" role="status">
      <Loader2 size={20} className="animate-spin" />
      <span>جارٍ تحميل إعدادات وكيل المتصفح…</span>
    </div>
  );
}