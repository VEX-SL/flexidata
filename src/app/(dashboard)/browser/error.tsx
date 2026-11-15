// /src/app/(dashboard)/browser/error.tsx
"use client";

export default function BrowserAgentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-lg font-semibold">تعذر فتح إعدادات Browser Agent</h2>
      <p className="text-sm text-muted-foreground">حدث خطأ أثناء تحميل الصفحة. يمكنك إعادة المحاولة دون فقد إعدادات الوكلاء.</p>
      <button onClick={reset} className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">إعادة المحاولة</button>
    </div>
  );
}