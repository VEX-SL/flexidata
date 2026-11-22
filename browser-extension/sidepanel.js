const byId = (id) => document.getElementById(id);
let activeTab = null;
let latestObservation = null;
let trustedAttached = false;
let autoInspectTimer = 0;
let autoInspectBusy = false;
let autoInspectPending = false;

function showTrustedResult(text, isError = false) {
  const box = byId("trustedResult");
  box.textContent = text;
  box.classList.toggle("error", isError);
  box.classList.remove("hidden");
}

function syncTrustedUi() {
  byId("trustedAttach").classList.toggle("hidden", trustedAttached);
  byId("trustedDetach").classList.toggle("hidden", !trustedAttached);
  byId("trustedActions").classList.toggle("hidden", !trustedAttached);
  byId("trustedAttach").disabled = !activeTab;
  const hasPoint = byId("x").value.trim() !== "" && byId("y").value.trim() !== "";
  byId("trustedHover").disabled = !trustedAttached || !hasPoint;
  byId("trustedClick").disabled = !trustedAttached || !hasPoint;
  byId("trustedType").disabled = !trustedAttached;
  byId("trustedDrag").disabled = !trustedAttached || !hasPoint;
  byId("trustedScroll").disabled = !trustedAttached || !hasPoint;
  byId("trustedStatus").textContent = trustedAttached
    ? "مفعّل لهذا التبويب — شريط تحذير Chrome ظاهر فوق النافذة."
    : "غير مفعّل. بعض المواقع تتجاهل النقرات الاصطناعية؛ فعّله عند الحاجة.";
}

function showResult(text, isError = false) {
  const box = byId("clickResult");
  box.textContent = text;
  box.classList.toggle("error", isError);
  box.classList.remove("hidden");
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "تعذر إكمال الطلب.");
  return response.result;
}

async function refreshTab() {
  const previousTabId = activeTab?.id;
  byId("tabInfo").textContent = "جارٍ تحديد التبويب النشط…";
  byId("inspect").disabled = true;
  byId("clickAt").disabled = true;
  try {
    activeTab = await request({ type: "GET_ACTIVE_TAB" });
    if (previousTabId !== null && previousTabId !== activeTab.id) {
      latestObservation = null;
      byId("observation").classList.add("hidden");
    }
    byId("tabInfo").innerHTML = "";
    const title = document.createElement("strong");
    title.textContent = activeTab.title || "بدون عنوان";
    const origin = document.createElement("div");
    origin.className = "muted";
    origin.textContent = new URL(activeTab.url).origin;
    byId("tabInfo").append(title, origin);
    byId("inspect").disabled = false;
    byId("pickPoint").disabled = false;
    byId("grantSite").disabled = false;
    await updateSitePermissionStatus();
    try {
      const status = await request({ type: "TRUSTED_STATUS", tabId: activeTab.id });
      trustedAttached = Boolean(status.attached);
    } catch {
      trustedAttached = false;
    }
  } catch (error) {
    activeTab = null;
    latestObservation = null;
    byId("observation").classList.add("hidden");
    trustedAttached = false;
    byId("tabInfo").textContent = error.message;
    byId("pickPoint").disabled = true;
    byId("grantSite").disabled = true;
    byId("grantSite").classList.add("hidden");
    byId("permissionStatus").textContent = "";
  }
  syncTrustedUi();
}

function sitePermissionPattern(urlString) {
  const url = new URL(urlString);
  // Chrome match patterns cannot scope host access to a port.
  return `${url.protocol}//${url.hostname}/*`;
}

async function updateSitePermissionStatus() {
  if (!activeTab) return;
  const pattern = sitePermissionPattern(activeTab.url);
  const allowed = await chrome.permissions.contains({ origins: [pattern] });
  byId("grantSite").classList.toggle("hidden", allowed);
  byId("permissionStatus").textContent = allowed
    ? `السماح الدائم مفعّل لهذا الموقع (${new URL(activeTab.url).hostname})؛ يعمل على تبويباته أيضاً.`
    : "الوصول الحالي مؤقت لهذا التبويب فقط. اسمح للموقع مرة واحدة ليعمل على تبويباته الأخرى.";
}

