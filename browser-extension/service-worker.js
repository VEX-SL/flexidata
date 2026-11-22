// /browser-extension/service-worker.js
const MAX_ELEMENTS = 120;
const ALLOWED_MESSAGE_TYPES = new Set([
  "GET_ACTIVE_TAB", "INSPECT_PAGE", "CLICK_AT", "HIDE_MARKERS", "PICK_POINT",
  "TRUSTED_ATTACH", "TRUSTED_DETACH", "TRUSTED_STATUS",
  "TRUSTED_CLICK_AT", "TRUSTED_HOVER_AT", "TRUSTED_TYPE_TEXT", "TRUSTED_DRAG", "TRUSTED_SCROLL"
]);
// Tabs the user has explicitly opted into trusted (debugger-backed) input for.
// Chrome shows its own "is debugging this browser" banner on every such tab;
// this extension never attaches without a direct user action on this tab.
const trustedTabs = new Set();
const pageWatches = new Map();

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    trustedTabs.delete(source.tabId);
    void persistTrustedTabs();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  trustedTabs.delete(tabId);
  void persistTrustedTabs();
});
chrome.tabs.onRemoved.addListener((tabId) => pageWatches.delete(tabId));

async function restoreTrustedTabs() {
  const { flexidataTrustedTabs } = await chrome.storage.session.get("flexidataTrustedTabs");
  if (Array.isArray(flexidataTrustedTabs)) {
    for (const tabId of flexidataTrustedTabs) if (Number.isInteger(tabId)) trustedTabs.add(tabId);
  }
}

async function persistTrustedTabs() {
  await chrome.storage.session.set({ flexidataTrustedTabs: [...trustedTabs] });
}

void restoreTrustedTabs().catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  // Clear the persisted preference from earlier prototype builds.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

async function probeTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ url: location.href, title: document.title })
  });
  const info = results[0]?.result;
  if (!info?.url || !isWebPageUrl(info.url)) {
    throw new Error("This is a restricted browser page, not an HTTP(S) website.");
  }
  return { url: info.url, title: (info.title || "").slice(0, 300), checkedAt: Date.now() };
}

// Chrome intentionally does not grant activeTab when opening the panel via
// setPanelBehavior(openPanelOnActionClick). Probe the page synchronously from
// the toolbar-action flow, then save only this tab's short-lived binding.
chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== "number") return;
  const panelPromise = chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
  void panelPromise.catch((error) => {
    console.error("Could not open FlexiData Browser Agent panel:", error);
  });
  void (async () => {
    try {
      const page = await probeTab(tab.id);
      await chrome.storage.session.set({
        flexidataAuthorizedTab: { tabId: tab.id, ...page }
      });
      await chrome.storage.session.remove("flexidataAccessError");
    } catch (error) {
      await chrome.storage.session.set({
        flexidataAccessError: error instanceof Error ? error.message : "Could not authorize this page."
      });
    }
  })();
});

chrome.tabs.onActivated.addListener(({ previousTabId }) => {
  if (typeof previousTabId !== "number") return;
  void chrome.scripting.executeScript({
    target: { tabId: previousTabId },
    func: removePageMarkers
  }).catch(() => {
    // The prior page may have navigated or its temporary permission may expire.
  });
});

function isExtensionPage(sender) {
  return typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function isWebPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isFlexiDataPageUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://flexidata.vercel.app" ||
      url.origin === "http://localhost:3000" ||
      url.origin === "http://127.0.0.1:3000";
  } catch {
    return false;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (typeof tab?.id !== "number") {
    throw new Error("Could not identify the active tab. Focus a normal browser tab and try again.");
  }
  // Injection is the authoritative permission check. It succeeds either for
  // the action-invoked activeTab or for an origin the user explicitly allowed.
  let page;
  try {
    page = await probeTab(tab.id);
  } catch {
    const { flexidataAccessError } = await chrome.storage.session.get("flexidataAccessError");
    throw new Error(flexidataAccessError || "No access to this site yet. Click FlexiData on this tab once, then choose ‘Allow this site on other tabs’ to keep access for this website.");
  }
  return { id: tab.id, url: page.url, title: page.title };
}

