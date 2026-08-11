import type { DeciCents, Money } from '../domain/money.js';
import type { LegSide } from '../domain/types.js';

/**
 * Fee models.
 *
 * A venue's fee schedule is *data supplied by its adapter*, not logic inside
 * the arb engine. The engine only ever calls this interface, so adding a
 * venue with an exotic fee structure never touches the engine.
 */

export interface FillContext {
  venue: string;
  /** Series/ticker root, so a venue can vary fees by product. */
  product: string;
  side: LegSide;
  /** Per-contract price actually paid, in deci-cents. */
  price: DeciCents;
  contracts: number;
  role: 'TAKER' | 'MAKER';
}

export interface FeeModel {
  venue: string;
  /** One-line description shown in the cost-stack breakdown. */
  describe(context: FillContext): string;
  /** Fee charged at trade time, in deci-cents. Always >= 0. */
  tradingFee(context: FillContext): Money;
  /** Fee charged when the contract settles, in deci-cents. Always >= 0. */
  settlementFee(context: FillContext): Money;
}

export function totalFee(model: FeeModel, context: FillContext): Money {
  return model.tradingFee(context) + model.settlementFee(context);
}

/**
 * Used when an adapter has not declared a fee schedule. It reports zero and
 * the engine attaches a warning — an unmodelled fee must be visible as a
 * gap, never silently treated as free.
 */
export class UnknownFeeModel implements FeeModel {
  constructor(public readonly venue: string) {}
  describe(): string {
    return `${this.venue} fee schedule not modelled — displayed edge is an upper bound`;
  }
  tradingFee(): Money {
    return 0;
  }
  settlementFee(): Money {
    return 0;
  }
}

/** Charges nothing, and says so. For venues whose margin is in the price. */
export class VigInPriceFeeModel implements FeeModel {
  constructor(
    public readonly venue: string,
    private readonly note = 'margin is priced into the odds, no separate commission',
  ) {}
  describe(): string {
    return `${this.venue}: ${this.note}`;
  }
  tradingFee(): Money {
    return 0;
  }
  settlementFee(): Money {
    return 0;
  }
}

export class FeeBook {
  private readonly models = new Map<string, FeeModel>();

  register(model: FeeModel): this {
    this.models.set(model.venue, model);
    return this;
  }

  has(venue: string): boolean {
    return this.models.has(venue);
  }

  for(venue: string): FeeModel {
    return this.models.get(venue) ?? new UnknownFeeModel(venue);
  }

  venues(): string[] {
    return [...this.models.keys()].sort();
  }
}
