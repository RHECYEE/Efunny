import {
  FeeBook,
  bookFromComplementaryBids,
  type BookLevel,
  type Event,
  type EventSnapshot,
  type FeeModel,
  type FillContext,
  type Market,
  type Money,
  type OrderBook,
  type Quote,
  type SettlementSpec,
} from '@arbterminal/core';

/**
 * Fixture builders. Every arb-engine test is built from these rather than
 * from live data, so the math is verifiable independently of any venue.
 */

export const NOW = '2026-08-11T12:00:00.000Z';

export function settlement(overrides: Partial<SettlementSpec> = {}): SettlementSpec {
  return {
    settlement_source: 'Associated Press',
    settlement_rules_text: 'Resolves YES if the named candidate wins the election.',
    void_rules: 'Voided if the election does not take place.',
    overtime_rules: '',
    ...overrides,
  };
}

export function market(overrides: Partial<Market> = {}): Market {
  const venue = overrides.venue ?? 'venue_a';
  const venueMarketId = overrides.venue_market_id ?? 'MKT-1';
  return {
    market_id: `${venue}:${venueMarketId}`,
    event_id: 'US_PRESIDENT_2028',
    venue,
    venue_market_id: venueMarketId,
    outcome: 'CANDIDATE_A_WINS',
    outcome_label: 'Candidate A',
    market_type: 'BINARY',
    tier: 'NON_SPORT',
    line: null,
    comparison_operator: 'NONE',
    threshold: null,
    settlement: settlement(),
    jurisdiction: 'US-CFTC',
    currency: 'USD',
    match_confidence: 0,
    title: 'Will Candidate A win the 2028 election?',
    status: 'OPEN',
    close_time: '2028-11-07T05:00:00.000Z',
    payout_per_contract: 1000,
    ...overrides,
  };
}

/**
 * Build a book from explicit YES-ask and NO-ask ladders. Levels are given as
 * `[price_in_deci_cents, size]`.
 */
export function book(yesAsks: Array<[number, number]>, noAsks: Array<[number, number]>): OrderBook {
  const toLevels = (pairs: Array<[number, number]>): BookLevel[] =>
    pairs.map(([price, size]) => ({ price, size }));
  return {
    yes_asks: toLevels(yesAsks).sort((a, b) => a.price - b.price),
    no_asks: toLevels(noAsks).sort((a, b) => a.price - b.price),
    // Bids are the complements of the opposite side's asks.
    yes_bids: toLevels(noAsks)
      .map((l) => ({ price: 1000 - l.price, size: l.size }))
      .sort((a, b) => b.price - a.price),
    no_bids: toLevels(yesAsks)
      .map((l) => ({ price: 1000 - l.price, size: l.size }))
      .sort((a, b) => b.price - a.price),
  };
}

/** A Kalshi-shaped book: only resting bids are known, asks are reconstructed. */
export function bidOnlyBook(
  yesBids: Array<[number, number]>,
  noBids: Array<[number, number]>,
): OrderBook {
  return bookFromComplementaryBids(
    yesBids.map(([price, size]) => ({ price, size })),
    noBids.map(([price, size]) => ({ price, size })),
  );
}

export function quote(marketId: string, orderBook: OrderBook, timestamp = NOW): Quote {
  const yesBid = orderBook.yes_bids[0]?.price ?? null;
  const yesAsk = orderBook.yes_asks[0]?.price ?? null;
  return {
    quote_id: `q_${marketId}`,
    market_id: marketId,
    bid: yesBid,
    ask: yesAsk,
    no_bid: orderBook.no_bids[0]?.price ?? null,
    no_ask: orderBook.no_asks[0]?.price ?? null,
    implied_probability: yesBid !== null && yesAsk !== null ? (yesBid + yesAsk) / 2 / 1000 : null,
    liquidity: orderBook.yes_asks.reduce((sum, l) => sum + l.size, 0),
    book: orderBook,
    timestamp,
  };
}

export function event(overrides: Partial<Event> = {}): Event {
  return {
    event_id: 'US_PRESIDENT_2028',
    category: 'POLITICS',
    participants: [],
    start_time: null,
    end_time: null,
    canonical_outcome_set: null,
    exhaustive: false,
    exhaustive_basis: 'test fixture',
    ...overrides,
  };
}

export function snapshot(
  eventOverrides: Partial<Event>,
  markets: Array<{ market: Market; book: OrderBook }>,
): EventSnapshot {
  return {
    event: event(eventOverrides),
    markets: markets.map((m) => ({ market: m.market, quote: quote(m.market.market_id, m.book) })),
  };
}

/** Charges a flat number of deci-cents per contract. Trivially predictable. */
export class FlatFeeModel implements FeeModel {
  constructor(
    readonly venue: string,
    private readonly perContract: Money,
  ) {}
  describe(): string {
    return `${this.venue}: ${this.perContract} dc per contract`;
  }
  tradingFee(context: FillContext): Money {
    return Math.ceil(context.contracts) * this.perContract;
  }
  settlementFee(): Money {
    return 0;
  }
}

export function feeBook(...models: FeeModel[]): FeeBook {
  const fees = new FeeBook();
  for (const model of models) fees.register(model);
  return fees;
}

export function zeroFees(...venues: string[]): FeeBook {
  return feeBook(...venues.map((v) => new FlatFeeModel(v, 0)));
}

export const frozenNow = () => new Date(NOW);
