import { describe, expect, it } from 'vitest';
import {
  scan,
  verifyMatch,
  type ArbEngineOptions,
  type Opportunity,
} from '@arbterminal/core';
import {
  FlatFeeModel,
  book,
  feeBook,
  frozenNow,
  market,
  quote,
  settlement,
  snapshot,
  zeroFees,
} from './helpers.js';

const baseOptions = (overrides: Partial<ArbEngineOptions> = {}): ArbEngineOptions => ({
  fees: zeroFees('venue_a', 'venue_b'),
  now: frozenNow,
  min_capacity_units: 1,
  ...overrides,
});

function only(opportunities: Opportunity[], type: Opportunity['type']): Opportunity[] {
  return opportunities.filter((o) => o.type === type);
}

describe('complementary single-market arbitrage', () => {
  it('finds a guaranteed arb when both sides cost less than the dollar they pay', () => {
    const m = market({ venue: 'venue_a', venue_market_id: 'M1' });
    const result = scan(
      {
        events: [snapshot({}, [{ market: m, book: book([[400, 100]], [[550, 100]]) }])],
      },
      baseOptions(),
    );

    const arbs = only(result.opportunities, 'GUARANTEED_ARB');
    expect(arbs).toHaveLength(1);
    const arb = arbs[0]!;
    // 40c + 55c = 95c buys $1.00 of payout.
    expect(arb.gross_edge).toBe(50);
    expect(arb.net_edge).toBe(50);
    expect(arb.gross_roi).toBeCloseTo(50 / 950, 6);
    expect(arb.capacity).toBe(100);
    expect(arb.capacity_capital).toBe(95_000);
    expect(arb.match_confidence).toBe(1);
    expect(arb.venues).toEqual(['venue_a']);
  });

  it('finds nothing when the two sides sum to a dollar or more', () => {
    const m = market({ venue: 'venue_a', venue_market_id: 'M2' });
    const result = scan(
      { events: [snapshot({}, [{ market: m, book: book([[450, 100]], [[550, 100]]) }])] },
      baseOptions(),
    );
    expect(only(result.opportunities, 'GUARANTEED_ARB')).toHaveLength(0);
  });

  it('demotes to NEAR_ARB when fees eat the spread', () => {
    const m = market({ venue: 'venue_a', venue_market_id: 'M3' });
    const result = scan(
      { events: [snapshot({}, [{ market: m, book: book([[480, 100]], [[515, 100]]) }])] },
      // 5 dc per contract on each of two legs = 10 dc, against a 5 dc spread.
      baseOptions({ fees: feeBook(new FlatFeeModel('venue_a', 5)) }),
    );

    const near = only(result.opportunities, 'NEAR_ARB');
    expect(near).toHaveLength(1);
    expect(near[0]!.gross_edge).toBe(5);
    expect(near[0]!.net_edge).toBeLessThan(0);
    expect(only(result.opportunities, 'GUARANTEED_ARB')).toHaveLength(0);
  });

  it('sizes down to the depth that stays profitable after slippage', () => {
    const m = market({ venue: 'venue_a', venue_market_id: 'M4' });
    const result = scan(
      {
        events: [
          snapshot({}, [
            {
              market: m,
              // 10 contracts are cheap; the rest of the ladder is not.
              book: book(
                [
                  [400, 10],
                  [600, 500],
                ],
                [[550, 500]],
              ),
            },
          ]),
        ],
      },
      baseOptions(),
    );

    const arb = only(result.opportunities, 'GUARANTEED_ARB')[0]!;
    // Sizing is on average cost, so the position runs past the 10 cheap
    // contracts: 10 @ 40c plus ~3.2 @ 60c averages 44.9c, and 44.9 + 55 is
    // still under a dollar. It stops before the average reaches break-even.
    expect(arb.capacity).toBeGreaterThan(10);
    expect(arb.capacity).toBeLessThan(13.34);
    expect(arb.slippage).toBeGreaterThan(0);
    expect(arb.net_edge).toBeGreaterThan(0);
    // The whole position must still cost less than the dollar it pays.
    expect(arb.unit_cost).toBeLessThan(1000);
  });
});