function inspectPage() {
  const MAX = 120;
  const SELECTOR = [
    "button", "a[href]", "input:not([type=password])", "textarea", "select",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=option]",
    "[role=tab]", "[role=menuitem]", "[role=menuitemradio]", "[aria-haspopup]",
    "[data-radix-collection-item]", "[onclick]", "[contenteditable=true]", "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  const normalize = (text) => (text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const isVisible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth;
  };
  const pointerCandidates = [...document.querySelectorAll("body *")].slice(0, 5000)
    .filter((el) => getComputedStyle(el).cursor === "pointer");
  const candidates = [...new Set([...pointerCandidates, ...document.querySelectorAll(SELECTOR)])];
  const candidateSet = new Set(candidates);
  const visibleCandidates = candidates.filter(isVisible).filter((el) => {
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (candidateSet.has(parent)) return false;
    }
    return true;
  });
  const elements = visibleCandidates.slice(0, MAX).map((el, index) => {
    const rect = el.getBoundingClientRect();
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") ||
      (el.labels ? [...el.labels].map((label) => label.innerText).join(" ") : "") ||
      (el instanceof HTMLInputElement ? (el.type === "submit" ? el.value : "") : "") ||
      (el instanceof HTMLTextAreaElement || el.isContentEditable || el.getAttribute("role") === "textbox"
        ? ""
        : el.innerText || el.textContent || "");
    const role = el.getAttribute("role") || (el.tagName.toLowerCase() === "a" ? "link" :
      (getComputedStyle(el).cursor === "pointer" ? "clickable" : el.tagName.toLowerCase()));
    return {
      ref: `e${index + 1}`,
      role: normalize(role),
      name: normalize(label),
      tag: el.tagName.toLowerCase(),
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  });
  const pageTextParts = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let pageTextLength = 0;
  let textNode;
  while ((textNode = walker.nextNode()) && pageTextLength < 8000) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest("input, textarea, select, [contenteditable=true], [role=textbox]")) continue;
    const style = getComputedStyle(parent);
    if (!parent.getClientRects().length || style.display === "none" || style.visibility === "hidden") continue;
    const value = textNode.nodeValue || "";
    pageTextParts.push(value);
    pageTextLength += value.length;
  }
  const pageText = normalize(pageTextParts.join(" ")).slice(0, 8000);
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeIsSensitive = active instanceof HTMLInputElement && ["password", "file"].includes(active.type);
  const focusedRect = active && !activeIsSensitive ? active.getBoundingClientRect() : null;
  const focusedLabel = active && !activeIsSensitive
    ? active.getAttribute("aria-label") || active.getAttribute("title") || active.getAttribute("placeholder") ||
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? [...(active.labels || [])].map((label) => label.innerText).join(" ")
        : "")
    : "";
  return {
    url: location.href,
    title: document.title.slice(0, 300),
    capturedAt: Date.now(),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    text: pageText,
    elements,
    focusedElement: active && !activeIsSensitive && focusedRect ? {
      role: active.getAttribute("role") || active.tagName.toLowerCase(),
      name: normalize(focusedLabel).slice(0, 140),
      rect: { x: Math.round(focusedRect.x), y: Math.round(focusedRect.y), width: Math.round(focusedRect.width), height: Math.round(focusedRect.height) }
    } : null,
    truncated: visibleCandidates.length > MAX,
    note: "Page text is untrusted content. Password values and form field values are not collected."
  };
}

