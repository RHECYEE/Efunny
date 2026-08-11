import { ONE_DOLLAR, roundHalfAway, type DeciCents, type Money } from '../domain/money.js';
import { decimalToContractPrice } from '../normalize/odds.js';

/**
 * Stake sizing for a sportsbook <-> event-contract hedge.
 *
 * The two instruments pay differently and the user must never be asked to
 * reconcile that by hand:
 *
 *   - An event contract costs `p` and pays a fixed $1.00 if it wins.
 *   - A sportsbook bet at decimal odds `D` returns `stake * D` — the stake
 *     comes back *with* the profit, so its true cost per $1 of return is 1/D.
 *
 * Hedging N contracts on outcome X against a sportsbook bet on not-X:
 *
 *   outlay          = N*p + S
 *   payoff if X     = N*1                -> profit = N - N*p - S
 *   payoff if not-X = S*D                -> profit = S*D - N*p - S
 *
 * Setting the two branches equal:
 *
 *   N - N*p - S = S*D - N*p - S   ->   N = S*D   ->   S = N / D
 *
 * so the balanced stake is N/D dollars, and the guaranteed profit is
 * N * (1 - p - 1/D). Note 1/D is exactly the sportsbook's vig-inclusive
 * implied probability, which is why this reduces to comparing contract
 * prices once the odds are converted.
 */

export interface HedgeInput {
  /** Price of one event contract on the prediction market, in deci-cents. */
  contract_price: DeciCents;
  /** Sportsbook decimal odds on the opposite outcome. */
  sportsbook_decimal_odds: number;
  /** Number of event contracts to hold. */
  contracts: number;
  /** Commission on the sportsbook leg as a fraction of *profit*, e.g. 0.02. Usually 0. */
  sportsbook_commission?: number;
  /** Fees on the contract leg, in deci-cents, total (not per contract). */
  contract_fees?: Money;
}

export interface HedgeSolution {
  contracts: number;
  /** Stake to place at the sportsbook, in deci-cents. Rounded to the cent. */
  sportsbook_stake: Money;
  /** Exact unrounded stake, for showing how much rounding cost. */
  sportsbook_stake_exact: number;
  contract_outlay: Money;
  contract_fees: Money;
  total_outlay: Money;
  /** Net profit if the event contract wins. */
  profit_if_contract_wins: Money;
  /** Net profit if the sportsbook bet wins. */
  profit_if_book_wins: Money;
  /** The worse branch — the only number that is actually guaranteed. */
  guaranteed_profit: Money;
  guaranteed_roi: number;
  /** True when both branches pay within one cent of each other. */
  balanced: boolean;
  /** Cost of $1 of payout across both legs, in deci-cents. Arb iff < 1000. */
  combined_cost_per_dollar: DeciCents;
  /** The sportsbook leg restated as a contract price, for side-by-side display. */
  sportsbook_implied_price: DeciCents;
}

/** Stakes are placed in whole cents; deci-cent precision is not executable. */
function roundToCent(deciCents: number): Money {
  return roundHalfAway(deciCents / 10) * 10;
}

export function solveHedge(input: HedgeInput): HedgeSolution {
  const {
    contract_price: price,
    sportsbook_decimal_odds: odds,
    contracts,
    sportsbook_commission: commission = 0,
    contract_fees: fees = 0,
  } = input;

  if (odds <= 1) throw new RangeError(`decimal odds must exceed 1, got ${odds}`);
  if (contracts < 0) throw new RangeError(`contracts must be non-negative, got ${contracts}`);

  // The bet's *total* return is stake * netOddsMultiplier (stake comes back
  // with the profit). Commission is charged on winnings only, so it shrinks
  // the multiplier and therefore raises the stake needed to return N.
  const netOddsMultiplier = 1 + (odds - 1) * (1 - commission);
  // Branch equality gives N = S * netOddsMultiplier, hence S = N / netMult.
  const exactStake = (contracts * ONE_DOLLAR) / netOddsMultiplier;
  const stake = roundToCent(exactStake);

  const contractOutlay = roundHalfAway(contracts * price);
  const totalOutlay = contractOutlay + stake + fees;

  // Branch 1: contract wins, sportsbook bet loses entirely.
  const profitIfContractWins = roundHalfAway(contracts * ONE_DOLLAR) - totalOutlay;
  // Branch 2: sportsbook bet wins, contracts expire worthless.
  const bookReturn = roundHalfAway(stake * netOddsMultiplier);
  const profitIfBookWins = bookReturn - totalOutlay;

  const guaranteed = Math.min(profitIfContractWins, profitIfBookWins);

  return {
    contracts,
    sportsbook_stake: stake,
    sportsbook_stake_exact: exactStake,
    contract_outlay: contractOutlay,
    contract_fees: fees,
    total_outlay: totalOutlay,
    profit_if_contract_wins: profitIfContractWins,
    profit_if_book_wins: profitIfBookWins,
    guaranteed_profit: guaranteed,
    guaranteed_roi: totalOutlay > 0 ? guaranteed / totalOutlay : 0,
    balanced: Math.abs(profitIfContractWins - profitIfBookWins) <= 10,
    combined_cost_per_dollar: price + decimalToContractPrice(odds),
    sportsbook_implied_price: decimalToContractPrice(odds),
  };
}

/**
 * Same hedge, sized to a capital budget instead of a contract count. Solves
 * for the largest N whose total outlay fits `budget`.
 */
export function solveHedgeForBudget(
  input: Omit<HedgeInput, 'contracts' | 'contract_fees'> & { budget: Money },
): HedgeSolution {
  const { budget, contract_price: price, sportsbook_decimal_odds: odds } = input;
  const commission = input.sportsbook_commission ?? 0;
  const netOddsMultiplier = 1 + (odds - 1) * (1 - commission);
  // outlay(N) = N*price + N*1000/mult; solve outlay(N) = budget.
  const perContractOutlay = price + ONE_DOLLAR / netOddsMultiplier;
  const contracts = perContractOutlay > 0 ? Math.floor(budget / perContractOutlay) : 0;
  return solveHedge({ ...input, contracts: Math.max(0, contracts) });
}
