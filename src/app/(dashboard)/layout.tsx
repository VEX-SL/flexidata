"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";

export default function DashboardGroupLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  
  // نتحقق مما إذا كنا داخل صفحة الشات الخاصة بالـ agent لتجنب إظهار الـ AppSidebar القديم هناك
  const isAgentChatPage = pathname.includes("/chat");

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {!isAgentChatPage && <AppSidebar />}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}