function selectElement(item) {
  selectPoint(item.rect.x + item.rect.width / 2, item.rect.y + item.rect.height / 2);
}

function selectPoint(x, y) {
  byId("x").value = String(Math.round(x));
  byId("y").value = String(Math.round(y));
  byId("clickAt").disabled = false;
  byId("clickResult").classList.add("hidden");
  syncTrustedUi();
}

function renderObservation(observation, screenshot) {
  latestObservation = observation;
  byId("observation").classList.remove("hidden");
  byId("pageSummary").textContent = `${observation.title || "بدون عنوان"} · ${observation.viewport.width}×${observation.viewport.height} CSS px · ${observation.url}`;
  byId("pageScreenshot").src = screenshot || "";
  byId("pageScreenshot").classList.toggle("hidden", !screenshot);
  byId("visualFallback").classList.toggle("hidden", Boolean(screenshot));
  const markers = byId("visualMarkers");
  markers.classList.toggle("hidden", !screenshot);
  markers.replaceChildren();
  for (const item of observation.elements.slice(0, 60)) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `visual-marker${item.disabled ? " disabled-marker" : ""}`;
    marker.textContent = item.ref.slice(1);
    marker.title = `${item.role}: ${item.name || "بدون اسم"}`;
    marker.setAttribute("aria-label", marker.title);
    marker.style.left = `${((item.rect.x + item.rect.width / 2) / observation.viewport.width) * 100}%`;
    marker.style.top = `${((item.rect.y + item.rect.height / 2) / observation.viewport.height) * 100}%`;
    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      selectElement(item);
    });
    markers.append(marker);
  }
  byId("visualStage").onclick = (event) => {
    if (event.target.closest?.(".visual-marker") || !screenshot) return;
    const rect = byId("pageScreenshot").getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) / rect.width) * observation.viewport.width;
    const y = ((event.clientY - rect.top) / rect.height) * observation.viewport.height;
    if (x < 0 || y < 0 || x >= observation.viewport.width || y >= observation.viewport.height) return;
    selectPoint(x, y);
    showResult(`تم اختيار النقطة x=${Math.round(x)}, y=${Math.round(y)} من الصورة. اضغط تنفيذ النقرة لتأكيدها.`);
  };
  byId("pageText").textContent = observation.text || "لا يوجد نص ظاهر.";
  byId("elementCount").textContent = `${observation.elements.length} عنصر`;
  byId("truncated").classList.toggle("hidden", !observation.truncated);
  const list = byId("elements");
  list.replaceChildren();
  for (const item of observation.elements) {
    const button = document.createElement("button");
    button.className = "element";
    button.disabled = item.disabled;
    const title = document.createElement("strong");
    title.textContent = `${item.ref} · ${item.name || "(بدون اسم)"}`;
    const detail = document.createElement("small");
    detail.textContent = `${item.role}${item.disabled ? " · disabled" : ""} · x:${item.rect.x} y:${item.rect.y} · ${item.rect.width}×${item.rect.height}`;
    button.append(title, detail);
    button.addEventListener("click", () => selectElement(item));
    list.append(button);
  }
}

byId("refreshTab").addEventListener("click", () => void refreshTab());
byId("grantSite").addEventListener("click", async () => {
  if (!activeTab) return;
  const pattern = sitePermissionPattern(activeTab.url);
  // Called directly in this button's click handler so Chrome can show its
  // optional-host-permission prompt. The permission is limited to this host.
  const permissionRequest = chrome.permissions.request({ origins: [pattern] });
  byId("grantSite").disabled = true;
  try {
    const granted = await permissionRequest;
    if (!granted) {
      byId("permissionStatus").textContent = "لم يتم منح صلاحية الموقع؛ يمكنك السماح لاحقاً.";
      return;
    }
    byId("permissionStatus").textContent = `تم السماح لـ${new URL(activeTab.url).hostname}. سيعمل على تبويبات هذا الموقع.`;
    await updateSitePermissionStatus();
    await refreshTab();
  } catch (error) {
    byId("permissionStatus").textContent = error.message;
  } finally {
    byId("grantSite").disabled = false;
  }
});

