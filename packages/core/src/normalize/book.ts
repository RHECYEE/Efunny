import { ONE_DOLLAR, type DeciCents } from '../domain/money.js';
import type { BookLevel, OrderBook } from '../domain/types.js';

/**
 * Some venues publish only the resting *bids* on each side of a binary
 * market. Because YES and NO are complements, a resting NO bid at price p is
 * an offer to sell YES at (1 - p): the complementary ask ladder is exact, not
 * an estimate.
 *
 * Input levels may arrive in any order; the result is always sorted
 * best-first (ascending for asks, since a lower ask is better).
 */
export function reconstructAsks(complementaryBids: BookLevel[]): BookLevel[] {
  return complementaryBids
    .filter((level) => level.size > 0 && level.price > 0 && level.price < ONE_DOLLAR)
    .map((level) => ({ price: ONE_DOLLAR - level.price, size: level.size }))
    .sort((a, b) => a.price - b.price);
}

/** Bids sort best-first too, which for a bid means descending. */
export function sortBids(bids: BookLevel[]): BookLevel[] {
  return bids.filter((l) => l.size > 0).slice().sort((a, b) => b.price - a.price);
}

/**
 * Build both executable ladders for a venue that publishes bid-only books.
 */
export function bookFromComplementaryBids(
  yesBids: BookLevel[],
  noBids: BookLevel[],
): OrderBook {
  return {
    yes_bids: sortBids(yesBids),
    yes_asks: reconstructAsks(noBids),
    no_bids: sortBids(noBids),
    no_asks: reconstructAsks(yesBids),
  };
}

export const EMPTY_BOOK: OrderBook = {
  yes_bids: [],
  yes_asks: [],
  no_bids: [],
  no_asks: [],
};

export function bestPrice(levels: BookLevel[]): DeciCents | null {
  return levels.length > 0 ? levels[0]!.price : null;
}

export function totalDepth(levels: BookLevel[]): number {
  return levels.reduce((sum, l) => sum + l.size, 0);
}

export interface BookWalk {
  /** Contracts actually obtainable, capped by visible depth. */
  filled: number;
  /** Volume-weighted average price over `filled` contracts. */
  vwap: DeciCents;
  /** Total cost of `filled` contracts, in deci-cents. */
  cost: number;
  /** Best price on the ladder — what a naive card would quote. */
  top_price: DeciCents | null;
  /** `vwap - top_price`. Zero when the top level absorbs the whole order. */
  slippage_per_contract: DeciCents;
  /** True when the ladder ran out before `requested` was filled. */
  depth_exhausted: boolean;
  /** Levels consumed, for the depth table in the analysis view. */
  levels_consumed: BookLevel[];
}

/**
 * Walk an ask ladder for `requested` contracts. This is the slippage model:
 * it is not a fudge factor, it is the actual cost of consuming visible
 * liquidity. Nothing beyond the visible book is ever assumed to exist.
 */
export function walkBook(levels: BookLevel[], requested: number): BookWalk {
  const top = bestPrice(levels);
  if (requested <= 0 || levels.length === 0 || top === null) {
    return {
      filled: 0,
      vwap: 0,
      cost: 0,
      top_price: top,
      slippage_per_contract: 0,
      depth_exhausted: levels.length === 0,
      levels_consumed: [],
    };
  }

  let remaining = requested;
  let cost = 0;
  const consumed: BookLevel[] = [];

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    remaining -= take;
    consumed.push({ price: level.price, size: take });
  }

  const filled = requested - remaining;
  // Keep the VWAP an exact integer where possible; a fractional deci-cent
  // would be rounded at every downstream comparison otherwise.
  const vwap = filled > 0 ? cost / filled : 0;

  return {
    filled,
    vwap,
    cost,
    top_price: top,
    slippage_per_contract: filled > 0 ? vwap - top : 0,
    depth_exhausted: remaining > 0,
    levels_consumed: consumed,
  };
}

/**
 * Largest whole number of contracts obtainable from every ladder at once —
 * the binding constraint on an arbitrage position's capacity.
 */
export function jointCapacity(ladders: BookLevel[][]): number {
  if (ladders.length === 0) return 0;
  return ladders.reduce((min, ladder) => Math.min(min, totalDepth(ladder)), Infinity);
}
