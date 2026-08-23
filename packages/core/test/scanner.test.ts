import { describe, expect, it } from 'vitest';
import {
  analyze,
  bookMetrics,
  computeMetrics,
  percentileOf,
  rank,
  type MarketHistory,
  type OrderBook,
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
