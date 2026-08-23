import { type MarketMetrics, toPoints } from './metrics.js';
import type { ReversionRead } from './reversion.js';
import type { TradeMetrics } from './trades.js';

/**
 * Scores and signals.
 *
 * Six separate scores rather than one mysterious number, because they
 * disagree with each other in useful ways: a contract can be 95th-percentile
 * active and 5th-percentile liquid, and that combination is a warning rather
 * than an opportunity. Collapsing them first would hide exactly the thing
 * worth seeing.
 *
 * None of these is a claim about expected value. Price and volume behaviour
 * can say a market is worth *looking at*; it cannot say a price is wrong.
 * The composite is therefore Interestingness — a research priority — and
 * deliberately not anything with "bet" or "edge" in the name, because a
 * number called that would get read as advice no matter what the tooltip
 * said.
 */

export interface Scores {
  activity: number;
  momentum: number;
  volatility: number;
  liquidity: number;
  market_quality: number;
  anomaly: number;
  /** How much of the overreaction shape is present, 0..100. */
  mean_reversion: number;
  /** Composite research priority, 0..100. Never an expected-value claim. */
  interestingness: number;
}

export type SignalKind =
  | 'UNUSUAL_ACTIVITY'
  | 'MOMENTUM'
  | 'MEAN_REVERSION'
  | 'GOOD_MARKET_QUALITY'
  | 'THIN_AND_DANGEROUS'
  | 'WIDE_SPREAD'
  | 'BOOK_IMBALANCE'
  | 'RESOLVING_SOON'
  | 'THIN_HISTORY'
  | 'LARGE_TRADE'
  | 'CONCENTRATED_FLOW'
  | 'TAKER_PRESSURE'
  | 'CROSS_MARKET_GAP';

export interface Signal {
  kind: SignalKind;
  /** Short badge text. */
  label: string;
  /** The evidence, already in human units. */
  detail: string;
  /** Whether this makes the market more interesting or less trustworthy. */
  tone: 'INFO' | 'GOOD' | 'WARN';
}

export interface ScoredMarket {
  metrics: MarketMetrics;
  scores: Scores;
  signals: Signal[];
  /** Present when the venue publishes individual fills. */
  trades: TradeMetrics | null;
  /** Present when there is enough history for a 30-day average. */
  reversion: ReversionRead | null;
  /** Same proposition, priced differently somewhere else. */
  cross_market: Array<{ venue: string; gap: number; their_price: number }>;
}

/** 1st, 2nd, 3rd, 83rd — not "83th". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** A percentile as a score, so 0.94 reads as 94. */
const pct = (p: number) => clamp(p * 100);

/* ------------------------------------------------------------------ *
 * Liquidity, on an absolute scale
 * ------------------------------------------------------------------ */

/**
 * Liquidity is the one score that is *not* self-relative.
 *
 * Everything else asks "is this unusual for this contract". Liquidity must
 * not: a market that is thin every single day would score 50 on a
 * self-relative scale and look ordinary, when being reliably untradeable is
 * the most important thing about it. So this is measured against money,
 * logarithmically, because the difference between $1k and $10k of depth
 * matters far more than between $1M and $1.01M.
 */
export function liquidityScore(metrics: MarketMetrics): number {
  // Money, not contracts. A count treats forty-two million shares of a
  // half-cent longshot as four hundred times the market that a hundred
  // thousand fifty-cent contracts is, when in dollars it is four times.
  const restingDollars = metrics.book.notional / 1000;
  const tradedDollars = (metrics.volume_24h * (metrics.price ?? 500)) / 1000;
  const combined = restingDollars + tradedDollars;
  if (combined <= 0) return 0;
  // 0 at about $100 of interest, 100 at about $1,000,000.
  const scaled = (Math.log10(combined) - 2) / 4;
  return clamp(scaled * 100);
}

/**
 * How usable the quoted price is, separate from how much size is behind it.
 *
 * Spread is the dominant term: a book with size on it but five cents wide
 * costs more to cross than a thin book quoted tightly.
 */
export function marketQualityScore(metrics: MarketMetrics): number {
  const spread = metrics.book.spread;
  const liquidity = liquidityScore(metrics);
  if (spread === null) return clamp(liquidity * 0.5);
  const spreadPoints = toPoints(spread);
  // 100 at a tenth of a point, 0 at five points wide.
  const spreadScore = clamp(((5 - spreadPoints) / 4.9) * 100);
  return clamp(spreadScore * 0.6 + liquidity * 0.4);
}

/* ------------------------------------------------------------------ *
 * Scores
 * ------------------------------------------------------------------ */

