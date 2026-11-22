# FlexiData Browser Agent

Chrome Manifest V3 extension for visual page inspection and user-approved browser input, with an opt-in bridge to the FlexiData agent chat.

## What it does

- Opens a Chrome Side Panel and inspects an HTTP(S) tab after the user grants access. It shows a local viewport screenshot when Chrome allows capture, visible page text, and up to 120 visible interactive elements with CSS-pixel rectangles. The user can select a numbered element, any point in the screenshot, or a point directly on the page.
- Once the first inspection is done, a lightweight page watcher listens for relevant DOM changes, click/input/change, scroll and resize events. It refreshes the cached observation in the background and refreshes the panel when open. Tab switches and completed navigations are inspected automatically when permission allows; the manual **افهم الصفحة** button remains available for an explicit refresh.
- Offers synthetic click as a fallback and debugger-backed trusted input when the user explicitly attaches trusted mode to that tab. Trusted mode supports click, hover, text entry, drag, and bounded wheel scrolling. Its per-tab attachment state survives Manifest V3 service-worker sleep/restart while Chrome keeps the debugger attached. Each action is limited to the current viewport and the currently inspected page.
- Connects to FlexiData chat only when the user enables the browser-context button in an agent chat. Before each message, the extension refreshes a compact snapshot of the last inspected tab and sends only its URL, title, visible text (capped at 5,000 characters), viewport, and up to 30 control labels/rectangles. It does not send the screenshot. Turning the button off stops sharing. The model receives that snapshot as untrusted page data, not as instructions.
- When the user's request clearly asks for a page interaction or navigation, the model may request one bounded browser action. The chat shows the exact site, action, text/URL/coordinates, and the nearest known control label in a native confirmation prompt. Nothing executes unless the user approves. After execution, a fresh observation is returned to the model; it may request another action or answer. A single user request is capped at four actions.

## Install or update for development

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select this `browser-extension` directory. For an existing install, use the extension's **Reload** button after updating; approve the FlexiData-site access requested by the content-script bridge.
3. Open a normal `http://` or `https://` page and click the FlexiData toolbar button. To avoid opening the extension for every tab on the same hostname, choose **السماح لهذا الموقع في تبويباته الأخرى** once and approve Chrome's prompt. Reload the extension after installing this version so Chrome loads the new bridge and worker code.
4. Click **افهم الصفحة** once. Thereafter the snapshot and screenshot update automatically after page changes and user interactions; there is no need to press the button after every action.
5. In a FlexiData agent chat, enable the small monitor button beside the composer to attach fresh page context to each message. Disable it to stop. The first browser observation still needs to be made in the extension so the target tab is established.

The application bridge is restricted to `https://flexidata.vercel.app` and local development at `http://localhost:3000` / `http://127.0.0.1:3000`. It returns the snapshot to the app and accepts only a small action whitelist; the extension independently verifies the app origin, the explicit confirmation flag, the app-issued snapshot, live URL, and viewport bounds. Harmless automatic snapshot refreshes no longer invalidate the exact context already delivered to the model. Coordinate clicks are rechecked against the current visible target before execution. Click works via trusted CDP input if attached, otherwise it uses a synthetic DOM click. Hover, typing, scrolling and dragging require the user to attach trusted mode to the target tab in the extension first. Explicit `navigate` can open only an HTTP(S) URL in the currently authorized tab, after the chat shows the destination and the user approves. Navigation does not silently grant page-reading permission on a new site: click the extension toolbar button on that destination and grant access there before asking the agent to inspect it. File-picker selection, CAPTCHA, browser chrome, payment submission and irreversible actions are not exposed to the model tool.

## Privacy and safety

Page inspection and screenshots stay in the browser by default. The extension does not collect cookies, local storage, passwords, or form-field values. Only when browser context is enabled in the chat does the current compact text/control snapshot go to FlexiData's authenticated chat request; the screenshot is never sent. The snapshot is not stored in the chat history as a user message. Page text and labels are untrusted: the model is instructed not to follow instructions embedded in a website.

The extension cannot control browser chrome, operating-system dialogs, native file pickers, or CAPTCHA. The native file picker must be operated by the user. Browser-internal pages such as `chrome://` are blocked. Site access is optional and requested per hostname; Chrome's match patterns cover all ports on that hostname, not its subdomains.

Trusted mode uses Chrome's powerful `debugger` permission. It is opt-in per tab, asks for confirmation, and shows Chrome's own debugging banner. This extension sends only commands in the CDP `Input` domain. Detach using **إيقاف الوضع الموثوق** when finished; Chrome can also detach when DevTools opens or the tab closes. Typed text goes only to a focused, editable text field; password and file inputs are blocked. In chat, the agent may request one action at a time, but the user must approve the exact action in a confirmation dialog before it runs. Panel actions retain their own confirmation controls.

This remains a local development prototype, not a Chrome Web Store release.

## Files and tests

- `manifest.json`: MV3 permissions, app-only content-script bridge, and optional HTTP(S) host access.
- `service-worker.js`: page inspection/watch, per-tab authorization, trusted input, and context relay.
- `flexidata-bridge.js`: origin-checked message bridge between FlexiData chat and the extension.
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js`: visual observation and explicit action controls.
- `tests/foundation.test.mjs`: static safety invariants.

Run the checks from the repository root:

```sh
node --test browser-extension/tests/foundation.test.mjs
```
