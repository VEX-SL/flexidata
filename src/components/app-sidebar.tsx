"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
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
  ScanText,
} from "lucide-react";

const NAV_ITEMS = [
  { key: "dashboard", path: "/dashboard", icon: LayoutDashboard },
  { key: "documents", path: "/documents", icon: ScanText },
  { key: "agents", path: "/agents", icon: Bot },
  { key: "chat", path: "/chat", icon: MessageSquare },
  { key: "settings", path: "/settings", icon: Settings },
] as const;

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [isArabic, setIsArabic] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const supabase = createClient();

  useEffect(() => {
    const checkSettings = () => {
      // فحص اللغة واتجاه الصفحة
      const dir = document.documentElement.getAttribute("dir");
      const lang = document.documentElement.getAttribute("lang");
      setIsArabic(dir === "rtl" || lang === "ar");

      // فحص الثيم الداكن بأكثر من طريقة لضمان الدقة
      const isHtmlDark = document.documentElement.classList.contains("dark");
      const isBodyDark = document.body.classList.contains("dark");
      const dataTheme = document.documentElement.getAttribute("data-theme") === "dark";
      const localTheme = localStorage.getItem("theme") === "dark";
      
      // إذا كان أي منها يشير للوضع الداكن
      setIsDark(isHtmlDark || isBodyDark || dataTheme || localTheme);
    };

    checkSettings();

    // مراقبة أي تغييرات تحدث على الـ HTML أو الـ Body (مثل تبديل الثيم أو اللغة)
    const observer = new MutationObserver(checkSettings);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["dir", "lang", "class", "data-theme"],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  function isActive(path: string) {
    if (path === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(path);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  // اختيار اللوجو بناءً على الحالة المحدثة
  const logoSrc = isDark ? "/photos/auth-logo.png" : "/photos/whitebg.png";

  return (
    <aside
      aria-label="Sidebar"
      dir={isArabic ? "rtl" : "ltr"}
      className={`h-screen sticky top-0 flex flex-col border-r border-border/60 bg-card/50 backdrop-blur-xl transition-all duration-300 ease-in-out flex-shrink-0 z-30 ${
        collapsed ? "w-20" : "w-64"
      }`}
    >
      {/* Header & Logo */}
      <div className="h-16 border-b border-border/60 flex items-center justify-between px-4 gap-2">
        <div className={`flex items-center gap-3 overflow-hidden ${collapsed ? "justify-center w-full" : ""}`}>
          <div className="relative w-8 h-8 shrink-0 flex items-center justify-center">
            <Image
              key={logoSrc} // يجبر Next.js على إعادة تحميل الصورة عند تغير الثيم فوراً
              src={logoSrc}
              alt="Logo"
              fill
              className="object-contain rounded-lg"
              priority
            />
          </div>
          {!collapsed && (
            <span className="text-base font-bold tracking-tight text-foreground truncate">
              FlexiData
            </span>
          )}
        </div>

        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/85 transition-colors shrink-0"
            title={isArabic ? "طي القائمة" : "Collapse sidebar"}
          >
            {isArabic ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        )}
      </div>

      {/* Expand button if collapsed */}
      {collapsed && (
        <div className="px-2 py-3 flex justify-center border-b border-border/60">
          <button
            onClick={() => setCollapsed(false)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/80 transition-colors"
            title={isArabic ? "توسيع القائمة" : "Expand sidebar"}
          >
            {isArabic ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.path);
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => router.push(item.path)}
              className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                collapsed ? "px-0 py-3 justify-center" : "px-3.5 py-3"
              } ${
                active
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
              }`}
              title={collapsed ? t(`nav.${item.key}`) : undefined}
            >
              <Icon size={20} className={`shrink-0 transition-transform duration-200 ${active ? "scale-105" : "group-hover:scale-105"}`} />
              {!collapsed && <span className="truncate">{t(`nav.${item.key}`)}</span>}
            </button>
          );
        })}
      </nav>

      {/* Sign out */}
      <div className="p-3 border-t border-border/60 bg-muted/20">
        <button
          onClick={handleSignOut}
          className={`w-full flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all duration-200 ${
            collapsed ? "px-0 py-3 justify-center" : "px-3.5 py-3"
          }`}
          title={collapsed ? t("nav.signOut") : undefined}
        >
          <LogOut size={20} className="shrink-0 transition-transform duration-200 hover:scale-105" />
          {!collapsed && <span className="truncate">{t("nav.signOut")}</span>}
        </button>
      </div>
    </aside>
  );
}