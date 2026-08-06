/**
 * Confidence propagation tests — component sets, composite scoring,
 * child-to-parent aggregation, profiles, weight validation and frozenness.
 * All helpers must be deterministic and reject non-finite inputs.
 */
import {
  aggregateConfidenceComponents,
  createConfidenceComponents,
  createConfidenceProfile,
  DEFAULT_COMPONENT_WEIGHTS,
  defaultCompositeScore,
} from "@/lib/layout";
import { test, ok, equal } from "./harness.ts";

function approx(
  actual: number,
  expected: number,
  eps = 1e-9,
  msg?: string
): void {
  ok(
    Math.abs(actual - expected) <= eps,
    msg ?? `expected ${actual} ≈ ${expected} within ${eps}`
  );
}

test("createConfidenceComponents defaults to a neutral zero set", () => {
  const c = createConfidenceComponents();
  equal(c, { ocr: 0, geometric: 0, structural: 0, boundary: 0, typological: 0, order: 0 });
  ok(Object.isFrozen(c), "component set is frozen");
});

test("createConfidenceComponents fills partial inputs", () => {
  const c = createConfidenceComponents({ ocr: 0.9, order: 0.4 });
  equal(c.ocr, 0.9);
  equal(c.order, 0.4);
  equal(c.geometric, 0, "unspecified signals stay neutral");
});

test("createConfidenceComponents rejects non-finite values", () => {
  let threw = false;
  try {
    createConfidenceComponents({ ocr: NaN });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "NaN throws RangeError");
});

test("default weights are equal and sum to one", () => {
  approx(DEFAULT_COMPONENT_WEIGHTS.ocr, 1 / 6);
  approx(DEFAULT_COMPONENT_WEIGHTS.order, 1 / 6);
  const sum =
    DEFAULT_COMPONENT_WEIGHTS.ocr +
    DEFAULT_COMPONENT_WEIGHTS.geometric +
    DEFAULT_COMPONENT_WEIGHTS.structural +
    DEFAULT_COMPONENT_WEIGHTS.boundary +
    DEFAULT_COMPONENT_WEIGHTS.typological +
    DEFAULT_COMPONENT_WEIGHTS.order;
  approx(sum, 1);
});

test("defaultCompositeScore with equal weights averages the components", () => {
  const allHigh = createConfidenceComponents({ ocr: 1, geometric: 1, structural: 1, boundary: 1, typological: 1, order: 1 });
  approx(defaultCompositeScore(allHigh), 1);
  const oneHigh = createConfidenceComponents({ ocr: 1 });
  approx(defaultCompositeScore(oneHigh), 1 / 6);
});

test("defaultCompositeScore honors custom weights", () => {
  const oneHigh = createConfidenceComponents({ ocr: 1 });
  approx(defaultCompositeScore(oneHigh, { ocr: 1 }), 1, 1e-9, "full weight on one signal");
  const two = createConfidenceComponents({ ocr: 1, geometric: 1 });
  approx(
    defaultCompositeScore(two, { ocr: 0.5, geometric: 0.5 }),
    1,
    1e-9,
    "half on two signals"
  );
});

test("defaultCompositeScore rejects weights that do not sum to one", () => {
  let threw = false;
  try {
    defaultCompositeScore(createConfidenceComponents(), { ocr: 1, geometric: 0.1 });
  } catch (e) {
    threw = e instanceof RangeError && /sum to 1/.test(e.message);
  }
  ok(threw, "weights not summing to 1 throw");
});

test("defaultCompositeScore rejects non-finite weights and components", () => {
  let threw = false;
  try {
    defaultCompositeScore(createConfidenceComponents(), { ocr: Infinity });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "non-finite weight throws");

  threw = false;
  try {
    defaultCompositeScore({
      ocr: NaN,
      geometric: 0,
      structural: 0,
      boundary: 0,
      typological: 0,
      order: 0,
    });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "non-finite component throws");
});

