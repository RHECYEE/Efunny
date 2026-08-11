import { ONE_DOLLAR, type FeeModel, type FillContext, type Money } from '@arbterminal/core';

/**
 * Kalshi's published trading fee schedule, expressed as data for the engine.
 *
 *   fee = ceil( multiplier * C * P * (1 - P) )   rounded up to the next cent
 *
 * where C is the contract count and P the price in dollars. The fee peaks at
 * a 50c price and falls toward zero at both extremes, which matters here:
 * arbitrage legs are often cheap, so a flat per-contract estimate would
 * materially overstate the cost of a 5c leg and understate a 50c one.
 *
 * A few series are quoted at a reduced multiplier; those are listed as data
 * below rather than branched on in the engine.
 */

/** Standard taker multiplier. */
const STANDARD_MULTIPLIER = 0.07;

/** Series roots quoted at the reduced multiplier, keyed by ticker prefix. */
const REDUCED_MULTIPLIER_SERIES: Record<string, number> = {
  KXBTC: 0.035,
  KXETH: 0.035,
  KXBTCD: 0.035,
  KXETHD: 0.035,
};

/**
 * Maker fees apply only on a subset of series and only to resting orders.
 * Everything this app models is a taker fill against the visible book, so
 * the maker rate is declared but never charged unless a caller asks for it.
 */
const MAKER_RATE = 0.0025;

/**
 * Round a dollar amount up to the next whole cent, then express it in
 * deci-cents.
 *
 * The epsilon is load-bearing: `0.07 * 100 * 0.5 * 0.5` is 175.00000000000003
 * cents in binary floating point, and a bare `ceil` would bill 176 — an extra
 * cent on every fee that lands exactly on a cent boundary.
 */
function ceilToDeciCents(dollars: number): Money {
  return Math.ceil(dollars * 100 - 1e-9) * 10;
}

export interface KalshiFeeOptions {
  /** Override the standard multiplier, e.g. to model a fee promotion. */
  multiplier?: number;
  /** Extra series overrides merged over the built-in table. */
  series_multipliers?: Record<string, number>;
}

export class KalshiFeeModel implements FeeModel {
  readonly venue = 'kalshi';
  private readonly multiplier: number;
  private readonly seriesMultipliers: Record<string, number>;

  constructor(options: KalshiFeeOptions = {}) {
    this.multiplier = options.multiplier ?? STANDARD_MULTIPLIER;
    this.seriesMultipliers = { ...REDUCED_MULTIPLIER_SERIES, ...options.series_multipliers };
  }

  private multiplierFor(product: string): number {
    // Longest matching prefix wins, so KXBTCD beats KXBTC.
    let best: number | null = null;
    let bestLength = -1;
    for (const [prefix, value] of Object.entries(this.seriesMultipliers)) {
      if (product.startsWith(prefix) && prefix.length > bestLength) {
        best = value;
        bestLength = prefix.length;
      }
    }
    return best ?? this.multiplier;
  }

  describe(context: FillContext): string {
    const rate = this.multiplierFor(context.product);
    return `Kalshi taker fee ceil(${rate} x C x P x (1-P)), rounded up to the cent`;
  }

  tradingFee(context: FillContext): Money {
    if (context.contracts <= 0) return 0;
    const price = Math.max(0, Math.min(ONE_DOLLAR, context.price)) / ONE_DOLLAR;
    if (context.role === 'MAKER') {
      // Maker fee is linear in notional, not a P*(1-P) curve.
      return ceilToDeciCents(MAKER_RATE * context.contracts * price);
    }
    const rate = this.multiplierFor(context.product);
    return ceilToDeciCents(rate * context.contracts * price * (1 - price));
  }

  settlementFee(): Money {
    // Kalshi charges no separate settlement fee on the contracts modelled here.
    return 0;
  }
}