describe('mutually exclusive baskets', () => {
  const outcomes = ['A_WINS', 'B_WINS', 'C_WINS'];
  const markets = outcomes.map((outcome, index) =>
    market({
      venue: 'venue_a',
      venue_market_id: `BASKET-${index}`,
      outcome,
      outcome_label: outcome,
    }),
  );

  it('will not treat a YES basket as arbitrage unless the outcomes are exhaustive', () => {
    // Three outcomes at 30c each cost 90c, but if none of them happens every
    // leg expires worthless. That is not a hedge.
    const cheap = markets.map((m) => ({ market: m, book: book([[300, 100]], [[720, 100]]) }));
    const result = scan(
      {
        events: [
          snapshot(
            { canonical_outcome_set: outcomes, exhaustive: false },
            cheap,
          ),
        ],
      },
      baseOptions(),
    );
    expect(only(result.opportunities, 'GUARANTEED_ARB')).toHaveLength(0);
  });

  it('finds the YES basket once the outcome set is exhaustive', () => {
    const cheap = markets.map((m) => ({ market: m, book: book([[300, 100]], [[720, 100]]) }));
    const result = scan(
      {
        events: [snapshot({ canonical_outcome_set: outcomes, exhaustive: true }, cheap)],
      },
      baseOptions(),
    );

    const arb = only(result.opportunities, 'GUARANTEED_ARB').find((o) => o.legs.length === 3);
    expect(arb).toBeDefined();
    // 3 x 30c = 90c for a guaranteed $1.00.
    expect(arb!.gross_edge).toBe(100);
    expect(arb!.legs.every((l) => l.side === 'BUY_YES')).toBe(true);
  });

  it('finds a NO basket under mutual exclusivity alone', () => {
    // Buying NO on all three: at most one resolves YES, so at least two pay.
    // 3 x 64c = 192c for a guaranteed $2.00 payout.
    const cheap = markets.map((m) => ({ market: m, book: book([[380, 100]], [[640, 100]]) }));
    const result = scan(
      {
        events: [snapshot({ canonical_outcome_set: outcomes, exhaustive: false }, cheap)],
      },
      baseOptions(),
    );

    const arb = only(result.opportunities, 'GUARANTEED_ARB').find((o) =>
      o.legs.every((l) => l.side === 'BUY_NO'),
    );
    expect(arb).toBeDefined();
    // Per $1 of guaranteed payout: 192c / 2 = 96c, so 4c of edge.
    expect(arb!.gross_edge).toBe(40);
    // A unit holds 1/(N-1) = 0.5 contracts of each leg.
    for (const leg of arb!.legs) {
      expect(leg.contracts / arb!.capacity).toBeCloseTo(0.5, 6);
    }
    expect(arb!.warnings.some((w) => w.includes('not known to be exhaustive'))).toBe(true);
  });

  it('will not build a basket when an outcome is closed', () => {
    const withClosed = markets.map((m, i) => ({
      market: i === 0 ? market({ ...m, status: 'CLOSED' }) : m,
      book: book([[300, 100]], [[720, 100]]),
    }));
    const result = scan(
      {
        events: [snapshot({ canonical_outcome_set: outcomes, exhaustive: true }, withClosed)],
      },
      baseOptions(),
    );
    expect(only(result.opportunities, 'GUARANTEED_ARB')).toHaveLength(0);
  });

  it('will not build a YES basket from a partial outcome set', () => {
    const partial = markets.slice(0, 2).map((m) => ({
      market: m,
      book: book([[300, 100]], [[720, 100]]),
    }));
    const result = scan(
      {
        events: [
          // The event declares three outcomes but only two are present.
          snapshot({ canonical_outcome_set: outcomes, exhaustive: true }, partial),
        ],
      },
      baseOptions(),
    );
    const yesBasket = only(result.opportunities, 'GUARANTEED_ARB').find((o) =>
      o.legs.every((l) => l.side === 'BUY_YES'),
    );
    expect(yesBasket).toBeUndefined();
  });

  it('ignores a divergence manufactured by wide bid-ask spreads', () => {
    // Quoted 2c bid / 90c ask, the midpoint is 46c and means nothing. Summed
    // across three outcomes that is an "overround" of 0.38 built entirely out
    // of spread width, with no disagreement about the outcome behind it.
    const wide = markets.map((m) => ({ market: m, book: book([[900, 50]], [[980, 50]]) }));
    const result = scan(
      {
        events: [snapshot({ canonical_outcome_set: outcomes, exhaustive: true }, wide)],
      },
      baseOptions(),
    );
    expect(only(result.opportunities, 'RELATIVE_VALUE')).toHaveLength(0);
  });

  it('reports probability divergence as relative value, never as arbitrage', () => {
    // Tightly quoted at 33c/43c, so the 38c mids are meaningful. They sum to
    // 1.14 across three outcomes that can jointly be worth only 1.00, yet
    // neither basket clears at the ask: 3 x 43c YES exceeds $1, and 3 x 67c
    // NO exceeds the $2 it would pay.
    const wide = markets.map((m) => ({ market: m, book: book([[430, 50]], [[670, 50]]) }));
    const result = scan(
      {
        events: [snapshot({ canonical_outcome_set: outcomes, exhaustive: true }, wide)],
      },
      baseOptions(),
    );
    const rv = only(result.opportunities, 'RELATIVE_VALUE');
    expect(rv.length).toBeGreaterThan(0);
    expect(rv[0]!.warnings.some((w) => w.includes('No guaranteed hedge'))).toBe(true);
    expect(only(result.opportunities, 'GUARANTEED_ARB')).toHaveLength(0);
  });
});

