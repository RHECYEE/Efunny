import { median, percentileOf } from './series.js';

/**
 * What the fills say that the candles cannot.
 *
 * A candle reports that a market moved eleven points on forty thousand
 * contracts. It cannot report whether that was four hundred people or one,
 * and those are close to opposite pieces of evidence: a crowd re-pricing
 * something is a different event from a single participant taking a position.
 *
 * The comparison is again relative. "A ten-thousand-contract trade" means
 * nothing without knowing that this market's typical fill is two hundred —
 * or twenty thousand.
 */

export interface Trade {
  t: number;
  size: number;
  price: number;
  taker_side: 'YES' | 'NO' | null;
  block: boolean;
}

export interface LargeTrade {
  t: number;
  size: number;
  price: number;
  taker_side: 'YES' | 'NO' | null;
  block: boolean;
  /** How many times this market's median fill. */
  multiple: number;
}

export interface TradeMetrics {
  count: number;
  /** Typical fill for this market. */
  median_size: number;
  /** The size at the 90th percentile of this market's own fills. */
  p90_size: number;
  largest: number;
  /**
   * Share of volume that arrived in the largest tenth of fills.
   *
   * Measured against a quantile of this market's own fills rather than a
   * multiple of the median. Fill sizes are heavily skewed — a median of 17
   * against a largest of 52,000 is normal — so "five times the median" is a
   * bar that almost all volume clears, and the figure pinned at 99% for every
   * market and discriminated nothing. Uniform flow scores near 10 here;
   * concentrated flow scores far above it.
   */
  concentration: number;
  /** Fills far above this market's own normal, largest first. */
  large_trades: LargeTrade[];
  /** Venue-flagged block trades in the window. */
  block_trades: number;
  /**
   * Net aggressor direction, -1 (all NO) to +1 (all YES), weighted by size.
   *
   * Distinct from book imbalance: that says which side is *waiting*, this
   * says which side is being *hit*. They frequently disagree, and the
   * disagreement is usually the interesting part.
   */
  taker_pressure: number | null;
}

/** A fill at this multiple of the market's own median is worth naming. */
const LARGE_MULTIPLE = 5;

/** Concentration is measured over the top decile of fills. */
const CONCENTRATION_QUANTILE = 0.9;

export function computeTradeMetrics(trades: Trade[]): TradeMetrics | null {
  if (trades.length === 0) return null;

  const sizes = trades.map((t) => t.size);
  const med = median(sizes) || 1;
  const p90 = quantile(sizes, 0.9);
  const largest = Math.max(...sizes);

  const heavy = trades.filter((t) => t.size >= med * LARGE_MULTIPLE);
  const totalVolume = sizes.reduce((s, x) => s + x, 0);
  /**
   * The top decile taken by rank, not by threshold.
   *
   * Thresholding on the 90th-percentile *value* breaks on ties: a hundred
   * identical fills all clear their own quantile, so perfectly uniform flow
   * reported as 100% concentrated — the exact opposite of the truth. Counting
   * the largest tenth of the fills is tie-safe and gives uniform flow the
   * ~10% it should have.
   */
  const ranked = [...sizes].sort((a, b) => b - a);
  const topCount = Math.max(1, Math.ceil(ranked.length * (1 - CONCENTRATION_QUANTILE)));
  const topDecileVolume = ranked.slice(0, topCount).reduce((s, x) => s + x, 0);

  let yes = 0;
  let no = 0;
  for (const t of trades) {
    if (t.taker_side === 'YES') yes += t.size;
    else if (t.taker_side === 'NO') no += t.size;
  }
  const sided = yes + no;

  return {
    count: trades.length,
    median_size: med,
    p90_size: p90,
    largest,
    concentration: totalVolume > 0 ? topDecileVolume / totalVolume : 0,
    // Biggest first, so the headline figure is the actual largest fill and
    // not merely the largest of the eight most recent.
    large_trades: heavy
      .slice()
      .sort((a, b) => b.size - a.size)
      .slice(0, 8)
      .map((t) => ({ ...t, multiple: t.size / med })),
    block_trades: trades.filter((t) => t.block).length,
    taker_pressure: sided > 0 ? (yes - no) / sided : null,
  };
}

function quantile(sample: number[], q: number): number {
  if (sample.length === 0) return 0;
  const sorted = [...sample].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index]!;
}

/** Where a single fill sits in this market's own distribution of fills. */
export function sizePercentile(size: number, trades: Trade[]): number {
  return percentileOf(size, trades.map((t) => t.size));
}
