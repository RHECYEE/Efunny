import { describe, expect, it } from 'vitest';
import { allocate, arbStatus, explainNoArbitrage, scan, type Opportunity } from '@arbterminal/core';
import { book, frozenNow, market, snapshot, zeroFees } from './helpers.js';

/** A 40c / 55c hedge: 5c of edge per $1, 100 contracts deep. */
function arb(): Opportunity {
  const m = market({ venue: 'venue_a', venue_market_id: 'AL1' });
  return scan(
    { events: [snapshot({}, [{ market: m, book: book([[400, 100]], [[550, 100]]) }])] },
    { fees: zeroFees('venue_a'), now: frozenNow },
  ).opportunities[0]!;
}

describe('turning an opportunity into an instruction', () => {
  it('splits a bankroll across the two sides in whole dollars', () => {
    const allocation = allocate(arb(), 95_000);

    expect(allocation.ok).toBe(true);
    expect(allocation.legs).toHaveLength(2);
    // 40c and 55c a contract on a $95 bankroll: $40 one side, $55 the other.
    expect(allocation.legs.map((l) => l.stake)).toEqual([40_000, 55_000]);
    expect(allocation.total_stake).toBe(95_000);
    for (const leg of allocation.legs) {
      expect(leg.stake % 1000).toBe(0);
      expect(Number.isInteger(leg.contracts)).toBe(true);
    }
  });

  it('reports the profit that survives whichever way it resolves', () => {
    const allocation = allocate(arb(), 95_000);
    // 100 units pay $100 however it lands, against $95 in.
    expect(allocation.guaranteed_return).toBe(100_000);
    expect(allocation.guaranteed_profit).toBe(5_000);
    expect(allocation.return_fraction).toBeCloseTo(5_000 / 95_000, 6);
  });

  it('takes the worst branch, not the average, when rounding unbalances the sides', () => {
    // The guarantee must never assume the friendlier outcome. Whatever the
    // rounding did, the number shown has to hold for every resolution.
    const allocation = allocate(arb(), 47_530);
    const perOutcome = allocation.legs.map((l) => l.contracts * 1000);
    expect(allocation.guaranteed_return).toBe(Math.min(...perOutcome));
    expect(allocation.guaranteed_profit).toBe(
      allocation.guaranteed_return - allocation.total_stake,
    );
  });

  it('never deploys more than the bankroll', () => {
    for (const bankroll of [1_000, 7_777, 33_333, 95_000]) {
      const allocation = allocate(arb(), bankroll);
      expect(allocation.total_stake).toBeLessThanOrEqual(bankroll);
    }
  });

  it('caps at available liquidity and says so', () => {
    const allocation = allocate(arb(), 10_000_000);
    expect(allocation.capped_by_liquidity).toBe(true);
    expect(allocation.total_stake).toBeLessThan(10_000_000);
  });

  it('explains rather than failing silently when the bankroll is too small', () => {
    const allocation = allocate(arb(), 100);
    expect(allocation.ok).toBe(false);
    expect(allocation.reason).toContain('more than this bankroll');
  });
});

describe('cross-venue guarantees', () => {
  it('does not invent a world where one venue wins and the other loses', () => {
    // Both legs resolve on the same proposition at different venues. Treating
    // their market ids as separate outcomes conjures an impossible case that
    // pays nothing — which reported a real arbitrage as a total loss.
    const base = arb();
    const crossVenue: Opportunity = {
      ...base,
      venues: ['draftkings', 'kalshi'],
      legs: [
        { ...base.legs[0]!, venue: 'kalshi', market_id: 'kalshi:K1', outcome: 'ABOVE_WINS' },
        {
          ...base.legs[1]!,
          venue: 'draftkings',
          market_id: 'draftkings:D1',
          outcome: 'ABOVE_WINS',
        },
      ],
    };

    const allocation = allocate(crossVenue, 95_000);
    expect(allocation.guaranteed_return).toBeGreaterThan(0);
    expect(allocation.guaranteed_profit).toBeGreaterThan(0);
    expect(allocation.return_fraction).toBeGreaterThan(0);
  });

  it('still pays out when the position is a single-venue two-sided hedge', () => {
    const allocation = allocate(arb(), 95_000);
    expect(allocation.guaranteed_return).toBe(100_000);
  });
});

describe('three statuses, not five grades', () => {
  it('maps the engine grading onto what a user can act on', () => {
    const base = arb();
    expect(arbStatus({ ...base, assurance: 'CERTIFIED' })).toBe('ARBITRAGE');
    expect(arbStatus({ ...base, assurance: 'QUALIFIED_CANDIDATE' })).toBe('POSSIBLE');
    // Everything the engine distinguishes below this collapses: none of it
    // changes what somebody does next.
    expect(arbStatus({ ...base, assurance: 'DISQUALIFIED' })).toBe('NONE');
    expect(arbStatus({ ...base, assurance: 'NOT_PROFITABLE' })).toBe('NONE');
    expect(arbStatus({ ...base, assurance: 'INFORMATIONAL' })).toBe('NONE');
  });

  it('explains a dead end without naming an internal category', () => {
    const base = arb();
    const disqualified = explainNoArbitrage({ ...base, assurance: 'DISQUALIFIED' });
    expect(disqualified).toContain('both sides can lose together');
    expect(disqualified).not.toMatch(/DISQUALIFIED|RELATIVE_VALUE|assurance/);

    const unprofitable = explainNoArbitrage({ ...base, assurance: 'NOT_PROFITABLE' });
    expect(unprofitable).toContain('fees');
    expect(unprofitable).not.toMatch(/NOT_PROFITABLE|net_edge/);
  });
});
