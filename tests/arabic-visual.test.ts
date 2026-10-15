import { hasArabic, toVisualOrder } from "@/lib/ocr/arabic/visual";
import { test, equal, ok } from "./harness.ts";

/**
 * The PDF exporter draws through a primitive that always lays text out
 * left-to-right, so Arabic must arrive already shaped and already reordered.
 * These are the golden values the renderer is handed.
 */

test("Visual order leaves Latin, numbers and dates untouched", () => {
  equal(toVisualOrder("SuperPay"), "SuperPay");
  equal(toVisualOrder("2013438351"), "2013438351");
  equal(toVisualOrder("2026-07-02"), "2026-07-02");
  equal(toVisualOrder("68.38"), "68.38");
  equal(toVisualOrder("Receipt SuperPay"), "Receipt SuperPay");
  ok(!hasArabic("2013438351"), "Western digits alone are not Arabic");
  ok(!hasArabic("١٢٣"), "Arabic-Indic digits alone are not Arabic either");
});

test("Arabic letters are shaped and reversed for right-to-left drawing", () => {
  equal(toVisualOrder("مرحبا"), "ﺎﺒﺣﺮﻣ");
  equal(toVisualOrder("لا"), "ﻻ"); // mandatory lam-alef ligature, not ل + ا
  equal(hasArabic("مرحبا"), true);
});

test("Embedded numbers and Latin stay left-to-right inside an RTL line", () => {
  equal(toVisualOrder("الإجمالي 68.38"), "68.38 ﻲﻟﺎﻤﺟﻹﺍ");
  equal(toVisualOrder("مرحبا SuperPay"), "SuperPay ﺎﺒﺣﺮﻣ");
  equal(toVisualOrder("إجمالي المبلغ 68.38 ر.س"), "ﺱ.ﺭ 68.38 ﻎﻠﺒﻤﻟﺍ ﻲﻟﺎﻤﺟﺇ");
  equal(
    toVisualOrder("فاتورة رقم 2013438351 بتاريخ 2026-07-02"),
    "2026-07-02 ﺦﻳﺭﺎﺘﺑ 2013438351 ﻢﻗﺭ ﺓﺭﻮﺗﺎﻓ"
  );
});

test("Combining marks stay attached to their own base letter", () => {
  // Sukun/shadda/kasra must follow the letter they belong to through the
  // reorder — otherwise the harakat would land on the wrong glyph.
  equal(toVisualOrder("بسْمِ اللَّهِ"), "ﻪِﻠَّﻟﺍ ﻢِﺴْﺑ");
});
