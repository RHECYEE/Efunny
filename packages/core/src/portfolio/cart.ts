import { ONE_DOLLAR, roundHalfAway, type Money } from '../domain/money.js';
import type { CartSummary, Opportunity, PaperTrade } from '../domain/types.js';

/**
 * The arbitrage cart: a hypothetical portfolio assembled from several
 * opportunities at once, so the user can see aggregate capital, modeled
 * profit and return on deployed capital rather than judging cards one by one.
 */

export interface CartEntry {
  opportunity: Opportunity;
  /** Units of the position to take. Capped at the opportunity's capacity. */
  units: number;
}

export function summarizeCart(entries: CartEntry[]): CartSummary {
  let capital = 0;
  let profit = 0;
  let worstCase = 0;
  let guaranteed = 0;
  let speculative = 0;
  let lowestConfidence = 1;
  const venues = new Set<string>();
  const warnings: string[] = [];

  for (const entry of entries) {
    const { opportunity } = entry;
    const units = Math.max(0, Math.min(entry.units, opportunity.capacity));
    const cost = opportunity.unit_cost * units;
    capital += cost;
    profit += opportunity.net_edge * units;

    for (const venue of opportunity.venues) venues.add(venue);
    lowestConfidence = Math.min(lowestConfidence, opportunity.match_confidence);

    if (opportunity.type === 'GUARANTEED_ARB' || opportunity.type === 'CROSS_VENUE_ARB') {
      guaranteed += 1;
      // A hedged position's downside is its edge, not its capital — unless
      // the legs settle differently, which the reserve already prices.
      worstCase += (opportunity.net_edge - opportunity.settlement_mismatch_reserve) * units;
    } else {
      speculative += 1;
      // An unhedged leg can lose everything it cost.
      worstCase -= cost;
    }
  }

  if (speculative > 0) {
    warnings.push(
      `${speculative} of ${entries.length} entries are not hedged; the worst case shown ` +
        `assumes those positions expire worthless.`,
    );
  }
  const crossVenue = entries.filter((e) => e.opportunity.venues.length > 1).length;
  if (crossVenue > 0) {
    warnings.push(
      `${crossVenue} entries span venues and require capital funded on both sides ` +
        `before the hedge is live.`,
    );
  }
  if (lowestConfidence < 0.95 && entries.length > 0) {
    warnings.push(
      `Lowest match confidence in the cart is ${(lowestConfidence * 100).toFixed(0)}%.`,
    );
  }

  return {
    entries: entries.length,
    capital_required: roundHalfAway(capital),
    modeled_profit: roundHalfAway(profit),
    return_on_deployed_capital: capital > 0 ? profit / capital : 0,
    worst_case_pl: roundHalfAway(worstCase),
    guaranteed_entries: guaranteed,
    speculative_entries: speculative,
    lowest_match_confidence: entries.length > 0 ? lowestConfidence : 1,
    venues: [...venues].sort(),
    warnings,
  };
}

export interface PortfolioStats {
  trades: number;
  open: number;
  resolved: number;
  capital_deployed: Money;
  realized_pl: Money;
  /** Mean displayed edge across executed trades, in deci-cents per $1. */
  mean_displayed_edge: number;
  mean_fillable_edge: number;
  /** How much of the advertised edge survived to execution, 0..1. */
  edge_capture_rate: number;
  fully_hedged_rate: number;
  /** Counts by shortfall cause, for the "why did the edge decay" view. */
  shortfall_causes: Record<string, number>;
}

/**
 * Aggregate honesty metrics over the paper-trade history. `edge_capture_rate`
 * is the headline number: what fraction of displayed edge was really there.
 */
export function portfolioStats(trades: PaperTrade[]): PortfolioStats {
  const executed = trades.filter((t) => t.units_executed > 0);
  const displayed = executed.reduce((sum, t) => sum + t.displayed_edge, 0);
  const fillable = executed.reduce((sum, t) => sum + t.actually_fillable_edge, 0);
  const causes: Record<string, number> = {};

  for (const trade of trades) {
    for (const fill of trade.simulated_fills) {
      if (fill.shortfall_reason) {
        causes[fill.shortfall_reason] = (causes[fill.shortfall_reason] ?? 0) + 1;
      }
    }
  }

  const resolved = trades.filter((t) => t.realized_pl !== null);

  return {
    trades: trades.length,
    open: trades.filter((t) => t.resolution === 'OPEN').length,
    resolved: resolved.length,
    capital_deployed: trades.reduce((sum, t) => sum + t.capital_deployed, 0),
    realized_pl: resolved.reduce((sum, t) => sum + (t.realized_pl ?? 0), 0),
    mean_displayed_edge: executed.length > 0 ? displayed / executed.length : 0,
    mean_fillable_edge: executed.length > 0 ? fillable / executed.length : 0,
    edge_capture_rate: displayed > 0 ? fillable / displayed : 0,
    fully_hedged_rate:
      executed.length > 0 ? executed.filter((t) => t.fully_hedged).length / executed.length : 0,
    shortfall_causes: causes,
  };
}

/** Maximum units of an opportunity a bankroll can fund. */
export function unitsForBankroll(opportunity: Opportunity, bankroll: Money): number {
  if (opportunity.unit_cost <= 0) return 0;
  return Math.min(opportunity.capacity, bankroll / opportunity.unit_cost);
}

/** Guaranteed payout of a fully hedged position, for display. */
export function guaranteedPayout(units: number): Money {
  return roundHalfAway(units * ONE_DOLLAR);
}
