import type { EventSnapshot, MarketSnapshot, Quote } from '@arbterminal/core';
import type { AdapterCapabilities, FetchOptions, VenueAdapter } from '../types.js';
import { KalshiClient, type KalshiClientOptions, type KalshiEvent } from './client.js';
import { KalshiFeeModel } from './fees.js';
import {
  KALSHI_VENUE,
  toEvent,
  toMarket,
  toOrderBook,
  topOfBookOnly,
  toQuote,
} from './normalize.js';

export interface KalshiAdapterOptions extends KalshiClientOptions {
  client?: KalshiClient;
  /** Markets to pull per cycle. */
  market_limit?: number;
  /**
   * How many markets get a full depth fetch each cycle. Depth is one request
   * per market, so this is the main rate-limit lever; the rest fall back to
   * the top-of-book fields already present on the market payload.
   */
  depth_fetch_limit?: number;
}

/**
 * Kalshi adapter.
 *
 * Everything Kalshi-specific in this system lives under this directory: the
 * wire format, the ask-ladder reconstruction, the fee schedule and the
 * category mapping. The engines see only normalized objects.
 */
export class KalshiAdapter implements VenueAdapter {
  readonly venue = KALSHI_VENUE;
  readonly display_name = 'Kalshi';
  readonly fee_model = new KalshiFeeModel();
  readonly capabilities: AdapterCapabilities = {
    order_book_depth: true,
    // Kalshi's book is one matched ladder viewed from two sides, so YES and
    // NO asks are complements rather than independent quotes.
    independent_two_sided_asks: false,
    settlement_rules_text: true,
    mutually_exclusive_groups: true,
    sports_market_types: ['MONEYLINE'],
  };

  private readonly client: KalshiClient;
  private readonly marketLimit: number;
  private readonly depthFetchLimit: number;
  /** venue ticker -> canonical market id, for `fetchQuotes`. */
  private readonly tickerIndex = new Map<string, string>();

  constructor(options: KalshiAdapterOptions = {}) {
    this.client = options.client ?? new KalshiClient(options);
    this.marketLimit = options.market_limit ?? 400;
    this.depthFetchLimit = options.depth_fetch_limit ?? 120;
  }

  async fetchSnapshots(options: FetchOptions = {}): Promise<EventSnapshot[]> {
    const rawEvents = await this.client.listEvents({
      limit: options.limit ?? this.marketLimit,
      signal: options.signal,
    });

    const usable = rawEvents.filter((e) => (e.markets ?? []).length > 0);
    const ranked = this.rankForDepthFetch(usable, options.with_depth === false ? 0 : this.depthFetchLimit);
    const timestamp = new Date().toISOString();
    const snapshots: EventSnapshot[] = [];

    for (const rawEvent of usable) {
      const event = toEvent(rawEvent);
      const markets: MarketSnapshot[] = [];

      for (const rawMarket of rawEvent.markets ?? []) {
        const market = toMarket(rawEvent, rawMarket);
        this.tickerIndex.set(market.market_id, rawMarket.ticker);

        const book = ranked.has(rawMarket.ticker)
          ? toOrderBook(await this.safeOrderBook(rawMarket.ticker, options.signal))
          : topOfBookOnly(rawMarket);

        markets.push({ market, quote: toQuote(market.market_id, book, timestamp) });
      }

      if (markets.length > 0) snapshots.push({ event, markets });
    }

    return snapshots;
  }

  async fetchQuotes(marketIds: string[], options: FetchOptions = {}): Promise<Quote[]> {
    const timestamp = new Date().toISOString();
    const quotes: Quote[] = [];
    for (const marketId of marketIds) {
      const ticker = this.tickerIndex.get(marketId) ?? marketId.split(':').slice(1).join(':');
      if (!ticker) continue;
      const side = await this.safeOrderBook(ticker, options.signal);
      quotes.push(toQuote(marketId, toOrderBook(side), timestamp));
    }
    return quotes;
  }

  /**
   * One depth request per market is the expensive path, so spend the budget
   * on the markets most likely to carry a real opportunity: those with the
   * most quoted size at the top of book.
   */
  private rankForDepthFetch(events: KalshiEvent[], budget: number): Set<string> {
    if (budget <= 0) return new Set();
    const scored: Array<{ ticker: string; score: number }> = [];
    for (const event of events) {
      // Multi-outcome mutually exclusive events are where basket arbitrage
      // can exist at all, so they earn priority.
      const groupBonus = event.mutually_exclusive && (event.markets?.length ?? 0) > 1 ? 1e6 : 0;
      for (const market of event.markets ?? []) {
        const size = Number(market.yes_ask_size_fp ?? '0') + Number(market.yes_bid_size_fp ?? '0');
        scored.push({ ticker: market.ticker, score: groupBonus + (Number.isFinite(size) ? size : 0) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return new Set(scored.slice(0, budget).map((s) => s.ticker));
  }

  private async safeOrderBook(ticker: string, signal?: AbortSignal) {
    try {
      return await this.client.getOrderBook(ticker, 20, signal);
    } catch {
      // A single failed book must not abort the whole cycle; the market then
      // falls back to an empty book and is simply not tradeable this pass.
      return undefined;
    }
  }
}