export function scoreMarket(
  metrics: MarketMetrics,
  extras: { reversion?: ReversionRead | null; trades?: TradeMetrics | null } = {},
): Scores {
  // With no volume feed there is no activity claim to make. Fifty is the
  // honest placeholder: it neither promotes nor buries the market, and the
  // card says the data is missing rather than implying a quiet day.
  const activity = metrics.has_volume_data
    ? clamp(
        pct(metrics.percentiles.volume) * 0.6 +
          Math.min(100, (metrics.volume_acceleration ?? 1) * 25) * 0.4,
      )
    : 50;

  // Movement counts for more when it happened on volume. An unbacked move is
  // arithmetic; a backed one is somebody acting.
  const backing = metrics.move_on_volume ?? 0.5;
  const momentum = clamp(
    pct(metrics.percentiles.velocity) * 0.4 +
      (metrics.momentum_persistence ?? 0) * 100 * 0.3 +
      backing * 100 * 0.3,
  );

  const volatility = pct(metrics.percentiles.volatility);
  const liquidity = liquidityScore(metrics);
  const quality = marketQualityScore(metrics);

  // Anomaly is deliberately the *rarest* of the observations rather than
  // their average: one genuinely extreme reading is the thing worth a look,
  // and averaging it against four ordinary ones buries it.
  const anomaly = clamp(
    Math.max(
      pct(metrics.percentiles.volume),
      pct(metrics.percentiles.move_24h),
      pct(metrics.percentiles.volatility),
    ),
  );

  /**
   * The composite, gated on tradeability.
   *
   * A 20-point move on nine hundred dollars is not more interesting than a
   * seven-point move on three million, and any weighted average of the raw
   * signals says that it is. Quality therefore multiplies rather than adds:
   * it can hold an otherwise screaming market down, which is the correct
   * behaviour for a screen whose output is "go and read this one".
   */
  const raw = activity * 0.3 + momentum * 0.3 + anomaly * 0.4;
  const gate = 0.35 + 0.65 * (quality / 100);
  const thinHistory = metrics.sample.span_hours < 24 ? 0.7 : 1;

  return {
    activity,
    momentum,
    volatility,
    liquidity,
    market_quality: quality,
    anomaly,
    mean_reversion: extras.reversion?.score ?? 0,
    interestingness: clamp(raw * gate * thinHistory),
  };
}

/* ------------------------------------------------------------------ *
 * Signals
 * ------------------------------------------------------------------ */

const fmtPoints = (dc: number) => `${dc > 0 ? '+' : ''}${toPoints(dc).toFixed(1)} pts`;

