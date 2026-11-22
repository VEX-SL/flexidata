(() => {
  const APP_ORIGINS = new Set([
    "https://flexidata.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]);
  if (!APP_ORIGINS.has(location.origin)) return;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || !APP_ORIGINS.has(event.origin)) return;
    const request = event.data;
    if (
      !request || request.source !== "flexidata-app" ||
      !["GET_BROWSER_CONTEXT", "EXECUTE_BROWSER_ACTION"].includes(request.type) ||
      typeof request.requestId !== "string" || request.requestId.length > 80
    ) return;

    chrome.runtime.sendMessage({
      type: request.type === "GET_BROWSER_CONTEXT" ? "APP_GET_BROWSER_CONTEXT" : "APP_EXECUTE_BROWSER_ACTION",
      requestId: request.requestId,
      action: request.action,
      expectedContext: request.expectedContext,
      userConfirmed: request.userConfirmed === true
    }).then((response) => {
      window.postMessage({
        source: "flexidata-browser-extension",
        type: "BROWSER_CONTEXT_RESULT",
        requestId: request.requestId,
        ok: Boolean(response?.ok),
        result: response?.result,
        error: response?.error
      }, location.origin);
    }).catch((error) => {
      window.postMessage({
        source: "flexidata-browser-extension",
        type: "BROWSER_CONTEXT_RESULT",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Browser extension is unavailable."
      }, location.origin);
    });
  });
})();
