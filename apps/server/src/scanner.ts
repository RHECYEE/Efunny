import {
  KalshiAdapter,
  PolymarketAdapter,
  kalshiHistory,
  polymarketHistory,
} from '@arbterminal/adapters';
import { analyze, computeMetrics, rank, type ScoredMarket } from '@arbterminal/core';

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

export class ScannerService {
  private cached: ScannerFeed | null = null;
  private cachedAt = 0;
  private inflight: Promise<ScannerFeed> | null = null;

  constructor(
    private readonly series = DEFAULT_SERIES,
    private readonly tags = DEFAULT_TAGS,
    /** Cap on history requests per cycle, since each market costs one. */
    private readonly historyBudget = 60,
  ) {}

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
      const kalshi = new KalshiAdapter({ series_tickers: this.series, market_limit: 400 });
      const polymarket = new PolymarketAdapter({ tag_slugs: this.tags, event_limit: 120 });
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

      for (const entry of kalshiEntries) {
        requested += 1;
        const ticker = entry.market.venue_market_id;
        try {
          const history = await kalshiHistory(
            ticker.split('-')[0]!,
            ticker,
            entry.market.market_id,
          );
          if (history.points.length < 6) continue;
          scored.push(
            analyze(
              computeMetrics({
                market_id: entry.market.market_id,
                venue: 'kalshi',
                title: entry.market.title,
                history,
                book: entry.quote.book,
                // One matched ladder viewed from two sides.
                independent_sides: false,
                close_time: entry.market.close_time,
              }),
            ),
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
          const history = await polymarketHistory(tokens.yes, entry.market.market_id);
          if (history.points.length < 6) continue;
          scored.push(
            analyze(
              computeMetrics({
                market_id: entry.market.market_id,
                venue: 'polymarket',
                title: entry.market.title,
                history,
                book: entry.quote.book,
                independent_sides: true,
                close_time: entry.market.close_time,
              }),
            ),
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
