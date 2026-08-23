import { ONE_DOLLAR, roundHalfAway, type DeciCents, type Money } from '../domain/money.js';
import type { BookLevel, Leg, Market, Quote } from '../domain/types.js';
import { bestPrice, totalDepth, walkBook } from '../normalize/book.js';
import type { FeeBook, FillContext } from './fees.js';

/**
 * Position sizing and cost accounting, shared by every detector.
 *
 * Everything is normalized to one **unit**, defined as the position that
 * guarantees exactly $1.00 of payout. That makes a two-leg complementary
 * position, an eight-outcome NO basket and a cross-venue hedge directly
 * comparable on one scale, and it makes the cost stack read in deci-cents per
 * dollar of payout throughout.
 */

export interface LegSpec {
  market: Market;
  quote: Quote;
  side: 'BUY_YES' | 'BUY_NO';
  /** The executable ask ladder for this side. */
  ladder: BookLevel[];
  /**
   * Contracts of this leg required per unit of position. 1 for a two-outcome
   * hedge; 1/(N-1) for an N-outcome NO basket, where N-1 legs pay out.
   */
  contracts_per_unit: number;
}

export interface PositionCosts {
  units: number;
  /** Cost of one unit at top-of-book, before any adjustment. */
  top_cost: DeciCents;
  /** Raw edge at top-of-book: 1000 - top_cost. This is the "displayed" edge. */
  gross_edge: DeciCents;
  /** Cost of one unit after walking the book for `units`. */
  vwap_cost: DeciCents;
  /** vwap_cost - top_cost, per unit. Always >= 0. */
  slippage: DeciCents;
  /** Venue fees per unit. */
  fees: DeciCents;
  /** Capital deployed per unit, fees included. */
  unit_cost: Money;
  /** Whether `units` was fully fillable from visible depth on every leg. */
  fully_fillable: boolean;
  legs: Leg[];
}

/**
 * Smallest edge worth sizing for: a tenth of a cent per dollar of payout.
 * Without this floor, bisection converges on the exact break-even size and
 * reports a zero-profit position as tradeable capacity.
 */
const MIN_MEANINGFUL_EDGE = 1;

/**
 * Units per *lot*: the smallest position size that leaves every leg holding a
 * whole number of contracts.
 *
 * A unit is defined as $1.00 of guaranteed payout, which for an N-outcome NO
 * basket means 1/(N-1) contracts per leg — a perfectly good accounting unit
 * and a completely unplaceable order. Nobody buys 0.5 contracts. Sizing is
 * therefore done in lots, and a lot is whatever multiple of a unit makes the
 * contract counts integers.
 */
export function unitsPerLot(legs: LegSpec[]): number {
  let lot = 1;
  for (const leg of legs) {
    if (leg.contracts_per_unit <= 0 || leg.contracts_per_unit >= 1) continue;
    // 1/(N-1) contracts per unit means N-1 units buys one whole contract.
    const needed = Math.round(1 / leg.contracts_per_unit);
    if (needed > 1) lot = Math.max(lot, needed);
  }
  return lot;
}

/** Round a unit count down to a whole number of lots. */
export function floorToLots(units: number, lot: number): number {
  if (!Number.isFinite(units) || units <= 0 || lot <= 0) return 0;
  return Math.floor(units / lot) * lot;
}

/** Largest number of units obtainable from visible depth across all legs. */
export function depthLimitedUnits(legs: LegSpec[]): number {
  if (legs.length === 0) return 0;
  return legs.reduce((min, leg) => {
    if (leg.contracts_per_unit <= 0) return min;
    return Math.min(min, totalDepth(leg.ladder) / leg.contracts_per_unit);
  }, Infinity);
}

/** Units obtainable at the best price only — the zero-slippage size. */
export function topOfBookUnits(legs: LegSpec[]): number {
  if (legs.length === 0) return 0;
  return legs.reduce((min, leg) => {
    const top = leg.ladder[0];
    if (!top || leg.contracts_per_unit <= 0) return 0;
    return Math.min(min, top.size / leg.contracts_per_unit);
  }, Infinity);
}

function feeContext(leg: LegSpec, price: DeciCents, contracts: number): FillContext {
  return {
    venue: leg.market.venue,
    // Series root: everything before the first dash of the venue ticker.
    product: leg.market.venue_market_id.split('-')[0] ?? leg.market.venue_market_id,
    side: leg.side,
    price,
    contracts,
    role: 'TAKER',
  };
}

/**
 * Price a position of `units`. Costs are computed by actually walking each
 * leg's visible ladder — no liquidity beyond the published book is assumed.
 */
