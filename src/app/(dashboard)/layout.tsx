"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";

export default function DashboardGroupLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // إذا كنا داخل صفحة الـ agents، نتخلى عن الشريط القديم ليعمل الشريط المخصص بسلاسة
  const isAgentPage = pathname.startsWith("/agents");

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {!isAgentPage && <AppSidebar />}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}