export function deriveSignals(
  metrics: MarketMetrics,
  scores: Scores,
  extras: {
    trades?: TradeMetrics | null;
    reversion?: ReversionRead | null;
    cross_market?: Array<{ venue: string; gap: number; their_price: number }>;
  } = {},
): Signal[] {
  const out: Signal[] = [];
  const move24 = metrics.move_24h?.change ?? 0;
  const imbalance = metrics.book.imbalance;

  if (
    (metrics.volume_acceleration ?? 0) >= 3 &&
    metrics.percentiles.volatility >= 0.8
  ) {
    out.push({
      kind: 'UNUSUAL_ACTIVITY',
      label: 'Unusual activity',
      detail:
        (metrics.was_dormant
          ? `This market was dormant and is now trading (${metrics.volume_24h.toLocaleString()} contracts), `
          : `Volume ${(metrics.volume_acceleration ?? 0).toFixed(1)}x its own normal, `) +
        `price ${fmtPoints(move24)}, volatility in the ` +
        `${ordinal(Math.round(metrics.percentiles.volatility * 100))} percentile for this market.`,
      tone: 'INFO',
    });
  }

  if (
    scores.momentum >= 70 &&
    (metrics.momentum_persistence ?? 0) >= 0.6 &&
    Math.abs(move24) > 0
  ) {
    const backed = metrics.move_on_volume;
    out.push({
      kind: 'MOMENTUM',
      label: 'Momentum',
      detail:
        `${fmtPoints(move24)} over 24h, mostly in one direction` +
        (backed !== null
          ? `, ${Math.round(backed * 100)}% of it during above-normal volume.`
          : '.'),
      tone: 'INFO',
    });
  }

  // The scored version of the overreaction shape, which needs most of its
  // components present rather than a coincidence of two.
  const reversion = extras.reversion;
  if (reversion && reversion.score >= 75) {
    out.push({
      kind: 'MEAN_REVERSION',
      label: 'Possible reversion',
      detail:
        reversion.components.filter((c) => c.present).map((c) => c.detail).join(' ') +
        ' A market can also simply have repriced on news and stayed there.',
      tone: 'INFO',
    });
  }

  if (scores.market_quality >= 80) {
    out.push({
      kind: 'GOOD_MARKET_QUALITY',
      label: 'Good market quality',
      detail:
        `$${Math.round(metrics.book.notional / 1000).toLocaleString()} resting` +
        (metrics.book.spread !== null
          ? `, ${toPoints(metrics.book.spread).toFixed(1)} pt spread.`
          : '.'),
      tone: 'GOOD',
    });
  }

  // The warning that matters most: a big number on nothing.
  if (
    metrics.has_volume_data &&
    Math.abs(move24) > 0 &&
    scores.liquidity < 35 &&
    metrics.percentiles.move_24h >= 0.7
  ) {
    out.push({
      kind: 'THIN_AND_DANGEROUS',
      label: 'Thin',
      detail:
        `${fmtPoints(move24)} on only ${metrics.volume_24h.toLocaleString()} contracts of ` +
        `volume. A move this size on a book this thin is closer to noise than news.`,
      tone: 'WARN',
    });
  }

  if (metrics.book.spread !== null && toPoints(metrics.book.spread) >= 4) {
    out.push({
      kind: 'WIDE_SPREAD',
      label: 'Wide spread',
      detail: `${toPoints(metrics.book.spread).toFixed(1)} points between bid and ask.`,
      tone: 'WARN',
    });
  }

  if (imbalance !== null && Math.abs(imbalance) >= 0.7) {
    out.push({
      kind: 'BOOK_IMBALANCE',
      label: 'Book imbalance',
      detail:
        `${Math.round(Math.abs(imbalance) * 100)}% of resting size is on the ` +
        `${imbalance > 0 ? 'YES' : 'NO'} side.`,
      tone: 'INFO',
    });
  }

  const remaining = metrics.time_remaining_ms;
  if (remaining !== null && remaining > 0 && remaining < 6 * 3600 * 1000) {
    out.push({
      kind: 'RESOLVING_SOON',
      label: 'Resolving soon',
      detail:
        `${(remaining / 3600000).toFixed(1)}h to close. A move this late is a different ` +
        `event from the same move six months out.`,
      tone: 'INFO',
    });
  }

  const trades = extras.trades;
  if (trades && trades.large_trades.length > 0) {
    const biggest = trades.large_trades[0]!;
    out.push({
      kind: 'LARGE_TRADE',
      label: 'Large trade',
      detail:
        `${Math.round(biggest.size).toLocaleString()} contracts in one fill — ` +
        `${biggest.multiple.toFixed(0)}x this market's median of ` +
        `${Math.round(trades.median_size).toLocaleString()}` +
        (biggest.block ? ', flagged by the venue as a block trade.' : '.'),
      tone: 'INFO',
    });
  }

  if (trades && trades.concentration >= 0.6 && trades.count >= 20) {
    out.push({
      kind: 'CONCENTRATED_FLOW',
      label: 'Few, large orders',
      detail:
        `${Math.round(trades.concentration * 100)}% of volume arrived in the largest tenth of ` +
        `fills, across ${trades.count} trades — evenly spread flow would be near 10%. A crowd ` +
        `repricing something and one participant taking a position look identical in a volume ` +
        `figure.`,
      tone: 'INFO',
    });
  }

  if (trades && trades.taker_pressure !== null && Math.abs(trades.taker_pressure) >= 0.6) {
    const side = trades.taker_pressure > 0 ? 'YES' : 'NO';
    const bookSide = metrics.book.imbalance;
    const disagrees =
      bookSide !== null && Math.sign(bookSide) !== Math.sign(trades.taker_pressure);
    out.push({
      kind: 'TAKER_PRESSURE',
      label: `Buyers lifting ${side}`,
      detail:
        `${Math.round(Math.abs(trades.taker_pressure) * 100)}% of sided volume crossed the ` +
        `spread to take ${side}` +
        (disagrees
          ? ', while the resting size leans the other way — aggression against the queue.'
          : '.'),
      tone: 'INFO',
    });
  }

  for (const gap of extras.cross_market ?? []) {
    out.push({
      kind: 'CROSS_MARKET_GAP',
      label: 'Cross-market gap',
      detail:
        `${(gap.gap / 10).toFixed(1)} points away from ${gap.venue}, which has this at ` +
        `${(gap.their_price / 10).toFixed(1)}c. Whether that is takeable is the arbitrage ` +
        `tab's question, not this one's.`,
      tone: 'INFO',
    });
  }

  // Said out loud rather than folded silently into the score, because a
  // reader has no other way to know the percentiles are built on sand.
  if (metrics.sample.span_hours < 24 || metrics.sample.distribution_points < 5) {
    out.push({
      kind: 'THIN_HISTORY',
      label: 'Little history',
      detail:
        `Percentiles rest on ${metrics.sample.distribution_points} comparable periods over ` +
        `${metrics.sample.span_hours.toFixed(0)}h. "Unusual for this market" is a weak claim ` +
        `on a sample this small.`,
      tone: 'WARN',
    });
  }

  return out;
}

export function analyze(
  metrics: MarketMetrics,
  extras: {
    trades?: TradeMetrics | null;
    reversion?: ReversionRead | null;
    cross_market?: Array<{ venue: string; gap: number; their_price: number }>;
  } = {},
): ScoredMarket {
  const scores = scoreMarket(metrics, extras);
  return {
    metrics,
    scores,
    signals: deriveSignals(metrics, scores, extras),
    trades: extras.trades ?? null,
    reversion: extras.reversion ?? null,
    cross_market: extras.cross_market ?? [],
  };
}

/** Highest research priority first. */
export function rank(markets: ScoredMarket[]): ScoredMarket[] {
  return [...markets].sort((a, b) => b.scores.interestingness - a.scores.interestingness);
}