byId("hideMarkers").addEventListener("click", async () => {
  if (!activeTab) return;
  try {
    await request({ type: "HIDE_MARKERS", tabId: activeTab.id });
    byId("hideMarkers").textContent = "تم إخفاء العلامات · إظهارها مجدداً عبر افهم الصفحة";
  } catch (error) {
    showResult(error.message, true);
  }
});

byId("pickPoint").addEventListener("click", async () => {
  if (!activeTab) return;
  byId("pickPoint").disabled = true;
  try {
    await request({ type: "PICK_POINT", tabId: activeTab.id });
    showResult("وضع اختيار النقطة جاهز لمدة ١٥ ثانية. انقر على أي نقطة في صفحة الموقع؛ ستُلتقط الإحداثيات وتُلغى نقرة الموقع.");
  } catch (error) {
    showResult(error.message, true);
  } finally {
    byId("pickPoint").disabled = false;
  }
});

byId("inspect").addEventListener("click", async () => {
  if (!activeTab) return;
  byId("inspect").disabled = true;
  byId("inspect").textContent = "جارٍ الفحص…";
  try {
    const response = await request({ type: "INSPECT_PAGE", tabId: activeTab.id });
    activeTab = response.tab;
    renderObservation(response.observation, response.screenshot);
    byId("hideMarkers").textContent = "إخفاء العلامات من الصفحة";
    byId("clickAt").disabled = false;
  } catch (error) {
    showResult(error.message, true);
  } finally {
    byId("inspect").disabled = !activeTab;
    byId("inspect").textContent = "افهم الصفحة";
  }
});

async function inspectCurrentPage({ quiet = true } = {}) {
  if (!activeTab || autoInspectBusy) {
    autoInspectPending = true;
    return;
  }
  autoInspectBusy = true;
  try {
    const inspectedTabId = activeTab.id;
    const response = await request({ type: "INSPECT_PAGE", tabId: inspectedTabId });
    if (activeTab?.id !== inspectedTabId) return;
    activeTab = response.tab;
    renderObservation(response.observation, response.screenshot);
    byId("hideMarkers").textContent = "إخفاء العلامات من الصفحة";
  } catch (error) {
    if (!quiet) showResult(error.message, true);
  } finally {
    autoInspectBusy = false;
    if (autoInspectPending) {
      autoInspectPending = false;
      scheduleAutoInspect(150);
    }
  }
}

function scheduleAutoInspect(delay = 500) {
  clearTimeout(autoInspectTimer);
  autoInspectTimer = window.setTimeout(() => void inspectCurrentPage(), delay);
}

