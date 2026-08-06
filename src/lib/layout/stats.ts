/**
 * Deterministic summary statistics over numeric arrays.
 *
 * Everything here is a pure function of its input and never mutates it. All
 * functions accept any input order — the distribution is computed over a
 * sorted copy, so results depend only on the multiset of values, never on the
 * order they arrive in. Empty inputs yield a neutral zero (never NaN), and
 * non-finite inputs are rejected up front.
 */

function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function assertFiniteValues(values: readonly number[]): void {
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new RangeError(`statistic values must be finite, got ${v}`);
    }
  }
}

/** Arithmetic mean over the values. Empty input yields 0 (neutral). */
export function mean(values: readonly number[]): number {
  assertFiniteValues(values);
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Median (50th percentile) over the values. Empty input yields 0. */
export function median(values: readonly number[]): number {
  assertFiniteValues(values);
  const sorted = sortedCopy(values);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Quantile (linear interpolation, nearest-rank for the endpoints) over the
 * values, matching the common default estimator. `q` must be in [0, 1]. Empty
 * input yields 0.
 */
export function quantile(values: readonly number[], q: number): number {
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new RangeError(`quantile q must be in [0, 1], got ${q}`);
  }
  assertFiniteValues(values);
  const sorted = sortedCopy(values);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

/**
 * Median absolute deviation — the median of |x − median(values)|. A robust
 * spread estimator (itself a quantile: the 50th percentile of the deviations).
 * Empty input yields 0.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  assertFiniteValues(values);
  const med = median(values);
  const deviations: number[] = [];
  for (const v of values) {
    deviations.push(Math.abs(v - med));
  }
  return median(deviations);
}

export interface GapThresholdOptions {
  /**
   * Multiplier on the median absolute deviation added to the median. Higher
   * values merge more aggressively; the default keeps tight groups together
   * while excluding the large between-group gaps.
   */
  readonly scale?: number;
}

/**
 * Adaptive gap threshold estimator: `median + scale × MAD`. The threshold is a
 * location + spread estimate of the document's own spacing distribution — it
 * never uses fixed pixel thresholds. When the spread is zero (all gaps equal)
 * the threshold collapses to the median, so uniform groups merge and any
 * larger outlier gap is excluded. Empty input yields 0.
 */
export function gapThreshold(
  values: readonly number[],
  options: GapThresholdOptions = {}
): number {
  assertFiniteValues(values);
  if (values.length === 0) return 0;
  const scale = options.scale ?? 3;
  if (!Number.isFinite(scale) || scale < 0) {
    throw new RangeError(`gap threshold scale must be non-negative, got ${scale}`);
  }
  const med = median(values);
  const spread = medianAbsoluteDeviation(values);
  if (spread === 0) return med;
  return med + scale * spread;
}
