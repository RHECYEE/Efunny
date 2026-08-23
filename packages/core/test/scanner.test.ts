import { describe, expect, it } from 'vitest';
import {
  analyze,
  bookMetrics,
  computeMetrics,
  percentileOf,
  computeTradeMetrics,
  findCrossMarketGaps,
  rank,
  venueApiProvenance,
  type Market,
  type MarketHistory,
  type OrderBook,
  type Quote,
} from '../src/index.js';

const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);

/** A history with a given per-hour price path and volume. */
function history(prices: number[], volume: number, id = 'm1'): MarketHistory {
  return {
    market_id: id,
    venue: 'test',
    points: prices.map((price, i) => ({
      t: now - (prices.length - 1 - i) * HOUR,
      price,
      volume,
      open_interest: null,
    })),
  };
}

const book = (bid: number, ask: number, size: number): OrderBook => ({
  yes_asks: [{ price: ask, size }],
  yes_bids: [{ price: bid, size }],
  no_asks: [{ price: 1000 - bid, size }],
  no_bids: [{ price: 1000 - ask, size }],
});

describe('percentiles', () => {
  it('places a value inside its own distribution', () => {
    expect(percentileOf(5, [1, 2, 3, 4])).toBe(1);
    expect(percentileOf(0, [1, 2, 3, 4])).toBe(0);
    expect(percentileOf(2, [1, 2, 3, 4])).toBeCloseTo(0.375, 3);
  });

  it('does not report a constant series as extreme', () => {
    // A market that has never moved has not produced a surprising reading.
    expect(percentileOf(7, [7, 7, 7])).toBe(0.5);
  });
});

describe('book metrics', () => {
  it('does not double-count a linked ladder', () => {
    // Kalshi's YES asks are its NO bids restated. Counting all four ladders
    // reports twice the size that exists and an imbalance of exactly zero.
    const b = book(400, 410, 100);
    expect(bookMetrics(b, true).depth).toBe(400);
    expect(bookMetrics(b, false).depth).toBe(200);
    expect(bookMetrics(b, true).imbalance).toBe(0);
  });

  it('reads bid-vs-ask pressure on a linked ladder', () => {
    const b: OrderBook = {
      yes_asks: [{ price: 410, size: 10 }],
      yes_bids: [{ price: 400, size: 90 }],
      no_asks: [],
      no_bids: [],
    };
    expect(bookMetrics(b, false).imbalance).toBeCloseTo(0.8, 5);
  });
});

describe('scoring', () => {
  const flat = Array.from({ length: 24 * 30 }, () => 500);

  it('ranks a backed move above a bigger move on nothing', () => {
    // The distinction the scanner exists to make: 20c to 40c on almost no
    // volume is noise wearing a large number.
    const thin = computeMetrics({
      market_id: 'thin', venue: 'test', title: 'thin',
      history: history([...flat.slice(0, 700), 200, 300, 400], 1, 'thin'),
      book: book(390, 410, 5), independent_sides: false, close_time: null,
    });
    const deep = computeMetrics({
      market_id: 'deep', venue: 'test', title: 'deep',
      history: history([...flat.slice(0, 700), 500, 520, 550], 4000, 'deep'),
      book: book(548, 552, 40000), independent_sides: false, close_time: null,
    });
    const ordered = rank([analyze(thin), analyze(deep)]);
    expect(ordered[0]!.metrics.market_id).toBe('deep');
  });

  it('warns rather than scoring quietly when a book is thin', () => {
    const thin = analyze(
      computeMetrics({
        market_id: 'thin', venue: 'test', title: 'thin',
        history: history([...flat.slice(0, 700), 200, 300, 400], 1, 'thin'),
        book: book(300, 500, 3), independent_sides: false, close_time: null,
      }),
    );
    const kinds = thin.signals.map((s) => s.kind);
    expect(kinds).toContain('WIDE_SPREAD');
    expect(thin.scores.liquidity).toBeLessThan(40);
  });

  it('never produces a four-figure volume multiple', () => {
    // A dormant contract divided into almost nothing produced "2,036x".
    const woke = computeMetrics({
      market_id: 'woke', venue: 'test', title: 'woke',
      history: {
        market_id: 'woke', venue: 'test',
        points: Array.from({ length: 24 * 30 }, (_, i) => ({
          t: now - (24 * 30 - 1 - i) * HOUR,
          price: 500,
          volume: i > 24 * 29 ? 5000 : 0,
          open_interest: null,
        })),
      },
      book: book(495, 505, 100), independent_sides: false, close_time: null,
    });
    expect(woke.volume_acceleration!).toBeLessThanOrEqual(999);
    expect(woke.was_dormant).toBe(true);
  });

  it('does not call anything a bet', () => {
    const m = analyze(
      computeMetrics({
        market_id: 'x', venue: 'test', title: 'x',
        history: history(flat, 100), book: book(495, 505, 500),
        independent_sides: false, close_time: null,
      }),
    );
    expect(Object.keys(m.scores)).toContain('interestingness');
    expect(JSON.stringify(m.scores).toLowerCase()).not.toContain('bet');
    expect(JSON.stringify(m.scores).toLowerCase()).not.toContain('edge');
  });
});

