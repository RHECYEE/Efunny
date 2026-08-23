import type { DeciCents } from '../domain/money.js';

/**
 * A market's own history, and the statistics that only make sense against it.
 *
 * The scanner's central claim is that no absolute threshold is meaningful.
 * "$500,000 of volume" is enormous for a county-level election contract and a
 * quiet afternoon for a Fed decision; "a 14-point move" is a shrug on a market
 * that swings 20 points a week and an event on one that has not moved since
 * March. Every metric here is therefore computed twice — once as a raw value,
 * and once as that value's position within this contract's own distribution.
 *
 * The raw number is what a person reads. The percentile is what the ranking
 * runs on.
 */

export interface PricePoint {
  /** Unix seconds. */
  t: number;
  /** Mid or last price, in deci-cents. */
  price: DeciCents;
  /** Contracts traded in the interval ending at `t`. Zero when unknown. */
  volume: number;
  /** Open interest at `t`, when the venue publishes it. */
  open_interest?: number | null;
}

export interface MarketHistory {
  market_id: string;
  venue: string;
  /** Oldest first. */
  points: PricePoint[];
  /**
   * Whether the venue publishes volume on this feed at all.
   *
   * Not every venue does, and a missing number is not a zero. Reporting
   * "0 vol" for a market that traded millions — merely on an endpoint that
   * omits the field — states something false, and then every volume-derived
   * signal quietly computes on the lie.
   */
  has_volume?: boolean;
}

/* ------------------------------------------------------------------ *
 * Distribution helpers
 * ------------------------------------------------------------------ */

/**
 * Where `value` sits in `sample`, as 0..1.
 *
 * Uses the fraction of observations strictly below the value plus half the
 * ties, which keeps a constant series from reporting its own single value as
 * both the 0th and 100th percentile.
 */
export function percentileOf(value: number, sample: number[]): number {
  if (sample.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const x of sample) {
    if (x < value) below += 1;
    else if (x === value) equal += 1;
  }
  return (below + equal / 2) / sample.length;
}

export function mean(sample: number[]): number {
  if (sample.length === 0) return 0;
  let total = 0;
  for (const x of sample) total += x;
  return total / sample.length;
}

export function stdev(sample: number[]): number {
  if (sample.length < 2) return 0;
  const m = mean(sample);
  let sum = 0;
  for (const x of sample) sum += (x - m) ** 2;
  return Math.sqrt(sum / (sample.length - 1));
}

/**
 * Standard deviations from the mean.
 *
 * Returns 0 rather than infinity for a flat series: a market that has never
 * moved has not just produced an infinitely surprising observation, it has
 * produced one we have no basis to be surprised by.
 */
export function zScore(value: number, sample: number[]): number {
  const sd = stdev(sample);
  if (sd === 0) return 0;
  return (value - mean(sample)) / sd;
}

export function median(sample: number[]): number {
  if (sample.length === 0) return 0;
  const sorted = [...sample].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/* ------------------------------------------------------------------ *
 * Windowing
 * ------------------------------------------------------------------ */

export const HOUR = 3600;
export const DAY = 24 * HOUR;

/** Points within `seconds` of the most recent observation. */
export function window(history: MarketHistory, seconds: number): PricePoint[] {
  const points = history.points;
  if (points.length === 0) return [];
  const cutoff = points[points.length - 1]!.t - seconds;
  return points.filter((p) => p.t >= cutoff);
}

/**
 * Price `seconds` ago, or the oldest price if the history is shorter.
 *
 * Returning the oldest rather than null matters: a market that opened four
 * hours ago genuinely has no 24-hour move, and reporting its whole life as a
 * 24-hour move would make every new listing look like a shock. The caller is
 * told how much history actually backed the number.
 */
export function priceAgo(
  history: MarketHistory,
  seconds: number,
): { price: DeciCents; covered: boolean } | null {
  const points = history.points;
  if (points.length === 0) return null;
  const target = points[points.length - 1]!.t - seconds;
  let chosen = points[0]!;
  for (const p of points) {
    if (p.t <= target) chosen = p;
    else break;
  }
  return { price: chosen.price, covered: points[0]!.t <= target };
}

export function latest(history: MarketHistory): PricePoint | null {
  return history.points[history.points.length - 1] ?? null;
}
