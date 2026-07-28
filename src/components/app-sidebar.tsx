"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useTranslation } from "@/lib/i18n";
import {
  LayoutDashboard,
  Bot,
  MessageSquare,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Zap,
} from "lucide-react";

const NAV_ITEMS = [
  { key: "dashboard", path: "/dashboard", icon: LayoutDashboard },
  { key: "agents", path: "/agents", icon: Bot },
  { key: "chat", path: "/chat", icon: MessageSquare },
  { key: "settings", path: "/settings", icon: Settings },
] as const;

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const supabase = createClient();

  function isActive(path: string) {
    if (path === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(path);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div
      className={`h-full flex flex-col border-r border-border bg-card transition-all duration-200 flex-shrink-0 ${
        collapsed ? "w-[60px]" : "w-[200px]"
      }`}
    >
      {/* Logo */}
      <div className="h-12 border-b border-border flex items-center px-3 gap-2">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary shrink-0">
          <Zap size={14} className="text-primary-foreground" />
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold text-foreground truncate">FlexiData</span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.path);
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => router.push(item.path)}
              className={`w-full flex items-center gap-2.5 rounded-xl text-sm font-medium transition-colors ${
                collapsed ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"
              } ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
              title={collapsed ? t(`nav.${item.key}`) : undefined}
            >
              <Icon size={18} className="shrink-0" />
              {!collapsed && <span className="truncate">{t(`nav.${item.key}`)}</span>}
            </button>
          );
        })}
      </nav>

      {/* Sign out */}
      <div className="p-2 border-t border-border">
        <button
          onClick={handleSignOut}
          className={`w-full flex items-center gap-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors ${
            collapsed ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"
          }`}
          title={collapsed ? t("nav.signOut") : undefined}
        >
          <LogOut size={18} className="shrink-0" />
          {!collapsed && <span className="truncate">{t("nav.signOut")}</span>}
        </button>
      </div>
    </div>
  );
}