describe('trade metrics', () => {
  const t = (size: number, side: 'YES' | 'NO' | null = null, block = false) => ({
    t: now, size, price: 500, taker_side: side, block,
  });

  it('does not saturate on skewed fill sizes', () => {
    // Fill sizes are heavily skewed: a median of 17 against a largest of
    // 52,000 is ordinary. Measuring concentration as "five times the median"
    // put every market at 99% and discriminated nothing.
    const spread = Array.from({ length: 100 }, () => t(20));
    const concentrated = [...Array.from({ length: 99 }, () => t(20)), t(100_000)];
    const a = computeTradeMetrics(spread)!;
    const b = computeTradeMetrics(concentrated)!;
    expect(a.concentration).toBeLessThan(0.25);
    expect(b.concentration).toBeGreaterThan(0.9);
  });

  it('reports the actual largest fill', () => {
    const m = computeTradeMetrics([t(10), t(5000), t(20), t(30)])!;
    expect(m.largest).toBe(5000);
    expect(m.large_trades[0]!.size).toBe(5000);
  });

  it('reads aggressor direction separately from the book', () => {
    const m = computeTradeMetrics([t(100, 'YES'), t(100, 'YES'), t(20, 'NO')])!;
    expect(m.taker_pressure).toBeGreaterThan(0.6);
  });

  it('says nothing when there are no fills', () => {
    expect(computeTradeMetrics([])).toBeNull();
  });
});

describe('liquidity in money', () => {
  it('does not rank a penny longshot above a real book on contract count', () => {
    // Forty-two million half-cent shares is $210k; a hundred thousand
    // fifty-cent contracts is $50k. A count ranks them 420:1.
    const penny = computeMetrics({
      market_id: 'p', venue: 'test', title: 'p',
      history: history(Array.from({ length: 24 * 30 }, () => 5), 10, 'p'),
      book: { yes_asks: [{ price: 5, size: 42_000_000 }], yes_bids: [], no_asks: [], no_bids: [] },
      independent_sides: false, close_time: null,
    });
    const real = computeMetrics({
      market_id: 'r', venue: 'test', title: 'r',
      history: history(Array.from({ length: 24 * 30 }, () => 500), 10, 'r'),
      book: { yes_asks: [{ price: 500, size: 100_000 }], yes_bids: [], no_asks: [], no_bids: [] },
      independent_sides: false, close_time: null,
    });
    // Both are large books; neither should be four hundred times the other.
    const ratio = penny.book.notional / real.book.notional;
    expect(ratio).toBeLessThan(6);
    expect(ratio).toBeGreaterThan(1);
  });
});

describe('cross-market gaps', () => {
  const mk = (venue: string, outcome: string, ask: number): { market: Market; quote: Quote } => {
    const market: Market = {
      market_id: `${venue}:${outcome}`, event_id: 'E', venue, venue_market_id: outcome,
      outcome: outcome.toUpperCase().replace(/\s+/g, '_'), outcome_label: outcome,
      market_type: 'SCALAR_THRESHOLD', tier: 'NON_SPORT', line: null,
      comparison_operator: 'GT', threshold: 100000,
      settlement: { settlement_source: 'Index', settlement_rules_text: '', void_rules: '', overtime_rules: '' },
      jurisdiction: 'US', currency: 'USD', match_confidence: 0, title: 'BTC above 100k',
      status: 'OPEN', close_time: '2027-01-01T00:00:00Z', payout_per_contract: 1000,
      provenance: venueApiProvenance(venue),
    };
    return {
      market,
      quote: {
        quote_id: 'q', market_id: market.market_id, bid: ask - 10, ask,
        no_bid: null, no_ask: 1000 - ask, implied_probability: ask / 1000,
        liquidity: 100,
        book: {
          yes_asks: [{ price: ask, size: 100 }], yes_bids: [{ price: ask - 10, size: 100 }],
          no_asks: [], no_bids: [],
        },
        timestamp: '2026-08-23T00:00:00Z',
      },
    };
  };

  it('finds the same proposition priced apart on two venues', () => {
    const gaps = findCrossMarketGaps([mk('kalshi', 'Above $100,000', 300), mk('polymarket', 'Above $100,000', 420)]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.gap).toBe(120);
    expect(gaps[0]!.cheaper_venue).toBe('kalshi');
  });

  it('will not call two different contracts a disagreement', () => {
    const other = mk('polymarket', 'Above $100,000', 420);
    other.market.threshold = 120000;
    expect(findCrossMarketGaps([mk('kalshi', 'Above $100,000', 300), other])).toHaveLength(0);
  });

  it('ignores a gap inside the tick noise', () => {
    expect(findCrossMarketGaps([mk('kalshi', 'Above $100,000', 300), mk('polymarket', 'Above $100,000', 305)])).toHaveLength(0);
  });
});
