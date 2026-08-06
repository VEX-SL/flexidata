/**
 * Deterministic statistic tests — order independence, quantile interpolation,
 * median absolute deviation and the adaptive gap threshold estimator.
 */
import {
  gapThreshold,
  mean,
  median,
  medianAbsoluteDeviation,
  quantile,
} from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

function approx(actual: number, expected: number, eps = 1e-9): void {
  ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} within ${eps}`
  );
}

// ─── mean ────────────────────────────────────────────────────────────────────

test("mean", () => {
  equal(mean([1, 2, 3, 4]), 2.5);
  equal(mean([5]), 5);
  equal(mean([]), 0, "empty input is neutral zero");
});

test("mean is order independent", () => {
  equal(mean([1, 2, 3]), mean([3, 1, 2]));
});

test("mean rejects non-finite values", () => {
  let threw = false;
  try {
    mean([1, NaN]);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "NaN throws RangeError");
});

// ─── median ──────────────────────────────────────────────────────────────────

test("median", () => {
  equal(median([3, 1, 2]), 2, "odd count");
  equal(median([4, 1, 3, 2]), 2.5, "even count");
  equal(median([9]), 9, "single value");
  equal(median([]), 0, "empty input is neutral zero");
});

test("median is order independent", () => {
  equal(median([5, 1, 9, 3, 7]), median([1, 3, 5, 7, 9]));
});

// ─── quantile ────────────────────────────────────────────────────────────────

test("quantile endpoints are min and max", () => {
  const xs = [5, 1, 9, 3, 7];
  equal(quantile(xs, 0), 1);
  equal(quantile(xs, 1), 9);
});

test("quantile median matches the median", () => {
  equal(quantile([3, 1, 2], 0.5), 2);
  equal(quantile([4, 1, 3, 2], 0.5), 2.5);
});

test("quantile interpolates linearly", () => {
  equal(quantile([0, 10], 0.25), 2.5);
  equal(quantile([0, 10, 20], 0.25), 5);
  equal(quantile([0, 10, 20], 0.75), 15);
});

test("quantile handles singletons and empty input", () => {
  equal(quantile([7], 0.4), 7);
  equal(quantile([], 0.5), 0, "empty input is neutral zero");
});

test("quantile rejects out-of-range q", () => {
  let threw = false;
  try {
    quantile([1, 2], -0.1);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "negative q throws RangeError");

  threw = false;
  try {
    quantile([1, 2], 1.5);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "q above 1 throws RangeError");
});

test("quantile is order independent", () => {
  equal(quantile([4, 1, 9, 2, 7], 0.4), quantile([1, 2, 4, 7, 9], 0.4));
});

// ─── median absolute deviation ───────────────────────────────────────────────

test("medianAbsoluteDeviation", () => {
  equal(medianAbsoluteDeviation([1, 1, 2, 2, 4]), 1);
  equal(medianAbsoluteDeviation([10, 10, 10]), 0);
  equal(medianAbsoluteDeviation([]), 0, "empty input is neutral zero");
});

// ─── gap threshold (adaptive) ────────────────────────────────────────────────

test("gapThreshold of uniform gaps is that gap value", () => {
  equal(gapThreshold([10, 10, 10, 10, 10]), 10);
});

test("gapThreshold excludes a single large outlier", () => {
  equal(gapThreshold([10, 10, 10, 10, 100]), 10);
});

test("gapThreshold rises with the median plus scaled spread", () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  // median 4.5, MAD 0.5 → 4.5 + 3 × 0.5 = 6
  approx(gapThreshold(values), 6);
});

test("gapThreshold honors a custom scale", () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  approx(gapThreshold(values, { scale: 1 }), 5);
  approx(gapThreshold(values, { scale: 0 }), 4.5);
});

test("gapThreshold of empty input is zero", () => {
  equal(gapThreshold([]), 0);
});

test("gapThreshold rejects a negative scale", () => {
  let threw = false;
  try {
    gapThreshold([1, 2], { scale: -1 });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "negative scale throws RangeError");
});
