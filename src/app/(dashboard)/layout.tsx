"use client";

import { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";

export default function DashboardGroupLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar />
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}