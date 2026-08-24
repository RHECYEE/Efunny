import { KalshiAdapter } from '../kalshi/adapter.js';
import { PolymarketAdapter } from '../polymarket/adapter.js';
import {
  kalshiHistory,
  kalshiTrades,
  polymarketHistory,
  polymarketTrades,
} from '../history/index.js';
import {
  analyze,
  computeMetrics,
  computeReversion,
  computeTradeMetrics,
  findCrossMarketGaps,
  rank,
  type CrossMarketGap,
  type ScoredMarket,
} from '@arbterminal/core';

/**
 * The market scanner.
 *
 * Fetching a month of history per market is one request each, so the scan is
 * bounded by request count rather than by anything clever — it takes a
 * configured set of series and tags rather than sweeping ninety thousand
 * Kalshi markets. Results are cached, because a month of history does not
 * change meaningfully in a minute and the venues should not be asked to
 * re-serve it per browser tab.
 */

const TTL_MS = 5 * 60 * 1000;

/** Series worth watching by default. Kept as data, not policy. */
const DEFAULT_SERIES = [
  'KXFEDDECISION',
  'KXBTCMAXY',
  'KXETHMAXY',
  'KXPRESPARTYWIN',
  'KXCPIYOY',
  'KXRECSSNBER',
];

const DEFAULT_TAGS = ['politics', 'crypto', 'economics'];

export interface ScannerFeed {
  markets: ScoredMarket[];
  scanned_at: string;
  counts: { requested: number; with_history: number; failed: number };
  error: string | null;
}

/**
 * How the service reaches the venues, and how hard it is allowed to work.
 *
 * The transport is injected rather than assumed because a phone cannot use
 * the global one: Kalshi rejects any request carrying an `Origin` header, and
 * a WebView `fetch` always attaches one. The budgets are separate for the
 * same reason — sixty history requests is a few seconds on a server and a
 * visibly stalled screen on a handset.
 */
export interface ScannerOptions {
  fetch_impl?: typeof fetch;
  series?: string[];
  tags?: string[];
  /** Cap on history requests per cycle, since each market costs one. */
  history_budget?: number;
  request_timeout_ms?: number;
  /** Markets pulled from each venue before the budget is spent on them. */
  kalshi_market_limit?: number;
  polymarket_event_limit?: number;
}

export class ScannerService {
  private cached: ScannerFeed | null = null;
  private cachedAt = 0;
  private inflight: Promise<ScannerFeed> | null = null;

  private readonly series: string[];
  private readonly tags: string[];
  private readonly historyBudget: number;
  private readonly options: ScannerOptions;

  constructor(options: ScannerOptions = {}) {
    this.options = options;
    this.series = options.series ?? DEFAULT_SERIES;
    this.tags = options.tags ?? DEFAULT_TAGS;
    this.historyBudget = options.history_budget ?? 60;
  }

  /** Options every history and trade call shares. */
  private get io(): { fetch_impl?: typeof fetch; request_timeout_ms?: number } {
    return {
      fetch_impl: this.options.fetch_impl,
      request_timeout_ms: this.options.request_timeout_ms,
    };
  }

  async feed(): Promise<ScannerFeed> {
    if (this.cached && Date.now() - this.cachedAt < TTL_MS) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.build().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async build(): Promise<ScannerFeed> {
    const scannedAt = new Date().toISOString();
    const scored: ScoredMarket[] = [];
    let requested = 0;
    let failed = 0;

    try {
      const kalshi = new KalshiAdapter({
        series_tickers: this.series,
        market_limit: this.options.kalshi_market_limit ?? 400,
        fetch_impl: this.options.fetch_impl,
        timeout_ms: this.options.request_timeout_ms,
      });
      const polymarket = new PolymarketAdapter({
        tag_slugs: this.tags,
        event_limit: this.options.polymarket_event_limit ?? 120,
        fetch_impl: this.options.fetch_impl,
        request_timeout_ms: this.options.request_timeout_ms,
      });
      const [k, p] = await Promise.all([
        kalshi.fetchSnapshots().catch(() => []),
        polymarket.fetchSnapshots().catch(() => []),
      ]);

      // Spend the request budget on the markets most likely to repay it:
      // the ones with the most size behind them.
      const kalshiEntries = k
        .flatMap((s) => s.markets)
        .sort((a, b) => (b.quote.liquidity ?? 0) - (a.quote.liquidity ?? 0))
        .slice(0, Math.ceil(this.historyBudget * 0.7));
      const polyEntries = p
        .flatMap((s) => s.markets)
        .sort((a, b) => (b.quote.liquidity ?? 0) - (a.quote.liquidity ?? 0))
        .slice(0, Math.floor(this.historyBudget * 0.3));

      // Cross-market gaps are computed once over everything, then attached
      // per market — the pairing is symmetric and doing it per row would
      // repeat the same comparison in both directions.
      const gaps = findCrossMarketGaps([...kalshiEntries, ...polyEntries]);
      const gapsFor = (marketId: string) =>
        gaps
          .filter((g) => g.left_market_id === marketId || g.right_market_id === marketId)
          .map((g: CrossMarketGap) =>
            g.left_market_id === marketId
              ? { venue: g.right_venue, gap: g.gap, their_price: g.right_price }
              : { venue: g.left_venue, gap: g.gap, their_price: g.left_price },
          );

      for (const entry of kalshiEntries) {
        requested += 1;
        const ticker = entry.market.venue_market_id;
        try {
          const [history, trades] = await Promise.all([
            kalshiHistory(ticker.split('-')[0]!, ticker, entry.market.market_id, this.io),
            kalshiTrades(ticker, this.io).catch(() => []),
          ]);
          if (history.points.length < 6) continue;
          const metrics = computeMetrics({
            market_id: entry.market.market_id,
            venue: 'kalshi',
            title: entry.market.title,
            history,
            book: entry.quote.book,
            // One matched ladder viewed from two sides.
            independent_sides: false,
            close_time: entry.market.close_time,
          });
          scored.push(
            analyze(metrics, {
              trades: computeTradeMetrics(trades),
              reversion: computeReversion(metrics, history),
              cross_market: gapsFor(entry.market.market_id),
            }),
          );
        } catch {
          failed += 1;
        }
      }

      for (const entry of polyEntries) {
        requested += 1;
        try {
          const tokens = polymarket.tokensFor(entry.market.market_id);
          if (!tokens?.yes) continue;
          const condition = polymarket.conditionFor(entry.market.market_id);
          const [history, trades] = await Promise.all([
            polymarketHistory(tokens.yes, entry.market.market_id, this.io),
            condition ? polymarketTrades(condition, this.io).catch(() => []) : Promise.resolve([]),
          ]);
          if (history.points.length < 6) continue;
          const metrics = computeMetrics({
            market_id: entry.market.market_id,
            venue: 'polymarket',
            title: entry.market.title,
            history,
            book: entry.quote.book,
            independent_sides: true,
            close_time: entry.market.close_time,
          });
          scored.push(
            analyze(metrics, {
              trades: computeTradeMetrics(trades),
              reversion: computeReversion(metrics, history),
              cross_market: gapsFor(entry.market.market_id),
            }),
          );
        } catch {
          failed += 1;
        }
      }

      const feed: ScannerFeed = {
        markets: rank(scored),
        scanned_at: scannedAt,
        counts: { requested, with_history: scored.length, failed },
        error: null,
      };
      this.cached = feed;
      this.cachedAt = Date.now();
      return feed;
    } catch (error) {
      return {
        markets: this.cached?.markets ?? [],
        scanned_at: scannedAt,
        counts: { requested, with_history: scored.length, failed },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