byId("x").addEventListener("input", () => { byId("clickAt").disabled = !activeTab; syncTrustedUi(); });
byId("y").addEventListener("input", () => { byId("clickAt").disabled = !activeTab; syncTrustedUi(); });
byId("clickAt").addEventListener("click", async () => {
  if (!activeTab) return;
  if (!byId("x").value.trim() || !byId("y").value.trim()) return showResult("أدخل أو اختر إحداثيي X وY أولاً.", true);
  const x = Number(byId("x").value);
  const y = Number(byId("y").value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return showResult("أدخل إحداثيي X وY.", true);
  const target = latestObservation?.elements.find(({ rect }) =>
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
  );
  const targetLabel = target ? `${target.role}: ${target.name || "(بدون اسم)"}` : "أي عنصر/مساحة DOM تحت هذه النقطة (حتى بلا علامة)";
  const confirmed = window.confirm(
    `تأكيد النقر الاصطناعي؟\n\nالموقع: ${new URL(activeTab.url).origin}\nالهدف المتوقع: ${targetLabel}\nالإحداثيات: x=${x}, y=${y} CSS px\n\nقد ينفذ هذا النقر أثراً داخل الموقع. لن تُرسل بيانات الصفحة إلى FlexiData.`
  );
  if (!confirmed) return;
  byId("clickAt").disabled = true;
  try {
    const result = await request({
      type: "CLICK_AT",
      tabId: activeTab.id,
      observedUrl: latestObservation?.url || activeTab.url,
      x,
      y
    });
    showResult(`تم إرسال click اصطناعي إلى ${result.target.role}: ${result.target.name || "(بدون اسم)"} عند x=${x}, y=${y}.`);
  } catch (error) {
    showResult(error.message, true);
  } finally {
    byId("clickAt").disabled = false;
  }
});

byId("trustedAttach").addEventListener("click", async () => {
  if (!activeTab) return;
  const confirmed = window.confirm(
    "تفعيل الوضع الموثوق؟\n\nسيُظهر Chrome شريط تحذير دائم فوق هذه النافذة طوال الاتصال، ويمنح الإضافة وصول DevTools الكامل لهذا التبويب (تُستخدم هنا فقط أوامر النقر/التحويم/الكتابة/السحب). أوقفه من الزر نفسه بعد الانتهاء."
  );
  if (!confirmed) return;
  byId("trustedAttach").disabled = true;
  try {
    await request({ type: "TRUSTED_ATTACH", tabId: activeTab.id });
    trustedAttached = true;
    showTrustedResult("تم تفعيل الوضع الموثوق لهذا التبويب.");
  } catch (error) {
    showTrustedResult(error.message, true);
  } finally {
    syncTrustedUi();
  }
});

byId("trustedDetach").addEventListener("click", async () => {
  if (!activeTab) return;
  try {
    await request({ type: "TRUSTED_DETACH", tabId: activeTab.id });
    trustedAttached = false;
    showTrustedResult("تم إيقاف الوضع الموثوق.");
  } catch (error) {
    showTrustedResult(error.message, true);
  } finally {
    syncTrustedUi();
  }
});

byId("trustedHover").addEventListener("click", async () => {
  if (!activeTab) return;
  const x = Number(byId("x").value);
  const y = Number(byId("y").value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return showTrustedResult("أدخل أو اختر إحداثيي X وY أولاً.", true);
  try {
    await request({ type: "TRUSTED_HOVER_AT", tabId: activeTab.id, observedUrl: latestObservation?.url || activeTab.url, x, y });
    showTrustedResult(`تم التحويم الحقيقي عند x=${x}, y=${y}.`);
    scheduleAutoInspect(250);
  } catch (error) {
    showTrustedResult(error.message, true);
  }
});

byId("trustedClick").addEventListener("click", async () => {
  if (!activeTab) return;
  const x = Number(byId("x").value);
  const y = Number(byId("y").value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return showTrustedResult("أدخل أو اختر إحداثيي X وY أولاً.", true);
  const confirmed = window.confirm(
    `تأكيد النقر الموثوق؟\n\nالموقع: ${new URL(activeTab.url).origin}\nالإحداثيات: x=${x}, y=${y} CSS px\n\nهذا نقر فعلي موثوق (isTrusted=true) وسينفذ أثره داخل الموقع.`
  );
  if (!confirmed) return;
  byId("trustedClick").disabled = true;
  try {
    const result = await request({ type: "TRUSTED_CLICK_AT", tabId: activeTab.id, observedUrl: latestObservation?.url || activeTab.url, x, y });
    showTrustedResult(`تم إرسال نقر موثوق عند x=${result.coordinates.x}, y=${result.coordinates.y}.`);
  } catch (error) {
    showTrustedResult(error.message, true);
  } finally {
    syncTrustedUi();
  }
});

byId("trustedType").addEventListener("click", async () => {
  if (!activeTab) return;
  const text = byId("typeText").value;
  if (!text.trim()) return showTrustedResult("اكتب نصاً أولاً.", true);
  byId("trustedType").disabled = true;
  try {
    const result = await request({ type: "TRUSTED_TYPE_TEXT", tabId: activeTab.id, text });
    showTrustedResult(`تم إرسال ${result.length} حرف ككتابة موثوقة. ملاحظة: الكتابة تذهب إلى العنصر الذي يملك التركيز (focus) في الصفحة حالياً — انقر على الحقل المطلوب أولاً (بالنقر الموثوق أو العادي) قبل الكتابة.`);
  } catch (error) {
    showTrustedResult(error.message, true);
  } finally {
    syncTrustedUi();
  }
});

byId("trustedDrag").addEventListener("click", async () => {
  if (!activeTab) return;
  const fromX = Number(byId("x").value);
  const fromY = Number(byId("y").value);
  const toX = Number(byId("dragToX").value);
  const toY = Number(byId("dragToY").value);
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) return showTrustedResult("أدخل نقطة البداية (X/Y) ونقطة النهاية.", true);
  const confirmed = window.confirm(
    `تأكيد السحب الموثوق؟\n\nمن x=${fromX}, y=${fromY}\nإلى x=${toX}, y=${toY}`
  );
  if (!confirmed) return;
  byId("trustedDrag").disabled = true;
  try {
    await request({ type: "TRUSTED_DRAG", tabId: activeTab.id, observedUrl: latestObservation?.url || activeTab.url, fromX, fromY, toX, toY });
    showTrustedResult(`تم السحب من (${fromX}, ${fromY}) إلى (${toX}, ${toY}).`);
  } catch (error) {
    showTrustedResult(error.message, true);
  } finally {
    syncTrustedUi();
  }
});

byId("trustedScroll").addEventListener("click", async () => {
  if (!activeTab) return;
  const x = Number(byId("x").value);
  const y = Number(byId("y").value);
  const deltaY = Number(byId("scrollDeltaY").value);
  if (![x, y, deltaY].every(Number.isFinite) || deltaY === 0 || Math.abs(deltaY) > 2000) {
    return showTrustedResult("اختر إحداثيي X/Y وأدخل مقدار تمرير بين 1 و2000 (السالب لأعلى).", true);
  }
  try {
    const result = await request({ type: "TRUSTED_SCROLL", tabId: activeTab.id, observedUrl: latestObservation?.url || activeTab.url, x, y, deltaY });
    showTrustedResult(`تم تمرير الصفحة عند (${x}, ${y}) بمقدار ${result.deltaY} بكسل.`);
    scheduleAutoInspect(350);
  } catch (error) {
    showTrustedResult(error.message, true);
  }
});

void refreshTab();

// The toolbar click is the permission-granting gesture. The service worker
// stores its tab-bound result in session storage; refresh the panel as soon as
// that handshake completes, even if the panel loaded first.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "session" &&
    (changes.flexidataAuthorizedTab || changes.flexidataAccessError)
  ) {
    void refreshTab();
  }
  const point = areaName === "session" ? changes.flexidataPickedPoint?.newValue : null;
  if (point) {
    if (activeTab?.id === point.tabId && activeTab.url === point.url) {
      selectPoint(point.x, point.y);
      showResult(`تم التقاط النقطة x=${Math.round(point.x)}, y=${Math.round(point.y)}. اضغط تنفيذ النقرة لمتابعة الموقع.`);
    }
    void chrome.storage.session.remove("flexidataPickedPoint");
  }
});

chrome.permissions.onAdded.addListener(() => void refreshTab());
chrome.permissions.onRemoved.addListener(() => void refreshTab());
chrome.tabs.onActivated.addListener(() => {
  void (async () => {
    await refreshTab();
    await inspectCurrentPage();
  })();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && tabId === activeTab?.id) {
    void (async () => {
      await refreshTab();
      await inspectCurrentPage();
    })();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "BROWSER_PAGE_DIRTY" && message.tabId === activeTab?.id) {
    scheduleAutoInspect(500);
  }
});