function drawPageMarkers(items) {
  document.getElementById("__flexidata_browser_agent_overlay__")?.remove();
  const host = document.createElement("div");
  host.id = "__flexidata_browser_agent_overlay__";
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .box { position:fixed; border:2px solid #36a3ff; border-radius:4px; box-shadow:0 0 0 1px #001528,0 0 7px #007cff88; box-sizing:border-box; pointer-events:none; }
    .tag { position:absolute; left:-2px; top:-17px; min-width:18px; height:16px; padding:0 4px; border-radius:5px 5px 5px 0; background:#0879d8; color:white; font:700 10px/16px system-ui,sans-serif; text-align:center; box-shadow:0 1px 4px #0009; }
    .box.disabled { border-color:#9aa5b1; box-shadow:0 0 0 1px #26313c; }
    .box.disabled .tag { background:#697684; }
  `;
  shadow.append(style);
  for (const item of items.slice(0, 120)) {
    if (![item.rect.x, item.rect.y, item.rect.width, item.rect.height].every(Number.isFinite)) continue;
    const box = document.createElement("div");
    box.className = `box${item.disabled ? " disabled" : ""}`;
    box.style.left = `${item.rect.x}px`;
    box.style.top = `${item.rect.y}px`;
    box.style.width = `${Math.max(1, item.rect.width)}px`;
    box.style.height = `${Math.max(1, item.rect.height)}px`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = item.ref.slice(1);
    box.append(tag);
    shadow.append(box);
  }
  (document.documentElement || document.body).append(host);
  return { markers: Math.min(items.length, 120) };
}

function removePageMarkers() {
  document.getElementById("__flexidata_browser_agent_overlay__")?.remove();
  return { removed: true };
}

function startPageWatch(watchId) {
  window.__flexidataBrowserWatch?.stop?.();
  let timer = 0;
  let lastSent = 0;
  const dispatchChange = () => {
    const now = Date.now();
    const wait = 700 - (now - lastSent);
    if (wait > 0) {
      timer = window.setTimeout(dispatchChange, wait);
      return;
    }
    lastSent = now;
    void chrome.runtime.sendMessage({
      type: "PAGE_STATE_CHANGED",
      watchId,
      url: location.href,
      scrollX,
      scrollY,
      at: now
    }).catch(() => {});
  };
  const notify = () => {
    clearTimeout(timer);
    timer = window.setTimeout(dispatchChange, 500);
  };
  const observer = new MutationObserver((records) => {
    if (records.every((record) => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const addedNodes = [...record.addedNodes];
      return Boolean(target?.closest?.("#__flexidata_browser_agent_overlay__")) ||
        (addedNodes.length > 0 && addedNodes.every((node) => node instanceof Element && node.id === "__flexidata_browser_agent_overlay__"));
    })) return;
    notify();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const eventTypes = ["click", "input", "change", "scroll", "resize", "focusin"];
  for (const type of eventTypes) window.addEventListener(type, notify, { capture: true, passive: true });
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of eventTypes) window.removeEventListener(type, notify, true);
  };
  window.__flexidataBrowserWatch = { watchId, stop };
  return { watching: true };
}

function armPointPicker(token) {
  const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  let timer;
  const cleanup = () => {
    for (const type of eventTypes) window.removeEventListener(type, onPageEvent, true);
    clearTimeout(timer);
  };
  const onPageEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type !== "click") return;
    const message = { type: "POINT_SELECTED", token, x: event.clientX, y: event.clientY, url: location.href };
    cleanup();
    void chrome.runtime.sendMessage(message).catch(() => {});
  };
  for (const type of eventTypes) window.addEventListener(type, onPageEvent, true);
  timer = setTimeout(cleanup, 15000);
  return { armed: true, timeoutMs: 15000 };
}

function clickAt(x, y, expectedUrl) {
  if (location.href !== expectedUrl) throw new Error("Page changed since inspection. Inspect again before clicking.");
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
    throw new Error("Coordinates must be inside the current CSS-pixel viewport.");
  }
  const target = document.elementFromPoint(x, y);
  if (!target) throw new Error("There is no page element at those coordinates.");
  const actionable = target.closest("button, a[href], input:not([type=password]), textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [contenteditable=true]");
  if (actionable && (actionable.disabled || actionable.getAttribute("aria-disabled") === "true")) {
    throw new Error("The target is disabled. No click was sent.");
  }
  const dispatchTarget = target;
  const rect = dispatchTarget.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    throw new Error("The page moved since inspection. Inspect again before clicking.");
  }
  const common = { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, clientX: x, clientY: y, button: 0, buttons: 1 };
  dispatchTarget.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  dispatchTarget.dispatchEvent(new MouseEvent("mousedown", common));
  dispatchTarget.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
  dispatchTarget.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
  dispatchTarget.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
  const labelTarget = actionable || dispatchTarget;
  const name = (labelTarget.getAttribute("aria-label") || labelTarget.innerText || labelTarget.textContent || labelTarget.getAttribute("title") || labelTarget.tagName).replace(/\s+/g, " ").trim().slice(0, 300);
  return {
    clicked: true,
    target: { role: labelTarget.getAttribute("role") || labelTarget.tagName.toLowerCase(), name },
    coordinates: { x, y },
    eventTrust: "synthetic pointer/mouse events — not physical/trusted input",
    urlAfter: location.href
  };
}

const CDP_PROTOCOL_VERSION = "1.3";

async function sendDebuggerCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function attachTrusted(tabId) {
  await restoreTrustedTabs();
  if (trustedTabs.has(tabId)) return { attached: true, alreadyAttached: true };
  await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
  trustedTabs.add(tabId);
  await persistTrustedTabs();
  return { attached: true, alreadyAttached: false };
}

async function detachTrusted(tabId) {
  await restoreTrustedTabs();
  if (!trustedTabs.has(tabId)) return { detached: true, wasAttached: false };
  try {
    await chrome.debugger.detach({ tabId });
  } finally {
    trustedTabs.delete(tabId);
    await persistTrustedTabs();
  }
  return { detached: true, wasAttached: true };
}

function requireTrusted(tabId) {
  if (!trustedTabs.has(tabId)) {
    throw new Error("الوضع الموثوق غير مفعّل لهذا التبويب. اضغط ‘تفعيل الوضع الموثوق’ أولاً.");
  }
}

function assertInViewport(x, y, viewport) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    throw new Error("الإحداثيات يجب أن تكون داخل حدود الصفحة الظاهرة الحالية.");
  }
}

async function getViewportSize(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, func: () => ({ width: innerWidth, height: innerHeight })
  });
  const size = results[0]?.result;
  if (!size) throw new Error("تعذر قراءة حجم الصفحة.");
  return size;
}

// Real mouse click dispatched by Chrome itself (CDP Input domain), not the
// page's JS. isTrusted is true on the resulting events, so sites that reject
// synthetic clicks (payment/upgrade buttons, some SPA frameworks) still react.
async function trustedClickAt(tabId, x, y) {
  requireTrusted(tabId);
  const viewport = await getViewportSize(tabId);
  assertInViewport(x, y, viewport);
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1
  });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1
  });
  return { clicked: true, coordinates: { x, y }, eventTrust: "trusted CDP Input event (isTrusted=true)" };
}

// Hover only — mouseMoved with no button pressed. Lets :hover styles, tooltips
// and hover-triggered menus react, which no synthetic DOM event could do
// reliably since real hover also depends on Chrome's own pointer state.
async function trustedHoverAt(tabId, x, y) {
  requireTrusted(tabId);
  const viewport = await getViewportSize(tabId);
  assertInViewport(x, y, viewport);
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  return { hovered: true, coordinates: { x, y } };
}

async function trustedScroll(tabId, x, y, deltaY) {
  requireTrusted(tabId);
  const viewport = await getViewportSize(tabId);
  assertInViewport(x, y, viewport);
  if (!Number.isFinite(deltaY) || deltaY === 0 || Math.abs(deltaY) > 2000) {
    throw new Error("التمرير يجب أن يكون بين 1 و2000 بكسل في كل مرة.");
  }
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaY, deltaX: 0, buttons: 0
  });
  return { scrolled: true, coordinates: { x, y }, deltaY };
}

// Types text as real key input. Chars outside Basic Latin (Arabic included)
// go through Input.insertText, which CDP documents as the path for text that
// doesn't correspond to a single physical key; plain ASCII goes key-by-key
// via dispatchKeyEvent so keydown/keyup driven page logic still fires.
const ALLOWED_PRESS_KEYS = new Set([
  "Enter", "Escape", "Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Space"
]);

async function trustedPressKey(tabId, key) {
  requireTrusted(tabId);
  if (typeof key !== "string" || !ALLOWED_PRESS_KEYS.has(key)) {
    throw new Error("Unsupported key. Choose one of the allowed navigation keys.");
  }
  const shift = key === "Shift+Tab";
  const name = shift ? "Tab" : key;
  const codes = {
    Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9],
    ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40],
    ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
    Backspace: ["Backspace", 8], Delete: ["Delete", 46], Home: ["Home", 36],
    End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Space: ["Space", 32]
  };
  const [code, windowsVirtualKeyCode] = codes[name];
  const modifiers = shift ? 8 : 0;
  const keyValue = name === "Space" ? " " : name;
  const params = { key: keyValue, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", { ...params, type: "keyDown" });
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", { ...params, type: "keyUp" });
  return { pressed: true, key };
}

async function trustedTypeText(tabId, text) {
  requireTrusted(tabId);
  if (typeof text !== "string" || text.length === 0) throw new Error("لا يوجد نص لإدخاله.");
  if (text.length > 2000) throw new Error("النص طويل جداً (الحد ٢٠٠٠ حرف).");
  const isSimpleAscii = /^[\x20-\x7E]*$/.test(text);
  if (isSimpleAscii) {
    for (const char of text) {
      await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: char, unmodifiedText: char, key: char });
      await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
  } else {
    await sendDebuggerCommand(tabId, "Input.insertText", { text });
  }
  return { typed: true, length: text.length };
}

// Real drag: press, several intermediate mouseMoved samples, release. A
// single jump from start to end (no intermediate moves) is what many
// drag-and-drop libraries ignore, since they listen for a moving pointer
// path rather than just down/up at two points.
async function trustedDrag(tabId, fromX, fromY, toX, toY) {
  requireTrusted(tabId);
  const viewport = await getViewportSize(tabId);
  assertInViewport(fromX, fromY, viewport);
  assertInViewport(toX, toY, viewport);
  const steps = 12;
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1
  });
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    const y = fromY + ((toY - fromY) * i) / steps;
    await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 1 });
  }
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1
  });
  return { dragged: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
}

async function handleMessage(message, sender) {
  if (!isExtensionPage(sender)) throw new Error("Only the extension side panel may request browser actions.");
  if (!message || typeof message !== "object" || !ALLOWED_MESSAGE_TYPES.has(message.type)) throw new Error("Unsupported request.");
  await restoreTrustedTabs();
  if (message.type === "GET_ACTIVE_TAB") return getActiveTab();

  const tab = await getActiveTab();
  if (message.tabId !== tab.id) throw new Error("The active tab changed. Refresh the side panel target.");
  if (message.type === "INSPECT_PAGE") {
    let screenshot = null;
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 65 });
    } catch {
      // The activeTab screenshot grant is per-tab; DOM markers still work on
      // sibling tabs when the user has explicitly granted this site's host.
    }
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPage });
    if (!results[0]?.result) throw new Error("Could not inspect this page.");
    const observation = results[0].result;
    const markerResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: drawPageMarkers, args: [observation.elements]
    });
    const watchId = crypto.randomUUID();
    const watchResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: startPageWatch, args: [watchId]
    });
    if (watchResult[0]?.result?.watching) pageWatches.set(tab.id, { watchId, url: tab.url });
    await chrome.storage.session.set({
      flexidataLastBrowserObservation: {
        tabId: tab.id,
        url: observation.url,
        title: observation.title,
        capturedAt: observation.capturedAt,
        viewport: observation.viewport,
        text: observation.text.slice(0, 6000),
        elements: observation.elements.slice(0, 50),
        focusedElement: observation.focusedElement
      }
    });
    return { tab, observation, screenshot, markers: markerResult[0]?.result?.markers || 0, watching: Boolean(watchResult[0]?.result?.watching) };
  }

  if (message.type === "TRUSTED_ATTACH") return attachTrusted(tab.id);
  if (message.type === "TRUSTED_DETACH") return detachTrusted(tab.id);
  if (message.type === "TRUSTED_STATUS") return { attached: trustedTabs.has(tab.id) };

  if (message.type === "TRUSTED_CLICK_AT" || message.type === "TRUSTED_HOVER_AT" || message.type === "TRUSTED_DRAG" || message.type === "TRUSTED_SCROLL") {
    if (typeof message.observedUrl !== "string" || message.observedUrl !== tab.url) {
      throw new Error("Page changed since inspection. Inspect again before interacting.");
    }
  }
  if (message.type === "TRUSTED_CLICK_AT") {
    return trustedClickAt(tab.id, Number(message.x), Number(message.y));
  }
  if (message.type === "TRUSTED_HOVER_AT") {
    return trustedHoverAt(tab.id, Number(message.x), Number(message.y));
  }
  if (message.type === "TRUSTED_SCROLL") {
    return trustedScroll(tab.id, Number(message.x), Number(message.y), Number(message.deltaY));
  }
  if (message.type === "TRUSTED_DRAG") {
    return trustedDrag(tab.id, Number(message.fromX), Number(message.fromY), Number(message.toX), Number(message.toY));
  }
  if (message.type === "TRUSTED_TYPE_TEXT") {
    return trustedTypeText(tab.id, message.text);
  }

  if (message.type === "HIDE_MARKERS") {
    const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: removePageMarkers });
    return result[0]?.result || { removed: false };
  }

  if (message.type === "PICK_POINT") {
    const token = crypto.randomUUID();
    await chrome.storage.session.set({
      flexidataPointPicker: { tabId: tab.id, token, url: tab.url, expiresAt: Date.now() + 15000 }
    });
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: armPointPicker, args: [token]
      });
      return result[0]?.result || { armed: false };
    } catch (error) {
      await chrome.storage.session.remove("flexidataPointPicker");
      throw error;
    }
  }

  if (typeof message.observedUrl !== "string" || message.observedUrl !== tab.url) {
    throw new Error("Page changed since inspection. Inspect again before clicking.");
  }
  const x = Number(message.x);
  const y = Number(message.y);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: clickAt,
    args: [x, y, message.observedUrl]
  });
  if (!results[0]?.result) throw new Error("The click result could not be verified.");
  return results[0].result;
}

async function acceptPickedPoint(message, sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.tab?.id !== "number") {
    throw new Error("Point selection must come from the authorized page context.");
  }
  const { flexidataPointPicker } = await chrome.storage.session.get("flexidataPointPicker");
  if (
    !flexidataPointPicker || flexidataPointPicker.tabId !== sender.tab.id ||
    flexidataPointPicker.token !== message.token || flexidataPointPicker.expiresAt < Date.now() ||
    flexidataPointPicker.url !== message.url || !Number.isFinite(message.x) || !Number.isFinite(message.y)
  ) {
    throw new Error("Point picker expired or the page changed. Arm it again.");
  }
  await chrome.storage.session.set({
    flexidataPickedPoint: {
      tabId: sender.tab.id, url: message.url,
      x: message.x, y: message.y, capturedAt: Date.now()
    }
  });
  await chrome.storage.session.remove("flexidataPointPicker");
  return { selected: true };
}

function isFlexiDataAppContentScript(sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.tab?.id !== "number" || typeof sender.url !== "string") return false;
  try {
    return new Set([
      "https://flexidata.vercel.app",
      "http://localhost:3000",
      "http://127.0.0.1:3000"
    ]).has(new URL(sender.url).origin);
  } catch {
    return false;
  }
}

async function getBrowserContextForApp(sender) {
  if (!isFlexiDataAppContentScript(sender)) throw new Error("Browser context requests are allowed only from the FlexiData app.");
  const { flexidataLastBrowserObservation } = await chrome.storage.session.get("flexidataLastBrowserObservation");
  let snapshot = flexidataLastBrowserObservation;
  if (!snapshot || !snapshot.url || !snapshot.capturedAt) {
    throw new Error("افحص التبويب مرة واحدة من لوحة الإضافة أولاً؛ بعد ذلك يتحدّث السياق تلقائياً.");
  }
  try {
    const tab = await chrome.tabs.get(snapshot.tabId);
    const probe = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ url: location.href, title: document.title })
    });
    const currentPage = probe[0]?.result;
    if (!currentPage?.url || !isWebPageUrl(currentPage.url)) throw new Error("الصفحة الحالية غير قابلة للفحص.");
    if (isFlexiDataPageUrl(currentPage.url)) throw new Error("Browser Agent مخصص للمواقع الخارجية ولا يمكنه قراءة FlexiData نفسها. اختر تبويب الموقع المطلوب وافحصه من الإضافة.");
    const inspected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPage });
    const observation = inspected[0]?.result;
    if (!observation) throw new Error("تعذّر قراءة الصفحة.");
    const watchId = crypto.randomUUID();
    const watch = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: startPageWatch, args: [watchId] });
    if (watch[0]?.result?.watching) pageWatches.set(tab.id, { watchId, url: observation.url });
    snapshot = {
      tabId: tab.id,
      url: observation.url,
      title: observation.title,
      capturedAt: observation.capturedAt,
      viewport: observation.viewport,
      text: observation.text.slice(0, 6000),
      elements: observation.elements.slice(0, 50),
      focusedElement: observation.focusedElement
    };
    await chrome.storage.session.set({
      flexidataLastBrowserObservation: snapshot,
      // Keep the exact context delivered to the model separately from the
      // auto-refreshed observation. A harmless watcher refresh must not make
      // an otherwise current action fail solely because capturedAt changed.
      flexidataAppBrowserContext: snapshot
    });
  } catch (error) {
    throw new Error(`تعذّر تحديث سياق الصفحة. أعد فحصها من لوحة الإضافة أو امنح صلاحية هذا الموقع. ${error instanceof Error ? error.message : ""}`.trim());
  }
  return {
    url: snapshot.url,
    title: snapshot.title,
    capturedAt: snapshot.capturedAt,
    viewport: snapshot.viewport,
    text: String(snapshot.text || "").slice(0, 6000),
    elements: Array.isArray(snapshot.elements) ? snapshot.elements.slice(0, 40) : [],
    focusedElement: snapshot.focusedElement || null
  };
}

async function executeBrowserActionForApp(message, sender) {
  if (!isFlexiDataAppContentScript(sender)) throw new Error("Browser actions are allowed only from the FlexiData app.");
  await restoreTrustedTabs();
  if (message.userConfirmed !== true) throw new Error("The user must confirm this browser action first.");
  const { flexidataAppBrowserContext: snapshot } = await chrome.storage.session.get("flexidataAppBrowserContext");
  const expected = message.expectedContext;
  if (!snapshot || !expected || snapshot.url !== expected.url || snapshot.capturedAt !== expected.capturedAt) {
    throw new Error("تعذّر مطابقة الإجراء مع آخر سياق أرسلناه للوكيل. حدّث سياق المتصفح ثم أعد الطلب.");
  }
  const tab = await chrome.tabs.get(snapshot.tabId);
  const action = message.action;
  if (!action || typeof action !== "object") throw new Error("Invalid browser action.");

  if (action.action === "navigate") {
    let target;
    try { target = new URL(action.url); } catch { throw new Error("رابط التنقل غير صالح."); }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.href.length > 2048) {
      throw new Error("التنقل مسموح فقط إلى رابط HTTP(S) بلا بيانات دخول مضمّنة.");
    }
    if (isFlexiDataPageUrl(target.href)) throw new Error("لا يمكن لـBrowser Agent التنقل إلى FlexiData نفسها أو التحكم بها.");
    // tabs.update is intentionally limited to the tab whose page context the
    // user enabled. Cross-origin navigation is permitted only after this
    // exact URL was shown in the app confirmation dialog.
    await chrome.tabs.update(tab.id, { url: target.href, active: true });
    const completedUrl = await new Promise((resolve) => {
      let settled = false;
      const finish = (url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(url || target.href);
      };
      const onUpdated = (tabId, changeInfo, updatedTab) => {
        if (tabId === tab.id && changeInfo.status === "complete") finish(updatedTab.url);
      };
      const timeout = setTimeout(() => finish(target.href), 20_000);
      chrome.tabs.onUpdated.addListener(onUpdated);
      void chrome.tabs.get(tab.id).then((current) => {
        if (current.status === "complete" && current.url === target.href) finish(current.url);
      }).catch(() => finish(target.href));
    });
    return { ok: true, navigated: true, url: String(completedUrl) };
  }

  const live = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: inspectPage
  });
  const current = live[0]?.result;
  if (!current || current.url !== snapshot.url) throw new Error("تغيّر عنوان الصفحة بعد إرسال السياق؛ أُلغي الإجراء لحمايتك.");
  if (current.viewport?.width !== snapshot.viewport?.width || current.viewport?.height !== snapshot.viewport?.height) {
    throw new Error("تغيّر حجم نافذة الصفحة منذ قراءة السياق؛ حدّث السياق قبل المحاولة.");
  }
  const viewport = { url: current.url, width: current.viewport.width, height: current.viewport.height };
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : NaN;
  const ensurePoint = (x, y) => assertInViewport(x, y, viewport);

  if (["click", "hover"].includes(action.action)) {
    const x = number(action.x);
    const y = number(action.y);
    ensurePoint(x, y);
    const atPoint = (items) => items.find((item) =>
      x >= item.rect.x && x <= item.rect.x + item.rect.width &&
      y >= item.rect.y && y <= item.rect.y + item.rect.height
    );
    const oldTarget = atPoint(snapshot.elements || []);
    const newTarget = atPoint(current.elements || []);
    if ((oldTarget || newTarget) && (!oldTarget || !newTarget || oldTarget.role !== newTarget.role || oldTarget.name !== newTarget.name)) {
      throw new Error("تغيّر العنصر الموجود عند موضع الإجراء منذ قراءة الصفحة. حدّث سياق المتصفح ثم أعد الطلب.");
    }
  }

  if (["click", "hover", "scroll"].includes(action.action)) {
    const x = number(action.x);
    const y = number(action.y);
    ensurePoint(x, y);
    if (action.action === "click") {
      if (trustedTabs.has(tab.id)) return { ok: true, ...(await trustedClickAt(tab.id, x, y)) };
      const clicked = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: clickAt, args: [x, y, snapshot.url] });
      if (!clicked[0]?.result) throw new Error("The click could not be verified.");
      return { ok: true, ...clicked[0].result };
    }
    if (!trustedTabs.has(tab.id)) throw new Error("فعّل الوضع الموثوق لهذا التبويب من الإضافة قبل التحويم أو التمرير.");
    if (action.action === "hover") return { ok: true, ...(await trustedHoverAt(tab.id, x, y)) };
    return { ok: true, ...(await trustedScroll(tab.id, x, y, number(action.deltaY))) };
  }

  if (action.action === "type") {
    if (!trustedTabs.has(tab.id)) throw new Error("فعّل الوضع الموثوق لهذا التبويب من الإضافة قبل الكتابة.");
    if (typeof action.text !== "string" || !action.text.trim() || action.text.length > 2000) throw new Error("Text must be between 1 and 2000 characters.");
    const focus = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.activeElement;
        if (!(el instanceof HTMLElement) || el instanceof HTMLInputElement && ["password", "file"].includes(el.type)) return { editable: false, sensitive: true };
        const editable = el.isContentEditable || el instanceof HTMLTextAreaElement ||
          el instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "number"].includes(el.type);
        return { editable: Boolean(editable && !el.hasAttribute("readonly") && !el.hasAttribute("disabled")) };
      }
    });
    if (!focus[0]?.result?.editable) throw new Error("Click a visible text field first. Password and file inputs are blocked.");
    return { ok: true, ...(await trustedTypeText(tab.id, action.text)) };
  }

  if (action.action === "drag") {
    if (!trustedTabs.has(tab.id)) throw new Error("فعّل الوضع الموثوق لهذا التبويب من الإضافة قبل السحب.");
    return { ok: true, ...(await trustedDrag(tab.id, number(action.fromX), number(action.fromY), number(action.toX), number(action.toY))) };
  }

  if (action.action === "press_key") {
    if (!trustedTabs.has(tab.id)) throw new Error("فعّل الوضع الموثوق لهذا التبويب من الإضافة قبل ضغط المفاتيح.");
    const result = await trustedPressKey(tab.id, action.key);
    const inspected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPage });
    const observation = inspected[0]?.result;
    if (!observation || observation.url !== snapshot.url) throw new Error("The target page changed while refreshing its snapshot.");
    const refreshedSnapshot = {
      tabId: tab.id, url: observation.url, title: observation.title, capturedAt: observation.capturedAt,
      viewport: observation.viewport, text: observation.text.slice(0, 6000),
      elements: observation.elements.slice(0, 50), focusedElement: observation.focusedElement
    };
    await chrome.storage.session.set({ flexidataLastBrowserObservation: refreshedSnapshot });
    return { ok: true, ...result, capturedAt: refreshedSnapshot.capturedAt };
  }

  throw new Error("Unsupported browser action.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "APP_GET_BROWSER_CONTEXT") {
    void getBrowserContextForApp(sender)
      .then((result) => sendResponse({ ok: true, requestId: message.requestId, result }))
      .catch((error) => sendResponse({ ok: false, requestId: message.requestId, error: error instanceof Error ? error.message : "Browser context unavailable." }));
    return true;
  }
  if (message?.type === "APP_EXECUTE_BROWSER_ACTION") {
    void executeBrowserActionForApp(message, sender)
      .then((result) => sendResponse({ ok: true, requestId: message.requestId, result }))
      .catch((error) => sendResponse({ ok: false, requestId: message.requestId, error: error instanceof Error ? error.message : "Browser action failed." }));
    return true;
  }
  if (message?.type === "PAGE_STATE_CHANGED") {
    const tabId = sender.tab?.id;
    const watch = typeof tabId === "number" ? pageWatches.get(tabId) : undefined;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(watch?.url || "").origin === new URL(message.url).origin;
    } catch {
      sameOrigin = false;
    }
    if (
      sender.id !== chrome.runtime.id || !watch || watch.watchId !== message.watchId ||
      !sameOrigin || typeof tabId !== "number"
    ) {
      sendResponse({ ok: false });
      return false;
    }
    watch.url = message.url;
    void chrome.scripting.executeScript({ target: { tabId }, func: inspectPage })
      .then(async (results) => {
        const observation = results[0]?.result;
        if (!observation || observation.url !== message.url) return;
        await chrome.storage.session.set({
          flexidataLastBrowserObservation: {
            tabId,
            url: observation.url,
            title: observation.title,
            capturedAt: observation.capturedAt,
            viewport: observation.viewport,
            text: observation.text.slice(0, 6000),
            elements: observation.elements.slice(0, 50),
            focusedElement: observation.focusedElement
          }
        });
        void chrome.runtime.sendMessage({ type: "BROWSER_PAGE_DIRTY", tabId, url: message.url }).catch(() => {});
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "POINT_SELECTED") {
    void acceptPickedPoint(message, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Could not select point." }));
    return true;
  }
  void handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Request failed." }));
  return true;
});
