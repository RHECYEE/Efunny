import { parseDecimalToDeciCents, type MarketHistory, type PricePoint } from '@arbterminal/core';

/**
 * Price history, which each venue publishes in its own shape.
 *
 * Kalshi returns candlesticks with an OHLC on each side of the book plus
 * volume and open interest. Polymarket returns a bare price series. Both are
 * flattened to the same points here rather than in the scanner, so the
 * scanner never learns that two venues exist.
 *
 * The asymmetry is worth stating plainly rather than smoothing over: a
 * Polymarket point carries no volume, so volume-derived statistics are absent
 * for that venue instead of zero. Zero would read as "nothing traded", which
 * is a claim, and the truth is "not published".
 */

export interface HistoryOptions {
  fetch_impl?: typeof fetch;
  request_timeout_ms?: number;
  /** Seconds of history to request. */
  lookback_seconds?: number;
}

/**
 * Thirty days, not seven.
 *
 * The percentiles are the point of the scanner, and a week of hourly candles
 * is 140 observations but only *seven* daily volume buckets — so "94th
 * percentile volume" was really "the busiest of seven days", which is a coin
 * flip dressed as a statistic. A month gives the distributions something to
 * stand on.
 */
const DEFAULT_LOOKBACK = 30 * 24 * 3600;

/* ------------------------------------------------------------------ *
 * Kalshi
 * ------------------------------------------------------------------ */

interface KalshiCandle {
  end_period_ts: number;
  volume_fp?: string;
  open_interest_fp?: string;
  price?: { previous_dollars?: string; mean_dollars?: string };
  yes_ask?: { close_dollars?: string };
  yes_bid?: { close_dollars?: string };
}

/**
 * The mid of a Kalshi candle.
 *
 * Preferring the mid of the closing quotes over the last trade price is
 * deliberate: an illiquid contract can go hours without a trade, and a stale
 * last-trade would show as a flat line followed by a cliff — inventing a
 * price shock out of a quote that had been drifting all along.
 */
function kalshiPrice(candle: KalshiCandle): number | null {
  const ask = candle.yes_ask?.close_dollars;
  const bid = candle.yes_bid?.close_dollars;
  if (ask && bid) {
    return Math.round(
      (parseDecimalToDeciCents(ask) + parseDecimalToDeciCents(bid)) / 2,
    );
  }
  const last = candle.price?.previous_dollars ?? candle.price?.mean_dollars;
  return last ? parseDecimalToDeciCents(last) : null;
}

export async function kalshiHistory(
  seriesTicker: string,
  marketTicker: string,
  marketId: string,
  options: HistoryOptions = {},
): Promise<MarketHistory> {
  const doFetch = options.fetch_impl ?? fetch;
  const now = Math.floor(Date.now() / 1000);
  const start = now - (options.lookback_seconds ?? DEFAULT_LOOKBACK);
  const url =
    `https://api.elections.kalshi.com/trade-api/v2/series/${encodeURIComponent(seriesTicker)}` +
    `/markets/${encodeURIComponent(marketTicker)}/candlesticks` +
    `?start_ts=${start}&end_ts=${now}&period_interval=60`;

  const response = await doFetch(url, {
    signal: AbortSignal.timeout(options.request_timeout_ms ?? 20_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Kalshi candlesticks ${response.status}`);
  const body = (await response.json()) as { candlesticks?: KalshiCandle[] };

  const points: PricePoint[] = [];
  for (const candle of body.candlesticks ?? []) {
    const price = kalshiPrice(candle);
    if (price === null) continue;
    points.push({
      t: candle.end_period_ts,
      price,
      volume: Number(candle.volume_fp ?? '0') || 0,
      open_interest: candle.open_interest_fp ? Number(candle.open_interest_fp) : null,
    });
  }
  points.sort((a, b) => a.t - b.t);
  return { market_id: marketId, venue: 'kalshi', points, has_volume: true };
}

/* ------------------------------------------------------------------ *
 * Polymarket
 * ------------------------------------------------------------------ */

interface PolymarketPoint {
  t: number;
  p: number;
}

export async function polymarketHistory(
  tokenId: string,
  marketId: string,
  options: HistoryOptions = {},
): Promise<MarketHistory> {
  const doFetch = options.fetch_impl ?? fetch;
  const lookback = options.lookback_seconds ?? DEFAULT_LOOKBACK;
  const interval = lookback <= 24 * 3600 ? '1d' : lookback <= 7 * 24 * 3600 ? '1w' : '1m';
  const url =
    `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}` +
    `&interval=${interval}&fidelity=60`;

  const response = await doFetch(url, {
    signal: AbortSignal.timeout(options.request_timeout_ms ?? 20_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Polymarket price history ${response.status}`);
  const body = (await response.json()) as { history?: PolymarketPoint[] };

  const points: PricePoint[] = (body.history ?? [])
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p))
    .map((p) => ({
      t: p.t,
      price: Math.round(p.p * 1000),
      // Not published on this endpoint. Zero here would assert that nothing
      // traded; the scanner reads an all-zero series as "no volume data" and
      // omits the volume statistics rather than reporting them as calm.
      volume: 0,
      open_interest: null,
    }));
  points.sort((a, b) => a.t - b.t);
  return { market_id: marketId, venue: 'polymarket', points, has_volume: false };
}

