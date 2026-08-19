import { ONE_DOLLAR, roundHalfAway, type DeciCents, type Money } from '../domain/money.js';
import type { Opportunity } from '../domain/types.js';

/**
 * Turning an opportunity into an instruction.
 *
 * Everything else in this package answers "is there an edge, and how far can I
 * trust it". This answers the only question a user actually has once the
 * answer is yes: *what do I do* — how much money goes on each side, and what
 * comes back.
 *
 * The guaranteed return is computed by checking every way the event can
 * resolve and taking the worst one. That matters because the stakes are
 * rounded to whole dollars: rounding leaves the two sides slightly unequal,
 * so one branch pays a little less than the other, and the smaller number is
 * the only one that is actually guaranteed.
 */

export type ArbStatus =
  /** Both outcomes are demonstrably profitable. */
  | 'ARBITRAGE'
  /** The math works but something about the contracts could not be verified. */
  | 'POSSIBLE'
  /** No guaranteed profit is available. */
  | 'NONE';

/**
 * Collapse the engine's grading into the three states a user can act on.
 *
 * The engine distinguishes far more than this — relative value, near-arb,
 * disqualified-on-settlement, informational — and those distinctions earn
 * their keep internally. None of them change what someone does next, so they
 * belong behind a details view rather than on the card.
 */
export function arbStatus(opportunity: Opportunity): ArbStatus {
  switch (opportunity.assurance) {
    case 'CERTIFIED':
      return 'ARBITRAGE';
    case 'QUALIFIED_CANDIDATE':
      return 'POSSIBLE';
    default:
      return 'NONE';
  }
}

export interface AllocationLeg {
  venue: string;
  /** "Buy YES" / "Bet NO" — what to actually do at this venue. */
  action: string;
  outcome_label: string;
  /** Money on this side, in deci-cents, rounded to whole dollars. */
  stake: Money;
  /** Contracts this stake buys. Whole numbers only. */
  contracts: number;
  price: DeciCents;
}

export interface Allocation {
  /** Whether a position could be built at all. */
  ok: boolean;
  legs: AllocationLeg[];
  /** Total actually deployed, after rounding. */
  total_stake: Money;
  /** Worst-case return across every way the event can resolve. */
  guaranteed_return: Money;
  guaranteed_profit: Money;
  /** Profit as a fraction of money in. */
  return_fraction: number;
  units: number;
  /** True when liquidity, not the bankroll, set the size. */
  capped_by_liquidity: boolean;
  /** Why nothing could be built, when `ok` is false. */
  reason: string;
}

const EMPTY: Allocation = {
  ok: false,
  legs: [],
  total_stake: 0,
  guaranteed_return: 0,
  guaranteed_profit: 0,
  return_fraction: 0,
  units: 0,
  capped_by_liquidity: false,
  reason: 'No position can be built from this opportunity.',
};

/**
 * Worst-case payout of a set of legs.
 *
 * The outcome space is the set of distinct *propositions*, never the set of
 * markets. A cross-venue hedge holds two different markets that resolve on
 * the same fact, and enumerating those as separate outcomes conjures a world
 * where one venue's market wins while the other's loses — a world that cannot
 * happen, and which pays nothing, so it would report a real arbitrage as a
 * total loss.
 *
 * The "nothing happens" case is included only when some leg is a NO. A pure
 * YES basket is only ever built on an exhaustive outcome set — the engine
 * refuses otherwise, precisely because every leg could lose — so for those,
 * one outcome is certain to occur.
 */
function worstCaseReturn(legs: AllocationLeg[], outcomes: string[]): Money {
  const distinct = [...new Set(outcomes)];
  const anyNoLeg = legs.some((leg) => !leg.action.includes('YES'));
  const cases: Array<string | null> = anyNoLeg ? [...distinct, null] : distinct;

  let worst: number | null = null;
  for (const winner of cases) {
    let payout = 0;
    for (let i = 0; i < legs.length; i += 1) {
      const leg = legs[i]!;
      const outcome = outcomes[i]!;
      const wins = leg.action.includes('YES') ? outcome === winner : outcome !== winner;
      if (wins) payout += leg.contracts * ONE_DOLLAR;
    }
    if (worst === null || payout < worst) worst = payout;
  }

  return worst ?? 0;
}