test("aggregateConfidenceComponents averages each component across samples", () => {
  const a = createConfidenceComponents({ ocr: 1, geometric: 0.5 });
  const b = createConfidenceComponents({ ocr: 0, geometric: 0.5 });
  const aggregated = aggregateConfidenceComponents([a, b]);
  approx(aggregated.ocr, 0.5);
  approx(aggregated.geometric, 0.5);
  approx(aggregated.structural, 0);
  ok(Object.isFrozen(aggregated), "aggregate is frozen");
});

test("aggregateConfidenceComponents is deterministic", () => {
  const samples = [
    createConfidenceComponents({ ocr: 0.8, order: 0.2 }),
    createConfidenceComponents({ ocr: 0.4, order: 0.9 }),
    createConfidenceComponents({ geometric: 0.6 }),
  ];
  equal(aggregateConfidenceComponents(samples), aggregateConfidenceComponents(samples));
});

test("aggregateConfidenceComponents honors per-sample weights", () => {
  const a = createConfidenceComponents({ ocr: 1 });
  const b = createConfidenceComponents({ ocr: 0 });
  const aggregated = aggregateConfidenceComponents([a, b], [0.75, 0.25]);
  approx(aggregated.ocr, 0.75);
});

test("aggregateConfidenceComponents rejects bad sample weights", () => {
  let threw = false;
  try {
    aggregateConfidenceComponents(
      [createConfidenceComponents(), createConfidenceComponents()],
      [0.5]
    );
  } catch (e) {
    threw = e instanceof RangeError && /count/.test(e.message);
  }
  ok(threw, "weight count mismatch throws");

  threw = false;
  try {
    aggregateConfidenceComponents(
      [createConfidenceComponents(), createConfidenceComponents()],
      [1, 1]
    );
  } catch (e) {
    threw = e instanceof RangeError && /sum to 1/.test(e.message);
  }
  ok(threw, "weights not summing to 1 throw");
});

test("aggregateConfidenceComponents of empty samples is neutral", () => {
  const aggregated = aggregateConfidenceComponents([]);
  equal(aggregated, { ocr: 0, geometric: 0, structural: 0, boundary: 0, typological: 0, order: 0 });
});

test("createConfidenceProfile summarizes each component and the composite", () => {
  const profile = createConfidenceProfile([
    createConfidenceComponents({ ocr: 0.8, order: 0.6 }),
    createConfidenceComponents({ ocr: 0.4, order: 0.6 }),
  ]);
  approx(profile.ocr.mean, 0.6);
  approx(profile.ocr.min, 0.4);
  approx(profile.ocr.max, 0.8);
  equal(profile.ocr.count, 2);
  approx(profile.order.mean, 0.6);
  approx(profile.structural.mean, 0);
  approx(profile.aggregate.mean, 0.2);
  equal(profile.aggregate.count, 2);
  ok(Object.isFrozen(profile), "profile is frozen");
});

test("createConfidenceProfile of empty samples is neutral", () => {
  const profile = createConfidenceProfile([]);
  equal(profile.ocr.mean, 0);
  equal(profile.aggregate.mean, 0);
  equal(profile.aggregate.count, 0);
});

test("the composite policy is replaceable without API change", () => {
  const samples = [
    createConfidenceComponents({ ocr: 0.8 }),
    createConfidenceComponents({ ocr: 0.4 }),
  ];
  const defaultProfile = createConfidenceProfile(samples);
  approx(defaultProfile.aggregate.mean, 0.1, 1e-9, "equal-weight default");

  const ocrOnly: (c: { readonly ocr: number }) => number = (c) => c.ocr;
  const replaced = createConfidenceProfile(samples, ocrOnly);
  approx(replaced.aggregate.mean, 0.6, 1e-9, "policy swap changes the aggregate");
  equal(replaced.aggregate.count, 2);
  ok(Object.isFrozen(replaced), "profile built under a custom policy is frozen");
});

test("defaultCompositeScore is the same default the profile uses", () => {
  const samples = [
    createConfidenceComponents({ ocr: 1 }),
    createConfidenceComponents({ geometric: 1 }),
  ];
  equal(
    createConfidenceProfile(samples).aggregate,
    createConfidenceProfile(samples, defaultCompositeScore).aggregate
  );
});
