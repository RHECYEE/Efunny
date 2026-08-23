import { ONE_DOLLAR, type DeciCents } from '../domain/money.js';
import type { OrderBook } from '../domain/types.js';
import {
  DAY,
  HOUR,
  type MarketHistory,
  type PricePoint,
  latest,
  mean,
  median,
  percentileOf,
  priceAgo,
  stdev,
  window,
  zScore,
} from './series.js';

/**
 * The measurements, before any judgement is applied to them.
 *
 * Everything here is arithmetic on observed prices, volumes and books. None
 * of it says whether a market is worth looking at — that is the scoring
 * layer's job, and keeping the two apart is what lets the scores be argued
 * with. A number that turns out to be misleading can be traced to the line
 * that produced it rather than to a verdict.
 */

export interface BookMetrics {
  /** Best ask, in deci-cents. */
  yes_price: DeciCents | null;
  no_price: DeciCents | null;
  /** Best-ask minus best-bid on the YES side. */
  spread: DeciCents | null;
  /** Contracts resting across the visible ladder, both sides. */
  depth: number;
  /**
   * Capital resting, in deci-cents — depth priced at what it costs.
   *
   * Contracts alone are not comparable across price levels. Forty-two
   * million shares of a half-cent longshot and a hundred thousand of a
   * fifty-cent contract are two hundred thousand dollars and fifty thousand,
   * and a count ranks them four hundred to one the wrong way.
   */
  notional: number;
  /**
   * Where the resting size sits, as -1 (all NO) to +1 (all YES).
   *
   * Depth, not trades: this says which side is *waiting*, which is close to
   * the opposite of which side is being hit.
   */
  imbalance: number | null;
}

export interface MoveMetrics {
  change: DeciCents;
  /** False when the history is shorter than the window being asked for. */
  covered: boolean;
}

export interface MarketMetrics {
  market_id: string;
  venue: string;
  title: string;

  /* --- price ------------------------------------------------------- */
  price: DeciCents | null;
  move_1h: MoveMetrics | null;
  move_6h: MoveMetrics | null;
  move_24h: MoveMetrics | null;
  move_7d: MoveMetrics | null;
  high_24h: DeciCents | null;
  low_24h: DeciCents | null;

  /* --- movement quality -------------------------------------------- */
  /** Standard deviation of hourly price changes over the window, in deci-cents. */
  realized_volatility: number;
  /** Deci-cents per hour, over the most recent stretch. */
  velocity: number;
  /**
   * Share of absolute movement that happened while volume was above its own
   * median. A move made on volume is a different object from a move made on
   * an empty book, and this is the number that separates them.
   */
  move_on_volume: number | null;
  /**
   * Net move divided by total absolute movement, 0..1. High means a directed
   * trend; low means the market thrashed and ended up where it started.
   */
  momentum_persistence: number | null;

  /* --- volume ------------------------------------------------------ */
  volume_24h: number;
  /**
   * 24h volume over this market's own median daily volume, capped at 999.
   * The denominator is floored at one contract, so a dormant market cannot
   * produce a meaningless four-figure multiple.
   */
  volume_acceleration: number | null;
  /** True when the baseline was negligible, so the multiple means "woke up". */
  was_dormant: boolean;
  /** False when the venue publishes no volume, so volume figures are absent. */
  has_volume_data: boolean;
  open_interest: number | null;

  /* --- book -------------------------------------------------------- */
  book: BookMetrics;

  /* --- time -------------------------------------------------------- */
  /** Milliseconds until the market closes, when known. */
  time_remaining_ms: number | null;

  /* --- normalization ----------------------------------------------- */
  /**
   * Each metric's standing within this contract's own history, 0..1.
   *
   * This is the part that makes the scanner work. Without it every ranking
   * is dominated by whichever markets happen to be large, and a genuinely
   * unusual day on a mid-sized contract never surfaces.
   */
  percentiles: {
    volume: number;
    volatility: number;
    move_24h: number;
    velocity: number;
  };
  z_scores: {
    volume: number;
    move_24h: number;
  };

  /** How much history backed these numbers. */
  sample: {
    points: number;
    span_hours: number;
    /** Observations backing the percentile comparisons. */
    distribution_points: number;
  };
}

/* ------------------------------------------------------------------ *
 * Book
 * ------------------------------------------------------------------ */

/**
 * Book statistics, which depend on whether the two sides are real.
 *
 * On an exchange like Polymarket, YES and NO are separate tokens with
 * separate books: four independent ladders, and "more size on YES than NO"
 * is a fact about what traders are waiting to do.
 *
 * On an exchange like Kalshi there is one matched ladder viewed from both
 * sides — the YES asks *are* the NO bids, restated. Summing all four ladders
 * there counts every resting order twice, which inflated depth into the
 * millions, and the YES/NO comparison becomes a quantity minus itself, which
 * is always zero. So the imbalance signal could never fire on that venue, and
 * the liquidity score it feeds was roughly double.
 *
 * For a linked book the meaningful imbalance is bids against asks on the one
 * ladder: which side is queuing, rather than which contract is popular.
 */
