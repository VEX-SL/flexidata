export interface BrowserPageContext {
  url: string;
  title: string;
  capturedAt: number;
  viewport: { width: number; height: number };
  text: string;
  elements: Array<{
    role: string;
    name: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  focusedElement: {
    role: string;
    name: string;
    rect: { x: number; y: number; width: number; height: number };
  } | null;
}

export type BrowserAction =
  | { action: "click" | "hover"; x: number; y: number }
  | { action: "scroll"; x: number; y: number; deltaY: number }
  | { action: "type"; text: string }
  | { action: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { action: "navigate"; url: string }
  | { action: "press_key"; key: string };

async function requestExtension<T>(
  type: "GET_BROWSER_CONTEXT" | "EXECUTE_BROWSER_ACTION",
  payload: Record<string, unknown> = {},
  timeoutMs = 4_000
): Promise<T> {
  if (typeof window === "undefined") throw new Error("Browser extension is available only in the browser.");
  const requestId = crypto.randomUUID();

  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("لم ترد إضافة FlexiData Browser Agent. تأكد من تثبيتها وإعادة تحميل صفحة FlexiData."));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (
        !data || data.source !== "flexidata-browser-extension" ||
        data.type !== "BROWSER_CONTEXT_RESULT" || data.requestId !== requestId
      ) return;

      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (!data.ok) {
        reject(new Error(typeof data.error === "string" ? data.error : "تعذر تنفيذ طلب المتصفح."));
        return;
      }
      resolve(data.result as T);
    };

    window.addEventListener("message", onMessage);
    window.postMessage({ source: "flexidata-app", type, requestId, ...payload }, window.location.origin);
  });
}

export async function requestBrowserPageContext(timeoutMs = 4_000): Promise<BrowserPageContext> {
  const value = await requestExtension<BrowserPageContext>("GET_BROWSER_CONTEXT", {}, timeoutMs);
  if (
    !value || typeof value.url !== "string" || typeof value.title !== "string" ||
    typeof value.text !== "string" || !value.viewport || !Array.isArray(value.elements)
  ) {
    throw new Error("أرسلت الإضافة سياقاً غير صالح.");
  }
  return {
    url: value.url.slice(0, 2000),
    title: value.title.slice(0, 300),
    capturedAt: Number(value.capturedAt) || Date.now(),
    viewport: {
      width: Math.max(0, Number(value.viewport.width) || 0),
      height: Math.max(0, Number(value.viewport.height) || 0),
    },
    text: value.text.slice(0, 6000),
    elements: value.elements.slice(0, 40).map((item) => ({
      role: String(item.role || "").slice(0, 80),
      name: String(item.name || "").slice(0, 180),
      rect: {
        x: Number(item.rect?.x) || 0,
        y: Number(item.rect?.y) || 0,
        width: Number(item.rect?.width) || 0,
        height: Number(item.rect?.height) || 0,
      },
    })),
    focusedElement: value.focusedElement && typeof value.focusedElement === "object"
      ? {
          role: String(value.focusedElement.role || "").slice(0, 80),
          name: String(value.focusedElement.name || "").slice(0, 180),
          rect: {
            x: Number(value.focusedElement.rect?.x) || 0,
            y: Number(value.focusedElement.rect?.y) || 0,
            width: Number(value.focusedElement.rect?.width) || 0,
            height: Number(value.focusedElement.rect?.height) || 0,
          },
        }
      : null,
  };
}

export function executeBrowserAction(
  action: BrowserAction,
  expectedContext: Pick<BrowserPageContext, "url" | "capturedAt">
): Promise<Record<string, unknown>> {
  // The chat UI calls this only after showing the exact action in a confirmation dialog.
  return requestExtension<Record<string, unknown>>(
    "EXECUTE_BROWSER_ACTION",
    { action, expectedContext, userConfirmed: true },
    action.action === "navigate" ? 30_000 : 15_000
  );
}
