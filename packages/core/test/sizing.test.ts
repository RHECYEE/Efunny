import { describe, expect, it } from 'vitest';
import { scan, unitsForBankroll } from '@arbterminal/core';
import { book, frozenNow, market, snapshot, zeroFees } from './helpers.js';

/**
 * Recommended sizes have to be placeable. A card advising "1315.99 units" or
 * half a contract per leg is not advice anybody can act on.
 */
describe('whole-number position sizing', () => {
  it('quotes a two-leg position in whole contracts', () => {
    const m = market({ venue: 'venue_a', venue_market_id: 'R1' });
    const result = scan(
      {
        events: [
          snapshot({}, [
            {
              market: m,
              book: book([[400, 10], [600, 500]], [[550, 500]]),
            },
          ]),
        ],
      },
      { fees: zeroFees('venue_a'), now: frozenNow },
    );
    const arb = result.opportunities[0]!;
    expect(Number.isInteger(arb.capacity)).toBe(true);
    for (const leg of arb.legs) expect(Number.isInteger(leg.contracts)).toBe(true);
    // Still profitable after rounding down — shrinking a position cannot
    // turn an arbitrage into a loss.
    expect(arb.net_edge).toBeGreaterThan(0);
  });

  it('sizes a NO basket so every leg holds whole contracts', () => {
    // Three outcomes means a unit is 1/2 a contract per leg, so positions are
    // quoted in lots of two units.
    const outcomes = ['A_WINS', 'B_WINS', 'C_WINS'];
    const markets = outcomes.map((outcome, i) =>
      market({ venue: 'venue_a', venue_market_id: `NB-${i}`, outcome, outcome_label: outcome }),
    );
    const result = scan(
      {
        events: [
          snapshot(
            { canonical_outcome_set: outcomes, exhaustive: false },
            markets.map((m) => ({ market: m, book: book([[380, 101]], [[640, 101]]) })),
          ),
        ],
      },
      { fees: zeroFees('venue_a'), now: frozenNow },
    );

    const basket = result.opportunities.find((o) => o.legs.every((l) => l.side === 'BUY_NO'))!;
    expect(basket).toBeDefined();
    for (const leg of basket.legs) expect(Number.isInteger(leg.contracts)).toBe(true);
    // A unit is half a contract, so the unit count comes in multiples of two.
    expect(basket.capacity % 2).toBe(0);
  });

  it('rounds a bankroll down to a placeable size', () => {
    const m = market({ venue: 'venue_a', venue_market_id: 'R3' });
    const result = scan(
      { events: [snapshot({}, [{ market: m, book: book([[400, 100]], [[550, 100]]) }])] },
      { fees: zeroFees('venue_a'), now: frozenNow },
    );
    const arb = result.opportunities[0]!;
    // $47.53 buys 50.03 units at 95c; the answer is 50, not 50.03.
    const units = unitsForBankroll(arb, 47_530);
    expect(Number.isInteger(units)).toBe(true);
    expect(units).toBe(50);
  });
});