export function bookMetrics(book: OrderBook | null, independentSides = true): BookMetrics {
  if (!book) {
    return { yes_price: null, no_price: null, spread: null, depth: 0, notional: 0, imbalance: null };
  }
  const yesAsk = book.yes_asks[0]?.price ?? null;
  const yesBid = book.yes_bids[0]?.price ?? null;
  const noAsk = book.no_asks[0]?.price ?? null;

  const size = (levels: OrderBook['yes_asks']) => levels.reduce((s, l) => s + l.size, 0);
  const spread = yesAsk !== null && yesBid !== null ? yesAsk - yesBid : null;

  const notionalOf = (levels: OrderBook['yes_asks']) =>
    levels.reduce((s, l) => s + l.size * l.price, 0);

  if (!independentSides) {
    const bids = size(book.yes_bids);
    const asks = size(book.yes_asks);
    const total = bids + asks;
    return {
      yes_price: yesAsk,
      no_price: noAsk,
      spread,
      depth: total,
      notional: notionalOf(book.yes_bids) + notionalOf(book.yes_asks),
      imbalance: total > 0 ? (bids - asks) / total : null,
    };
  }

  const yesDepth = size(book.yes_asks) + size(book.yes_bids);
  const noDepth = size(book.no_asks) + size(book.no_bids);
  const total = yesDepth + noDepth;

  return {
    yes_price: yesAsk,
    no_price: noAsk,
    spread,
    depth: total,
    notional:
      notionalOf(book.yes_asks) +
      notionalOf(book.yes_bids) +
      notionalOf(book.no_asks) +
      notionalOf(book.no_bids),
    imbalance: total > 0 ? (yesDepth - noDepth) / total : null,
  };
}

/* ------------------------------------------------------------------ *
 * Series-derived
 * ------------------------------------------------------------------ */

/** Hour-over-hour price changes, used for volatility and velocity. */
function hourlyChanges(points: PricePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const dt = points[i]!.t - points[i - 1]!.t;
    if (dt <= 0) continue;
    // Normalize to an hourly rate so a venue's sampling interval does not
    // change the answer — one venue's hourly candle and another's five-minute
    // tick must produce comparable volatility.
    out.push(((points[i]!.price - points[i - 1]!.price) * HOUR) / dt);
  }
  return out;
}

function moveOver(history: MarketHistory, seconds: number): MoveMetrics | null {
  const now = latest(history);
  const then = priceAgo(history, seconds);
  if (!now || !then) return null;
  return { change: now.price - then.price, covered: then.covered };
}

/**
 * Share of absolute movement that occurred in above-median-volume periods.
 *
 * The distinction the whole scanner turns on: 20c to 40c on $900 of trading
 * is noise wearing a large number, and 48c to 55c on three million dollars is
 * information. Without this, the first one wins every ranking.
 */
function moveOnVolume(points: PricePoint[]): number | null {
  if (points.length < 4) return null;
  const volumes = points.map((p) => p.volume);
  if (volumes.every((v) => v === 0)) return null;
  const cut = median(volumes);

  let heavy = 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const move = Math.abs(points[i]!.price - points[i - 1]!.price);
    total += move;
    if (points[i]!.volume > cut) heavy += move;
  }
  return total > 0 ? heavy / total : null;
}

/** Net move over total travelled: 1 is a straight line, 0 is a round trip. */
function persistence(points: PricePoint[]): number | null {
  if (points.length < 3) return null;
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    travelled += Math.abs(points[i]!.price - points[i - 1]!.price);
  }
  if (travelled === 0) return null;
  const net = Math.abs(points[points.length - 1]!.price - points[0]!.price);
  return net / travelled;
}

/** Rolling 24h volume totals, for comparing today against this market's normal. */
function dailyVolumes(history: MarketHistory): number[] {
  const points = history.points;
  if (points.length === 0) return [];
  const buckets = new Map<number, number>();
  for (const p of points) {
    const day = Math.floor(p.t / DAY);
    buckets.set(day, (buckets.get(day) ?? 0) + p.volume);
  }
  return [...buckets.values()];
}

/** Trailing windows of the same width, for percentile comparison. */
function trailingWindows(history: MarketHistory, seconds: number): PricePoint[][] {
  const out: PricePoint[][] = [];
  const points = history.points;
  if (points.length === 0) return out;
  const first = points[0]!.t;
  const last = points[points.length - 1]!.t;
  for (let end = last; end - seconds >= first; end -= seconds) {
    const slice = points.filter((p) => p.t > end - seconds && p.t <= end);
    if (slice.length >= 2) out.push(slice);
  }
  return out;
}