/**
 * Split a bankroll across the legs of an opportunity.
 *
 * Stakes are whole dollars and contracts are whole numbers, because the
 * output is an instruction to go and place orders. Sizing rounds *down* at
 * every step: an oversized leg is no longer hedged, and being slightly under
 * the bankroll is free while being over is not.
 */
export function allocate(opportunity: Opportunity, bankroll: Money): Allocation {
  if (bankroll <= 0) return { ...EMPTY, reason: 'Enter a bankroll to size a position.' };
  if (opportunity.unit_cost <= 0 || opportunity.capacity <= 0) {
    return { ...EMPTY, reason: 'This opportunity has no tradeable size.' };
  }

  // Contracts per unit, recovered from the position the engine sized.
  const perUnit = opportunity.legs.map((leg) => leg.contracts / opportunity.capacity);
  const smallest = Math.min(...perUnit.filter((c) => c > 0), 1);
  const lot = smallest < 1 ? Math.round(1 / smallest) : 1;

  const affordable = bankroll / opportunity.unit_cost;
  const cappedByLiquidity = opportunity.capacity < affordable;
  const units = Math.floor(Math.min(affordable, opportunity.capacity) / lot) * lot;

  if (units <= 0) {
    return {
      ...EMPTY,
      reason:
        `A single position costs about ${(opportunity.unit_cost * lot) / 1000 < 1 ? '$1' : `$${Math.ceil((opportunity.unit_cost * lot) / 1000)}`}, ` +
        `which is more than this bankroll.`,
    };
  }

  const legs: AllocationLeg[] = opportunity.legs.map((leg, index) => {
    const contracts = Math.round(units * perUnit[index]!);
    // Whole dollars: a bet slip and an order ticket both take round numbers.
    const stake = Math.floor((contracts * leg.price) / 1000) * 1000;
    return {
      venue: leg.venue,
      action: leg.side === 'BUY_YES' ? 'Buy YES' : 'Bet NO',
      outcome_label: leg.outcome_label,
      stake,
      contracts,
      price: leg.price,
    };
  });

  const totalStake = legs.reduce((sum, leg) => sum + leg.stake, 0);
  const guaranteedReturn = worstCaseReturn(
    legs,
    opportunity.legs.map((l) => l.outcome),
  );
  const guaranteedProfit = guaranteedReturn - totalStake;

  return {
    ok: totalStake > 0,
    legs,
    total_stake: totalStake,
    guaranteed_return: roundHalfAway(guaranteedReturn),
    guaranteed_profit: roundHalfAway(guaranteedProfit),
    return_fraction: totalStake > 0 ? guaranteedProfit / totalStake : 0,
    units,
    capped_by_liquidity: cappedByLiquidity,
    reason: '',
  };
}

/**
 * One plain sentence saying why there is nothing to do here.
 *
 * Deliberately does not name the engine's internal categories. "Relative
 * value with an unverifiable settlement basis" is true and useless; what a
 * user needs is whether to move on.
 */
export function explainNoArbitrage(opportunity: Opportunity): string {
  if (opportunity.assurance === 'DISQUALIFIED') {
    return (
      `${opportunity.venues.join(' and ')} settle this on different sources, so betting ` +
      `both sides is not a hedge — both sides can lose together.`
    );
  }
  if (opportunity.assurance === 'NOT_PROFITABLE') {
    return (
      `The prices are close enough to a guaranteed profit, but fees and the cost of ` +
      `moving through the order book eat the difference.`
    );
  }
  return (
    `${opportunity.venues.join(' and ')} disagree on this, but there is no way to bet ` +
    `both sides for a guaranteed profit.`
  );
}