/* ------------------------------------------------------------------ *
 * Trades
 * ------------------------------------------------------------------ */

/**
 * Individual fills, which are a different object from a candle.
 *
 * A candle says the price moved and how much traded. It cannot say whether
 * that came from four hundred small orders or one large one, and those are
 * opposite pieces of evidence about who is doing the trading. Trade-level
 * data is the only way to tell them apart.
 */
export interface Trade {
  /** Unix seconds. */
  t: number;
  /** Contracts. */
  size: number;
  /** Price paid, in deci-cents. */
  price: number;
  /** Which side the aggressor took, where the venue says. */
  taker_side: 'YES' | 'NO' | null;
  /** Venue-flagged block or negotiated trade. */
  block: boolean;
}

interface KalshiTrade {
  created_time?: string;
  count_fp?: string;
  count?: number;
  yes_price_dollars?: string;
  taker_side?: string;
  is_block_trade?: boolean;
}

export async function kalshiTrades(
  ticker: string,
  options: HistoryOptions & { limit?: number } = {},
): Promise<Trade[]> {
  const doFetch = options.fetch_impl ?? fetch;
  const url =
    `https://api.elections.kalshi.com/trade-api/v2/markets/trades` +
    `?ticker=${encodeURIComponent(ticker)}&limit=${options.limit ?? 200}`;
  const response = await doFetch(url, {
    signal: AbortSignal.timeout(options.request_timeout_ms ?? 20_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Kalshi trades ${response.status}`);
  const body = (await response.json()) as { trades?: KalshiTrade[] };

  const out: Trade[] = [];
  for (const trade of body.trades ?? []) {
    const size = Number(trade.count_fp ?? trade.count ?? 0);
    if (!Number.isFinite(size) || size <= 0) continue;
    out.push({
      t: Math.floor(Date.parse(trade.created_time ?? '') / 1000),
      size,
      price: trade.yes_price_dollars ? parseDecimalToDeciCents(trade.yes_price_dollars) : 0,
      taker_side:
        trade.taker_side === 'yes' ? 'YES' : trade.taker_side === 'no' ? 'NO' : null,
      block: trade.is_block_trade === true,
    });
  }
  return out.filter((t) => Number.isFinite(t.t)).sort((a, b) => a.t - b.t);
}

interface PolymarketTrade {
  size?: number;
  price?: number;
  timestamp?: number;
  side?: string;
  asset?: string;
}

/**
 * Fills for one Polymarket market, keyed by *condition id*.
 *
 * Not by token id. The endpoint accepts an `asset` parameter and appears to
 * work, but it does not filter on it — asking for a politics token returns
 * trades from an unrelated esports match, and every one of them would have
 * been attributed to the market that asked. `market=<conditionId>` is the
 * parameter that actually narrows the result, which is worth stating plainly
 * because the broken one fails silently and looks like data.
 */
export async function polymarketTrades(
  conditionId: string,
  options: HistoryOptions & { limit?: number } = {},
): Promise<Trade[]> {
  const doFetch = options.fetch_impl ?? fetch;
  const url =
    `https://data-api.polymarket.com/trades?market=${encodeURIComponent(conditionId)}` +
    `&limit=${options.limit ?? 200}`;
  const response = await doFetch(url, {
    signal: AbortSignal.timeout(options.request_timeout_ms ?? 20_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Polymarket trades ${response.status}`);
  const body = (await response.json()) as PolymarketTrade[];

  return (Array.isArray(body) ? body : [])
    .filter((t) => Number.isFinite(t.size) && Number.isFinite(t.timestamp))
    .map((t) => ({
      t: Number(t.timestamp),
      size: Number(t.size),
      price: Math.round(Number(t.price ?? 0) * 1000),
      taker_side: t.side === 'BUY' ? ('YES' as const) : t.side === 'SELL' ? ('NO' as const) : null,
      // Polymarket does not flag block trades on this feed.
      block: false,
    }))
    .sort((a, b) => a.t - b.t);
}
