/** Runtime configuration, all overridable by environment variable. */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num('PORT', 8787),
  host: process.env.HOST ?? '127.0.0.1',
  /** Where the quote log and paper-trade history live. */
  database_path: process.env.ARBTERMINAL_DB ?? 'data/arbterminal.sqlite',
  /** Seconds between ingestion cycles. */
  poll_interval_ms: num('POLL_INTERVAL_MS', 30_000),
  /** Markets pulled per cycle. */
  market_limit: num('MARKET_LIMIT', 600),
  /** Markets given a full depth fetch per cycle (one request each). */
  depth_fetch_limit: num('DEPTH_FETCH_LIMIT', 150),
  /** Quotes older than this are flagged stale on every opportunity. */
  stale_quote_ms: num('STALE_QUOTE_MS', 90_000),
  /** Minimum executable edge, in deci-cents per $1, to keep an opportunity. */
  min_net_edge: num('MIN_NET_EDGE', 1),
  /** Days of quote history to retain. */
  history_retention_days: num('HISTORY_RETENTION_DAYS', 14),
  /** Set to "1" to skip the live poller, e.g. in tests. */
  disable_poller: process.env.DISABLE_POLLER === '1',
} as const;