export interface MetricsInput {
  market_id: string;
  venue: string;
  title: string;
  history: MarketHistory;
  book: OrderBook | null;
  /**
   * Whether YES and NO quote independently. False for a matched ladder viewed
   * from two sides, where the two are the same orders restated. Adapters
   * already declare this as `independent_two_sided_asks`.
   */
  independent_sides?: boolean;
  close_time: string | null;
  now?: number;
}

export function computeMetrics(input: MetricsInput): MarketMetrics {
  const { history } = input;
  const points = history.points;
  const now = latest(history);

  const day = window(history, DAY);
  const dayPrices = day.map((p) => p.price);
  const changes = hourlyChanges(day.length >= 3 ? day : points);

  const volumes24 = day.reduce((s, p) => s + p.volume, 0);
  // An all-zero series means the feed omits volume, not that nobody traded.
  const hasVolume = history.has_volume !== false && points.some((p) => p.volume > 0);
  const dailies = dailyVolumes(history);
  /**
   * A dormant contract has a median daily volume of roughly nothing, and
   * dividing today into roughly nothing produces "2,036x normal" — a number
   * that is arithmetically correct, useless, and corrosive to trust in every
   * other figure on the card. The denominator is floored at one contract, and
   * the fact that the baseline was negligible is reported separately as
   * dormancy, which is the honest description of what actually happened.
   */
  const rawBaseline = median(dailies.length > 1 ? dailies.slice(0, -1) : dailies);
  const baseline = Math.max(rawBaseline, 1);
  // A market averaging under twenty contracts a day is not "400x busier",
  // it is a market that woke up, and saying so reads far better than a
  // multiple whose denominator nobody can see.
  const dormant = rawBaseline < 20;

  const volatility = stdev(changes);
  const recent = window(history, 2 * HOUR);
  const recentChanges = hourlyChanges(recent);
  const velocity = recentChanges.length > 0 ? mean(recentChanges) : 0;

  // Historical distributions for the same statistics, so today can be placed
  // against this contract's own normal rather than a global threshold.
  const priorWindows = trailingWindows(history, DAY);
  const priorVolatility = priorWindows.map((w) => stdev(hourlyChanges(w)));
  const priorMoves = priorWindows.map((w) =>
    Math.abs(w[w.length - 1]!.price - w[0]!.price),
  );
  const priorVelocity = priorWindows.map((w) => {
    const c = hourlyChanges(w);
    return c.length > 0 ? Math.abs(mean(c)) : 0;
  });

  const move24 = moveOver(history, DAY);

  const spanHours =
    points.length >= 2 ? (points[points.length - 1]!.t - points[0]!.t) / HOUR : 0;

  return {
    market_id: input.market_id,
    venue: input.venue,
    title: input.title,

    price: now?.price ?? null,
    move_1h: moveOver(history, HOUR),
    move_6h: moveOver(history, 6 * HOUR),
    move_24h: move24,
    move_7d: moveOver(history, 7 * DAY),
    high_24h: dayPrices.length > 0 ? Math.max(...dayPrices) : null,
    low_24h: dayPrices.length > 0 ? Math.min(...dayPrices) : null,

    realized_volatility: volatility,
    velocity,
    move_on_volume: moveOnVolume(day),
    momentum_persistence: persistence(day),

    volume_24h: volumes24,
    volume_acceleration: hasVolume ? Math.min(volumes24 / baseline, 999) : null,
    was_dormant: hasVolume && dormant,
    has_volume_data: hasVolume,
    open_interest: now?.open_interest ?? null,

    book: bookMetrics(input.book, input.independent_sides ?? true),

    time_remaining_ms: input.close_time
      ? Date.parse(input.close_time) - (input.now ?? Date.now())
      : null,

    percentiles: {
      volume: hasVolume ? percentileOf(volumes24, dailies) : 0.5,
      volatility: percentileOf(volatility, priorVolatility),
      move_24h: percentileOf(Math.abs(move24?.change ?? 0), priorMoves),
      velocity: percentileOf(Math.abs(velocity), priorVelocity),
    },
    z_scores: {
      volume: zScore(volumes24, dailies),
      move_24h: zScore(Math.abs(move24?.change ?? 0), priorMoves),
    },

    sample: {
      points: points.length,
      span_hours: spanHours,
      // How many observations actually back the percentiles. A week of
      // hourly candles is 140 points but only seven daily volume buckets,
      // and it is the seven that decide whether "94th percentile" means
      // anything.
      distribution_points: Math.min(dailies.length, priorWindows.length || dailies.length),
    },
  };
}

/** Deci-cents as a probability-point move, which is how these read. */
export function toPoints(deciCents: DeciCents): number {
  return (deciCents / ONE_DOLLAR) * 100;
}
