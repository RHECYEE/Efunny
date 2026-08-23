import { ONE_DOLLAR, type FeeModel, type FillContext, type Money } from '@arbterminal/core';

/**
 * Polymarket's published taker fee schedule, expressed as data for the engine.
 *
 *   fee = C x rate x p x (1 - p)
 *
 * Structurally the same curve as Kalshi's — peaking at 50c and falling to
 * nothing at both extremes — but with a different rate per category, and
 * Polymarket charges *takers only*. Everything this app models is a taker
 * fill against the visible book, so the taker rate is the one that applies.
 *
 * Two details matter more than the formula. Geopolitical and world-event
 * markets are genuinely fee-free, so a flat assumption would invent a cost
 * that does not exist and hide real edges. And each market carries its own
 * `feeSchedule.rate`, which is authoritative and does not always agree with
 * the published category table — the market's own declaration wins.
 */

/** Published taker rates by category. Fallback when a market declares none. */
const CATEGORY_RATES: Record<string, number> = {
  CRYPTO: 0.07,
  SPORTS: 0.05,
  ECONOMICS: 0.05,
  CULTURE: 0.05,
  CLIMATE: 0.05,
  OTHER: 0.05,
  POLITICS: 0.04,
  COMPANIES: 0.04,
  // Polymarket does not charge on geopolitical and world-event markets.
  WORLD: 0,
};

const DEFAULT_RATE = 0.05;

/**
 * Round a dollar amount up to the next deci-cent.
 *
 * Up, deliberately: a fee understated by a fraction of a cent overstates the
 * edge, and this number's whole job is to be subtracted from an edge before
 * anybody calls it an arbitrage.
 */
function ceilToDeciCents(dollars: number): Money {
  return Math.ceil(dollars * 1000 - 1e-9);
}

export interface PolymarketFeeOptions {
  /** Per-market taker rates, keyed by market id. Beats the category table. */
  market_rates?: Map<string, number>;
  /** Markets that declared fees disabled. */
  fee_free_markets?: Set<string>;
  /** Category of each market, for the fallback table. */
  market_categories?: Map<string, string>;
}

export class PolymarketFeeModel implements FeeModel {
  readonly venue = 'polymarket';

  private readonly marketRates: Map<string, number>;
  private readonly feeFree: Set<string>;
  private readonly categories: Map<string, string>;

  constructor(options: PolymarketFeeOptions = {}) {
    this.marketRates = options.market_rates ?? new Map();
    this.feeFree = options.fee_free_markets ?? new Set();
    this.categories = options.market_categories ?? new Map();
  }

  /** Learn a market's declared schedule as it is normalized. */
  declare(marketId: string, rate: number | null, enabled: boolean, category: string): void {
    this.categories.set(marketId, category);
    if (!enabled) {
      this.feeFree.add(marketId);
      return;
    }
    this.feeFree.delete(marketId);
    if (rate !== null && Number.isFinite(rate)) this.marketRates.set(marketId, rate);
  }

  rateFor(marketId: string, category?: string): number {
    if (this.feeFree.has(marketId)) return 0;
    const declared = this.marketRates.get(marketId);
    if (declared !== undefined) return declared;
    const cat = category ?? this.categories.get(marketId) ?? '';
    return CATEGORY_RATES[cat] ?? DEFAULT_RATE;
  }

  tradingFee(context: FillContext): Money {
    // Makers are never charged. Only a taker crossing the book pays.
    if (context.role === 'MAKER') return 0;

    const rate = this.rateFor(context.product);
    if (rate === 0) return 0;

    const p = context.price / ONE_DOLLAR;
    if (!(p > 0 && p < 1)) return 0;
    return ceilToDeciCents(rate * context.contracts * p * (1 - p));
  }

  /**
   * Polymarket takes nothing at resolution. Winning shares redeem for the
   * full dollar, so the only charge is the one taken at match time.
   */
  settlementFee(): Money {
    return 0;
  }

  describe(context: FillContext): string {
    const rate = this.rateFor(context.product);
    return rate === 0
      ? 'Polymarket charges no fee on this market'
      : `Polymarket taker fee ${(rate * 100).toFixed(0)}% x p x (1-p) per share`;
  }
}
