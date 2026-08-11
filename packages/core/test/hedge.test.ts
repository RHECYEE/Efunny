import { describe, expect, it } from 'vitest';
import { solveHedge, solveHedgeForBudget } from '@arbterminal/core';

/**
 * The stake solver is the piece the user must never be asked to do by hand:
 * a sportsbook returns stake + profit, an event contract pays a flat $1, and
 * the two have to be sized so both branches pay the same.
 */
describe('sportsbook <-> event-contract hedge solver', () => {
  it('balances both branches so the profit is the same either way', () => {
    // 100 contracts at 40c, hedged with decimal 2.5 (= +150) on the other side.
    const solution = solveHedge({
      contract_price: 400,
      sportsbook_decimal_odds: 2.5,
      contracts: 100,
    });

    // Balanced stake is N/D = 100/2.5 = $40.00.
    expect(solution.sportsbook_stake).toBe(40_000);
    expect(solution.balanced).toBe(true);
    expect(solution.profit_if_contract_wins).toBe(solution.profit_if_book_wins);

    // Outlay 100*0.40 + 40 = $80; either branch returns $100.
    expect(solution.total_outlay).toBe(80_000);
    expect(solution.guaranteed_profit).toBe(20_000);
    expect(solution.guaranteed_roi).toBeCloseTo(0.25, 10);
  });

  it('agrees with the contract-price shortcut', () => {
    // 1/D is exactly the sportsbook's implied probability, so the combined
    // cost of $1 of payout must equal price + 1/D.
    const solution = solveHedge({
      contract_price: 400,
      sportsbook_decimal_odds: 2.5,
      contracts: 100,
    });
    expect(solution.sportsbook_implied_price).toBe(400);
    expect(solution.combined_cost_per_dollar).toBe(800);
    expect(solution.combined_cost_per_dollar).toBeLessThan(1000);
  });

  it('reports a loss rather than hiding it when no edge exists', () => {
    // 55c contract against decimal 1.9 (52.6c) costs more than $1 of payout.
    const solution = solveHedge({
      contract_price: 550,
      sportsbook_decimal_odds: 1.9,
      contracts: 100,
    });
    expect(solution.combined_cost_per_dollar).toBeGreaterThan(1000);
    expect(solution.guaranteed_profit).toBeLessThan(0);
  });

  it('takes the worse branch as the guarantee when rounding unbalances it', () => {
    // An odd stake cannot be placed to the deci-cent, so the branches differ.
    const solution = solveHedge({
      contract_price: 333,
      sportsbook_decimal_odds: 1.47,
      contracts: 7,
    });
    expect(solution.guaranteed_profit).toBe(
      Math.min(solution.profit_if_contract_wins, solution.profit_if_book_wins),
    );
    expect(solution.sportsbook_stake % 10).toBe(0);
  });

  it('raises the stake to cover commission charged on winnings', () => {
    const plain = solveHedge({
      contract_price: 400,
      sportsbook_decimal_odds: 2.5,
      contracts: 100,
    });
    const commissioned = solveHedge({
      contract_price: 400,
      sportsbook_decimal_odds: 2.5,
      contracts: 100,
      sportsbook_commission: 0.05,
    });
    expect(commissioned.sportsbook_stake).toBeGreaterThan(plain.sportsbook_stake);
    expect(commissioned.guaranteed_profit).toBeLessThan(plain.guaranteed_profit);
    expect(commissioned.balanced).toBe(true);
  });

  it('subtracts contract-side fees from the guarantee', () => {
    const withFees = solveHedge({
      contract_price: 400,
      sportsbook_decimal_odds: 2.5,
      contracts: 100,
      contract_fees: 1_500,
    });
    expect(withFees.guaranteed_profit).toBe(20_000 - 1_500);
  });

  it('sizes to a capital budget without exceeding it', () => {
    const solution = solveHedgeForBudget({
      contract_price: 400,
      sportsbook_decimal_odds: 2.5,
      budget: 50_000,
    });
    expect(solution.total_outlay).toBeLessThanOrEqual(50_000);
    expect(solution.contracts).toBe(62);
  });

  it('rejects odds that cannot exist', () => {
    expect(() =>
      solveHedge({ contract_price: 400, sportsbook_decimal_odds: 1, contracts: 10 }),
    ).toThrow(RangeError);
  });
});
