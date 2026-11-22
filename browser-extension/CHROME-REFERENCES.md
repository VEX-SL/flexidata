# Chrome API notes for the Browser Agent foundation

- Chrome supports runtime-granted `optional_host_permissions`; request only the current origin so site access can be remembered for that origin without asking for all-site access. `chrome.permissions.request()` is intended for optional permissions at runtime, and requests should be tied to user interaction.
  Source: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
- `activeTab` is temporary and granted in response to an extension invocation; it does not provide durable access to sibling tabs. Chrome advises using host permissions where persistent site access is required, with least privilege.
  Source: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- `chrome.tabs.captureVisibleTab()` can capture the visible active tab when the extension has `activeTab` or `<all_urls>`; it is limited to 2 calls per second. This project requests one local JPEG capture only when the user asks to inspect.
  Source: https://developer.chrome.com/docs/extensions/reference/api/tabs


## Debugger-backed input integration (reviewed 2026-11-13)

- Chrome Debugger API: https://developer.chrome.com/docs/extensions/reference/api/debugger — requires the `debugger` permission, attaches to a specific tab, then sends CDP methods with `chrome.debugger.sendCommand`; Chrome may detach when DevTools opens or the target closes.
- Chrome DevTools Protocol Input domain: https://chromedevtools.github.io/devtools-protocol/tot/Input/ — `Input.dispatchMouseEvent` supports `mousePressed`, `mouseReleased`, `mouseMoved`, and `mouseWheel`; `Input.insertText` and `Input.dispatchKeyEvent` support text/keyboard input; coordinates are CSS pixels relative to the main-frame viewport.
- Chrome permissions guidance: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions — request only necessary permissions and explain warnings; `debugger` is a powerful, user-visible permission.
- Design rule: debugger attach remains an explicit per-tab choice, shows Chrome's own debugging banner, uses only the CDP Input domain, and offers a visible detach control. Page snapshots are not uploaded automatically; the user must enable browser context in chat.
