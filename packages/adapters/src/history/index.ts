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