describe('cross-venue arbitrage', () => {
  const left = market({ venue: 'venue_a', venue_market_id: 'X1' });
  const right = market({ venue: 'venue_b', venue_market_id: 'X2' });

  function scanCross(
    leftBook: ReturnType<typeof book>,
    rightBook: ReturnType<typeof book>,
    rightMarket = right,
    options = baseOptions(),
  ) {
    const match = verifyMatch(left, rightMarket, 'EXACT');
    return {
      match,
      result: scan(
        {
          events: [
            {
              event: snapshot({}, []).event,
              markets: [
                { market: left, quote: quote(left.market_id, leftBook) },
                { market: rightMarket, quote: quote(rightMarket.market_id, rightBook) },
              ],
            },
          ],
          matches: [match],
        },
        options,
      ),
    };
  }

  it('buys YES on one venue and NO on the other when they sum below a dollar', () => {
    const { result } = scanCross(book([[400, 100]], [[620, 100]]), book([[420, 100]], [[560, 100]]));
    const arb = only(result.opportunities, 'CROSS_VENUE_ARB')[0];
    expect(arb).toBeDefined();
    // 40c YES on venue_a + 56c NO on venue_b = 96c.
    expect(arb!.gross_edge).toBe(40);
    expect(arb!.venues).toEqual(['venue_a', 'venue_b']);
    expect(arb!.legs.map((l) => l.side).sort()).toEqual(['BUY_NO', 'BUY_YES']);
  });

  it('never emits arbitrage on a match below the confidence floor', () => {
    const contradictory = market({
      venue: 'venue_b',
      venue_market_id: 'X3',
      settlement: settlement({ overtime_rules: 'Regulation time only; overtime does not count.' }),
    });
    const withOvertime = market({
      venue: 'venue_a',
      venue_market_id: 'X1',
      settlement: settlement({ overtime_rules: 'Includes overtime.' }),
    });
    const match = verifyMatch(withOvertime, contradictory, 'EXACT');
    expect(match.confidence).toBeLessThan(0.8);

    const result = scan(
      {
        events: [
          {
            event: snapshot({}, []).event,
            markets: [
              {
                market: withOvertime,
                quote: quote(withOvertime.market_id, book([[400, 100]], [[620, 100]])),
              },
              {
                market: contradictory,
                quote: quote(contradictory.market_id, book([[420, 100]], [[560, 100]])),
              },
            ],
          },
        ],
        matches: [match],
      },
      baseOptions(),
    );
    expect(only(result.opportunities, 'CROSS_VENUE_ARB')).toHaveLength(0);
  });

  it('withholds a reserve when the settlement wording differs', () => {
    const differentSource = market({
      venue: 'venue_b',
      venue_market_id: 'X4',
      settlement: settlement({ settlement_source: 'Reuters race call' }),
    });
    const { match, result } = scanCross(
      book([[400, 100]], [[620, 100]]),
      book([[420, 100]], [[560, 100]]),
      differentSource,
    );

    expect(match.confidence).toBeLessThan(1);
    const arb = result.opportunities.find((o) => o.venues.length === 2)!;
    expect(arb.settlement_mismatch_reserve).toBeGreaterThan(0);
    expect(arb.net_edge).toBeLessThan(arb.gross_edge);
    // The reserve is visible as its own line of the cost stack.
    const line = arb.cost_stack.find((c) => c.label === 'Settlement mismatch reserve');
    expect(line?.amount).toBe(-arb.settlement_mismatch_reserve);
  });
});

describe('cost stack', () => {
  it('reconciles exactly to the executable edge', () => {
    const m = market({ venue: 'venue_a', venue_market_id: 'CS1' });
    const result = scan(
      { events: [snapshot({}, [{ market: m, book: book([[400, 100]], [[550, 100]]) }])] },
      baseOptions({ fees: feeBook(new FlatFeeModel('venue_a', 2)) }),
    );
    const arb = result.opportunities[0]!;
    const summed = arb.cost_stack.reduce((total, entry) => total + entry.amount, 0);
    expect(Math.round(summed)).toBe(arb.net_edge);
  });

  it('warns when a venue has no declared fee schedule', () => {
    const m = market({ venue: 'venue_unknown', venue_market_id: 'CS2' });
    const result = scan(
      { events: [snapshot({}, [{ market: m, book: book([[400, 100]], [[550, 100]]) }])] },
      baseOptions({ fees: feeBook() }),
    );
    expect(result.opportunities[0]!.warnings.some((w) => w.includes('No fee schedule'))).toBe(true);
  });
});
