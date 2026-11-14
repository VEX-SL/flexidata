// ✅ Single source of truth for the sidebar open/closed preference, shared by
// BOTH sidebars:
//   - AppSidebar (dashboard) → "collapsed" (mini rail)
//   - AgentSidebar (agent chat) → fully hidden
// collapsed there ≡ closed here, so navigating between pages keeps the same
// user choice. Key + format ("sidebar-collapsed", JSON boolean) are the
// original AppSidebar's, so existing stored preferences carry over as-is.
const KEY = "sidebar-collapsed";

/**
 * @returns the stored state, or `null` when nothing is stored yet / storage
 * is unavailable (the caller then applies its own default: open).
 */
export function isSidebarCollapsed(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    return JSON.parse(raw) === true;
  } catch {
    return null;
  }
}

export function setSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(collapsed));
  } catch {}
}
