import { test, ok, equal } from "./harness.ts";
import { ALLOWED_BROWSER_KEYS, isAllowedBrowserKey, shouldAttachBrowserContext, stripBrowserSkillCommand } from "../src/lib/browser-agent/policy.ts";

test("/browser selects the browser skill and removes only the leading command", () => {
  equal(stripBrowserSkillCommand("/browser افتح الصفحة").text, "افتح الصفحة");
  equal(stripBrowserSkillCommand("/browser افتح الصفحة").forced, true);
  equal(stripBrowserSkillCommand("استخدم مهارة /browser داخل النص").forced, false);
});

test("a bare /browser command is distinguishable from a browser request", () => {
  equal(stripBrowserSkillCommand("/browser").text, "");
  equal(stripBrowserSkillCommand("/browser").forced, true);
});

test("browser context is attached only for likely browser-oriented requests", () => {
  equal(shouldAttachBrowserContext("/browser افتح موقع الأخبار"), true);
  equal(shouldAttachBrowserContext("اضغط زر المتابعة في الموقع"), true);
  equal(shouldAttachBrowserContext("لخص لي المستند الذي أرسلته"), false);
});

test("press_key accepts only the explicit browser key whitelist", () => {
  ok(isAllowedBrowserKey("Enter"));
  ok(isAllowedBrowserKey("Shift+Tab"));
  ok(isAllowedBrowserKey("ArrowDown"));
  equal(isAllowedBrowserKey("Control+L"), false);
  equal(isAllowedBrowserKey("a"), false);
  equal(isAllowedBrowserKey("F5"), false);
  equal(ALLOWED_BROWSER_KEYS.length, 15);
});
