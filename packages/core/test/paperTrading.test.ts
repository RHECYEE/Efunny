import { describe, expect, it } from 'vitest';
import {
  executePaperTrade,
  portfolioStats,
  resolvePaperTrade,
  scan,
  summarizeCart,
  unitsForBankroll,
  type Opportunity,
} from '@arbterminal/core';
import { book, frozenNow, market, quote, snapshot, zeroFees } from './helpers.js';

const m = market({ venue: 'venue_a', venue_market_id: 'PT1' });

/** A 40c / 55c complementary arb: 5c of edge, 100 contracts deep. */
function detect(): { opportunity: Opportunity; detectionQuotes: ReturnType<typeof quote>[] } {
  const detectionBook = book([[400, 100]], [[550, 100]]);
  const result = scan(
    { events: [snapshot({}, [{ market: m, book: detectionBook }])] },
    { fees: zeroFees('venue_a'), now: frozenNow },
  );
  return {
    opportunity: result.opportunities[0]!,
    detectionQuotes: [quote(m.market_id, detectionBook)],
  };
}

describe('paper trade execution', () => {
  it('reports zero decay when the book has not moved', () => {
    const { opportunity, detectionQuotes } = detect();
    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([[400, 100]], [[550, 100]]))],
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });

    expect(trade.displayed_edge).toBe(50);
    expect(trade.actually_fillable_edge).toBe(50);
    expect(trade.edge_decay).toBe(0);
    expect(trade.fully_hedged).toBe(true);
    expect(trade.units_executed).toBeCloseTo(100, 6);
    expect(trade.decay_explanation).toContain('unchanged');
  });

  it('attributes lost edge to the price moving', () => {
    const { opportunity, detectionQuotes } = detect();
    // The YES ask ticked up 3c between detection and execution.
    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([[430, 100]], [[550, 100]]))],
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });

    expect(trade.actually_fillable_edge).toBe(20);
    expect(trade.edge_decay).toBe(30);
    expect(trade.simulated_fills.some((f) => f.shortfall_reason === 'PRICE_MOVED')).toBe(true);
    expect(trade.decay_explanation).toContain('0.4300');
  });

  it('attributes lost edge to insufficient size at the quoted price', () => {
    const { opportunity, detectionQuotes } = detect();
    // Same price, but only 10 of the 100 contracts are still there.
    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([[400, 10]], [[550, 100]]))],
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });

    expect(
      trade.simulated_fills.some((f) => f.shortfall_reason === 'INSUFFICIENT_SIZE_AT_QUOTE'),
    ).toBe(true);
    // The hedge is scaled to the weakest leg rather than left half-open.
    expect(trade.units_executed).toBeCloseTo(10, 6);
    expect(trade.fully_hedged).toBe(false);
    for (const fill of trade.simulated_fills) {
      expect(fill.held_contracts).toBeCloseTo(10, 6);
    }
    expect(trade.decay_explanation).toContain('scaled down');
  });

  it('records an abandoned trade when the book has emptied', () => {
    const { opportunity, detectionQuotes } = detect();
    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([], [[550, 100]]))],
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });

    expect(trade.units_executed).toBe(0);
    expect(trade.resolution).toBe('ABANDONED');
    expect(trade.actually_fillable_edge).toBe(0);
    expect(trade.edge_decay).toBe(trade.displayed_edge);
    expect(trade.decay_explanation).toContain('none of the displayed edge was real');
  });

  it('sizes to the bankroll rather than the full capacity', () => {
    const { opportunity, detectionQuotes } = detect();
    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([[400, 100]], [[550, 100]]))],
      bankroll: 9_500,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });
    expect(trade.units_executed).toBeCloseTo(10, 6);
    expect(trade.capital_deployed).toBeLessThanOrEqual(9_500);
    expect(trade.fully_hedged).toBe(true);
  });

  it('snapshots the book at both detection and execution', () => {
    const { opportunity, detectionQuotes } = detect();
    const executionQuotes = [quote(m.market_id, book([[430, 100]], [[550, 100]]))];
    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: executionQuotes,
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });

    expect(trade.quote_snapshot_at_detection.quotes[0]!.ask).toBe(400);
    expect(trade.quote_snapshot_at_execution.quotes[0]!.ask).toBe(430);
  });
});

describe('paper trade settlement', () => {
  it('pays the same either way on a fully hedged position', () => {
    const { opportunity, detectionQuotes } = detect();
    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([[400, 100]], [[550, 100]]))],
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });

    // Both legs are on the same market, so YES winning and NO winning are
    // the only two cases; a hedge must pay identically in both.
    const yesWins = resolvePaperTrade(trade, { winning_market_id: m.market_id });
    const noWins = resolvePaperTrade(trade, { winning_market_id: 'venue_a:SOMETHING_ELSE' });

    expect(yesWins.realized_pl).toBe(5_000);
    expect(noWins.realized_pl).toBe(5_000);
    expect(yesWins.resolution).toBe('WON');
  });

  it('returns stakes but not fees on a void', () => {
    const { opportunity, detectionQuotes } = detect();
    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([[400, 100]], [[550, 100]]))],
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });
    const voided = resolvePaperTrade(trade, { void: true });
    expect(voided.resolution).toBe('VOID');
    expect(voided.realized_pl).toBe(0);
  });
});

describe('cart aggregation', () => {
  it('aggregates capital, profit and return on deployed capital', () => {
    const { opportunity } = detect();
    const summary = summarizeCart([{ opportunity, units: 100 }]);

    expect(summary.entries).toBe(1);
    expect(summary.capital_required).toBe(95_000);
    expect(summary.modeled_profit).toBe(5_000);
    expect(summary.return_on_deployed_capital).toBeCloseTo(5_000 / 95_000, 6);
    expect(summary.guaranteed_entries).toBe(1);
  });

  it('caps an entry at the opportunity capacity', () => {
    const { opportunity } = detect();
    const summary = summarizeCart([{ opportunity, units: 100_000 }]);
    expect(summary.capital_required).toBe(95_000);
  });

  it('assumes an unhedged entry can lose its whole cost', () => {
    const { opportunity } = detect();
    const speculative: Opportunity = { ...opportunity, type: 'RELATIVE_VALUE' };
    const summary = summarizeCart([{ opportunity: speculative, units: 100 }]);
    expect(summary.worst_case_pl).toBe(-95_000);
    expect(summary.speculative_entries).toBe(1);
    expect(summary.warnings.some((w) => w.includes('not hedged'))).toBe(true);
  });

  it('computes units affordable from a bankroll', () => {
    const { opportunity } = detect();
    expect(unitsForBankroll(opportunity, 47_500)).toBeCloseTo(50, 6);
  });
});

describe('portfolio statistics', () => {
  it('reports what fraction of displayed edge survived to execution', () => {
    const { opportunity, detectionQuotes } = detect();
    const clean = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([[400, 100]], [[550, 100]]))],
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });
    const decayed = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: [quote(m.market_id, book([[430, 100]], [[550, 100]]))],
      bankroll: 95_000,
      fees: zeroFees('venue_a'),
      now: frozenNow,
    });

    const stats = portfolioStats([clean, decayed]);
    expect(stats.trades).toBe(2);
    // 50 displayed twice, 50 + 20 obtained.
    expect(stats.edge_capture_rate).toBeCloseTo(70 / 100, 6);
    expect(stats.shortfall_causes.PRICE_MOVED).toBe(1);
    expect(stats.fully_hedged_rate).toBe(1);
  });
});
