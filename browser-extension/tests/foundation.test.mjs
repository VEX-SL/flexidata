// /browser-extension/tests/foundation.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("manifest is MV3 and asks only for the foundation permissions", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.5.1");
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "debugger", "scripting", "sidePanel", "storage"].sort());
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions.sort(), ["http://*/*", "https://*/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches.sort(), [
    "http://127.0.0.1:3000/*",
    "http://localhost:3000/*",
    "https://flexidata.vercel.app/*"
  ].sort());
  assert.deepEqual(manifest.content_scripts[0].js, ["flexidata-bridge.js"]);
});

test("service worker bounds page observation and rejects stale/out-of-viewport clicks", async () => {
  const worker = await read("service-worker.js");
  assert.match(worker, /MAX_ELEMENTS = 120/);
  assert.match(worker, /location\.href !== expectedUrl/);
  assert.match(worker, /x >= innerWidth \|\| y >= innerHeight/);
  assert.match(worker, /elementFromPoint\(x, y\)/);
  assert.doesNotMatch(worker, /recognized interactive control/);
  assert.match(worker, /actionable\.disabled/);
  assert.match(worker, /chrome-extension:\/\//);
});

test("page observation excludes password input values and remote fetches", async () => {
  const worker = await read("service-worker.js");
  assert.match(worker, /input:not\(\[type=password\]\)/);
  assert.match(worker, /createTreeWalker\(document\.body \|\| document\.documentElement, NodeFilter\.SHOW_TEXT\)/);
  assert.match(worker, /closest\("input, textarea, select, \[contenteditable=true\], \[role=textbox\]"\)/);
  assert.match(worker, /el instanceof HTMLTextAreaElement \|\| el\.isContentEditable/);
  assert.doesNotMatch(worker, /fetch\s*\(/);
});

test("trusted (debugger-backed) input is opt-in per tab and limited to the Input CDP domain", async () => {
  const worker = await read("service-worker.js");
  const ui = await read("sidepanel.js");
  // Only Input.* CDP commands are ever sent — no Network, Runtime, DOM, Page, etc.
  const cdpMethods = [...worker.matchAll(/sendDebuggerCommand\([^,]+,\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(cdpMethods.length > 0);
  assert.ok(cdpMethods.every((method) => method.startsWith("Input.")), `Found non-Input CDP methods: ${cdpMethods.join(", ")}`);
  // Attach/detach are explicit, per-tab, and tracked so a tab is never left
  // silently attached from the extension's own point of view.
  assert.match(worker, /async function attachTrusted\(tabId\)/);
  assert.match(worker, /async function detachTrusted\(tabId\)/);
  assert.match(worker, /chrome\.debugger\.onDetach\.addListener/);
  assert.match(worker, /chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{/);
  assert.match(worker, /async function restoreTrustedTabs\(\)/);
  assert.match(worker, /async function persistTrustedTabs\(\)/);
  assert.match(worker, /flexidataTrustedTabs/);
  // Every trusted action re-checks attachment state before sending input.
  assert.match(worker, /function requireTrusted\(tabId\)/);
  assert.match(worker, /\["password", "file"\]/);
  assert.match(worker, /Click a visible text field first/);
  assert.match(worker, /focusedElement/);
  // The UI confirms before attaching (banner/scope explanation) and before a trusted click.
  assert.match(ui, /trustedAttach.*addEventListener\("click"/s);
  assert.match(ui, /window\.confirm\(\s*\n?\s*"تفعيل الوضع الموثوق؟/);
  assert.match(ui, /window\.confirm\(\s*\n?\s*`تأكيد النقر الموثوق؟/);
});

test("active tab identity is probed with temporary scripting access, not tabs.url", async () => {
  const worker = await read("service-worker.js");
  assert.match(worker, /chrome\.action\.onClicked\.addListener/);
  assert.match(worker, /chrome\.sidePanel\.open\(\{ tabId: tab\.id, windowId: tab\.windowId \}\)/);
  assert.doesNotMatch(worker, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
  assert.match(worker, /tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)/);
  assert.match(worker, /func: \(\) => \(\{ url: location\.href, title: document\.title \}\)/);
  assert.match(worker, /chrome\.storage\.session\.set/);
  assert.match(worker, /flexidataAuthorizedTab/);
  assert.doesNotMatch(worker, /if \(!tab\?\.id \|\| !tab\.url/);
});

test("site access is requested for one hostname and inspection returns a local screenshot", async () => {
  const ui = await read("sidepanel.js");
  const worker = await read("service-worker.js");
  assert.match(ui, /chrome\.permissions\.request\(\{ origins: \[pattern\] \}\)/);
  assert.match(ui, /return `\$\{url\.protocol\}\/\/\$\{url\.hostname\}\/\*`/);
  assert.match(worker, /chrome\.tabs\.captureVisibleTab\(tab\.windowId, \{ format: "jpeg", quality: 65 \}\)/);
  assert.match(worker, /function drawPageMarkers\(items\)/);
  assert.match(worker, /__flexidata_browser_agent_overlay__/);
  assert.match(worker, /function removePageMarkers\(\)/);
  assert.match(worker, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(ui, /visualMarkers/);
  assert.doesNotMatch(worker, /fetch\s*\(/);
});

test("any point in the screenshot maps to viewport coordinates and click dispatch is not marker-gated", async () => {
  const ui = await read("sidepanel.js");
  const worker = await read("service-worker.js");
  assert.match(ui, /byId\("visualStage"\)\.onclick/);
  assert.match(ui, /selectPoint\(x, y\)/);
  assert.match(worker, /document\.elementFromPoint\(x, y\)/);
  assert.doesNotMatch(worker, /recognized interactive control/);
  assert.match(worker, /new PointerEvent\("pointerdown"/);
  assert.match(worker, /new MouseEvent\("click"/);
});

test("page point selection is one-shot, time-limited, and prevents the captured site click", async () => {
  const ui = await read("sidepanel.js");
  const worker = await read("service-worker.js");
  assert.match(ui, /type: "PICK_POINT"/);
  assert.match(ui, /flexidataPickedPoint/);
  assert.match(worker, /function armPointPicker\(token\)/);
  assert.match(worker, /stopImmediatePropagation\(\)/);
  assert.match(worker, /setTimeout\(cleanup, 15000\)/);
  assert.match(worker, /flexidataPointPicker\.token !== message\.token/);
});

test("the UI asks for explicit confirmation before sending CLICK_AT", async () => {
  const ui = await read("sidepanel.js");
  const confirmAt = ui.indexOf("window.confirm(");
  const clickAt = ui.indexOf('type: "CLICK_AT"');
  assert.ok(confirmAt >= 0);
  assert.ok(clickAt > confirmAt);
  assert.match(ui, /observedUrl: latestObservation\?\.url \|\| activeTab\.url/);
});

test("page observation refreshes automatically after DOM, input, click, and scrolling changes", async () => {
  const worker = await read("service-worker.js");
  const ui = await read("sidepanel.js");
  assert.match(worker, /function startPageWatch\(watchId\)/);
  assert.match(worker, /new MutationObserver/);
  for (const event of ["click", "input", "change", "scroll", "resize"]) assert.match(worker, new RegExp(`"${event}"`));
  assert.match(worker, /type: "PAGE_STATE_CHANGED"/);
  assert.match(worker, /type: "BROWSER_PAGE_DIRTY"/);
  assert.match(ui, /scheduleAutoInspect\(500\)/);
  assert.match(ui, /await inspectCurrentPage\(\)/);
});

test("FlexiData app bridge is origin-restricted and shares text snapshot only on request", async () => {
  const bridge = await read("flexidata-bridge.js");
  const worker = await read("service-worker.js");
  const readme = await read("README.md");
  assert.match(bridge, /event\.source !== window/);
  assert.match(bridge, /event\.origin !== location\.origin/);
  assert.match(bridge, /GET_BROWSER_CONTEXT/);
  assert.match(worker, /isFlexiDataAppContentScript/);
  assert.match(worker, /https:\/\/flexidata\.vercel\.app/);
  assert.match(worker, /flexidataLastBrowserObservation/);
  assert.match(readme, /the screenshot is never sent/i);
  assert.match(readme, /turning the button off stops sharing/i);
});

test("trusted scrolling is bounded and dispatched only through the CDP Input domain", async () => {
  const worker = await read("service-worker.js");
  const ui = await read("sidepanel.js");
  assert.match(worker, /async function trustedScroll\(tabId, x, y, deltaY\)/);
  assert.match(worker, /Math\.abs\(deltaY\) > 2000/);
  assert.match(worker, /type: "mouseWheel"/);
  assert.match(ui, /type: "TRUSTED_SCROLL"/);
  assert.match(ui, /scheduleAutoInspect\(350\)/);
});

test("AI-requested browser actions require explicit confirmation and a fresh, matching page snapshot", async () => {
  const worker = await read("service-worker.js");
  const bridge = await read("flexidata-bridge.js");
  const ui = await read("../src/app/(dashboard)/agents/[id]/chat/page.tsx");
  const route = await read("../src/app/api/chat/stream/route.ts");
  assert.match(worker, /message\.userConfirmed !== true/);
  assert.match(worker, /flexidataAppBrowserContext: snapshot/);
  assert.match(worker, /snapshot\.capturedAt !== expected\.capturedAt/);
  assert.match(worker, /current\.url !== snapshot\.url/);
  assert.match(worker, /oldTarget\.role !== newTarget\.role \|\| oldTarget\.name !== newTarget\.name/);
  assert.match(worker, /\["click", "hover", "scroll"\]/);
  assert.match(worker, /Unsupported browser action/);
  assert.match(bridge, /EXECUTE_BROWSER_ACTION/);
  const confirmation = ui.indexOf("window.confirm(\n            `طلب Browser Agent");
  const execution = ui.indexOf("executeBrowserAction(action, actionContext)");
  assert.ok(confirmation >= 0 && execution > confirmation, "execution must follow the confirmation prompt");
  assert.match(route, /\[BROWSER_ACTION: \{"action":"click","x":123,"y":456\}\]/);
  assert.match(route, /browserActionDetected/);
  assert.match(route, /browser_action/);
  assert.match(route, /let browserActionRequest: BrowserActionRequest \| null = null/);
  assert.match(ui, /focusedElement\.role/);
  assert.match(route, /never type secrets or into passwords\/files/);
});

test("navigate is explicit, HTTP(S)-only, confirmed, and reports blocked destination access honestly", async () => {
  const worker = await read("service-worker.js");
  const route = await read("../src/app/api/chat/stream/route.ts");
  const ui = await read("../src/app/(dashboard)/agents/[id]/chat/page.tsx");
  const skill = await read("../supabase/migrations/browser_agent.sql");
  assert.match(route, /raw\.action === "navigate"[\s\S]*?\["http:", "https:"\]/);
  assert.match(route, /action:\s*"navigate",\s*url/);
  assert.match(worker, /action\.action === "navigate"[\s\S]*?chrome\.tabs\.update\(tab\.id, \{ url: target\.href, active: true \}\)/);
  assert.match(worker, /message\.userConfirmed !== true/);
  assert.match(worker, /isFlexiDataPageUrl\(currentPage\.url\)[\s\S]*?لا يمكنه قراءة FlexiData نفسها/);
  assert.match(worker, /isFlexiDataPageUrl\(target\.href\)[\s\S]*?لا يمكن لـBrowser Agent التنقل إلى FlexiData نفسها/);
  assert.match(ui, /action\.action === "navigate"[\s\S]*?فتح الموقع:/);
  assert.match(ui, /actionResult\.ok !== true[\s\S]*?لم أنفّذ الإجراء بنجاح/);
  assert.match(ui, /actionResult\.navigated === true[\s\S]*?لا تملك إذن قراءة هذا الموقع/);
  assert.match(skill, /do not claim success, retry blindly, or substitute file\/image generation/);
  assert.match(route, /function isWebsiteNavigationRequest\([\s\S]*?browserAgentEnabled &&[\s\S]*?isWebsiteNavigationRequest\(messageContent\)[\s\S]*?!browserActionRequest[\s\S]*?لم أفتح الموقع/);
});


test("press_key is a confirmed, fresh-snapshot trusted Input-only action and refreshes sanitized observation", async () => {
  const worker = await read("service-worker.js");
  const allowed = ["Enter", "Escape", "Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Space"];
  const set = worker.match(/const ALLOWED_PRESS_KEYS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(set, "strict press_key allowlist exists");
  for (const key of allowed) assert.ok(set[1].includes(`"${key}"`), `allowlist contains ${key}`);
  assert.match(worker, /typeof key !== "string" \|\| !ALLOWED_PRESS_KEYS\.has\(key\)/);
  assert.match(worker, /message\.userConfirmed !== true/);
  assert.match(worker, /snapshot\.capturedAt !== expected\.capturedAt/);
  assert.match(worker, /action\.action === "press_key"[\s\S]*?trustedPressKey\(tab\.id, action\.key\)/);
  assert.match(worker, /requireTrusted\(tabId\);[\s\S]*?ALLOWED_PRESS_KEYS\.has\(key\)/);
  assert.match(worker, /key === "Shift\+Tab"[\s\S]*?const modifiers = shift \? 8 : 0/);
  assert.match(worker, /Input\.dispatchKeyEvent/);
  assert.match(worker, /func: inspectPage[\s\S]*?flexidataLastBrowserObservation: refreshedSnapshot/);
  assert.match(worker, /text: observation\.text\.slice\(0, 6000\)[\s\S]*?elements: observation\.elements\.slice\(0, 50\)/);
});