export function pricePosition(
  legs: LegSpec[],
  units: number,
  feeBook: FeeBook,
): PositionCosts {
  let topCost = 0;
  let vwapCost = 0;
  let fees = 0;
  let fullyFillable = true;
  const legDetails: Leg[] = [];

  for (const leg of legs) {
    const top = bestPrice(leg.ladder);
    const requested = units * leg.contracts_per_unit;
    const walk = walkBook(leg.ladder, requested);
    if (walk.depth_exhausted || top === null) fullyFillable = false;

    // With an empty or exhausted ladder, charge the position the full dollar
    // for the missing contracts rather than pretending they were free.
    const effectiveVwap =
      walk.filled >= requested - 1e-9 && top !== null
        ? walk.vwap
        : (walk.cost + (requested - walk.filled) * ONE_DOLLAR) / Math.max(requested, 1e-9);

    topCost += (top ?? ONE_DOLLAR) * leg.contracts_per_unit;
    vwapCost += effectiveVwap * leg.contracts_per_unit;

    const model = feeBook.for(leg.market.venue);
    const context = feeContext(leg, effectiveVwap, Math.max(walk.filled, 0));
    const legFee = model.tradingFee(context) + model.settlementFee(context);
    fees += units > 0 ? legFee / units : 0;

    const usesComplement = leg.side === 'BUY_NO' && Boolean(leg.market.complement_label);
    legDetails.push({
      market_id: leg.market.market_id,
      outcome: leg.market.outcome,
      venue: leg.market.venue,
      side: leg.side,
      price: top ?? ONE_DOLLAR,
      contracts: requested,
      vwap: effectiveVwap,
      slippage_per_contract: effectiveVwap - (top ?? ONE_DOLLAR),
      depth_available: totalDepth(leg.ladder),
      // A NO leg is described by what it actually pays on. Where the venue
      // names the other side — the opposing fighter, the other party — that
      // is the honest label; "NO on Song Yadong" reads like a bet on him.
      outcome_label: usesComplement ? leg.market.complement_label! : leg.market.outcome_label,
      label_is_complement: usesComplement,
    });
  }

  const slippage = Math.max(0, vwapCost - topCost);

  return {
    units,
    top_cost: topCost,
    gross_edge: ONE_DOLLAR - topCost,
    vwap_cost: vwapCost,
    slippage,
    fees,
    unit_cost: vwapCost + fees,
    fully_fillable: fullyFillable,
    legs: legDetails,
  };
}

/**
 * Largest size at which the position still clears every cost. Net edge per
 * unit is non-increasing in size (deeper fills can only raise the VWAP), so
 * bisection is sound.
 *
 * Returns 0 when no size is profitable — the caller then reports the position
 * at its top-of-book size and it classifies as NEAR_ARB.
 */
export function maxProfitableUnits(
  legs: LegSpec[],
  feeBook: FeeBook,
  reserve: DeciCents,
  minNetEdge: DeciCents,
): number {
  const ceiling = depthLimitedUnits(legs);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return 0;

  // Sizing works on *average* cost, not marginal: a position is still an
  // arbitrage while its VWAP across the whole fill stays under the payout,
  // even after it has eaten past the best level.
  const netEdgeAt = (units: number): number => {
    const costs = pricePosition(legs, units, feeBook);
    return costs.gross_edge - costs.slippage - costs.fees - reserve;
  };

  // Break-even is not an opportunity, so require at least a tenth of a cent
  // of edge per dollar even when the caller set no floor of their own.
  const target = Math.max(minNetEdge, MIN_MEANINGFUL_EDGE);

  // A size too small to be worth quoting still tells us whether any size works.
  // The smallest placeable position is one lot; anything below that is not a
  // size, so profitability is probed there rather than at an infinitesimal.
  const lot = unitsPerLot(legs);
  if (ceiling < lot) return 0;
  const probe = lot;
  if (netEdgeAt(probe) < target) return 0;
  if (netEdgeAt(ceiling) >= target) return floorToLots(ceiling, lot);

  let lo = probe;
  let hi = ceiling;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (netEdgeAt(mid) >= target) lo = mid;
    else hi = mid;
  }
  // Round down to a whole number of lots. Every leg then holds an integer
  // contract count, and because the position only shrinks, a size that was
  // profitable stays profitable.
  return floorToLots(lo, unitsPerLot(legs));
}

/** Total capital to take `units` of a position, in deci-cents. */
export function capitalRequired(costs: PositionCosts): Money {
  return roundHalfAway(costs.unit_cost * costs.units);
}
