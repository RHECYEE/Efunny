/**
 * Kalshi HTTP client.
 *
 * Read-only. Every endpoint used here is the public market-data surface and
 * needs no credentials — market discovery, event nesting and order books are
 * all unauthenticated. Nothing in this client can place, cancel or amend an
 * order, and no order-entry endpoint is referenced anywhere in the codebase.
 */

export const KALSHI_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type?: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  open_time?: string;
  close_time?: string;
  expiration_time?: string;
  expected_expiration_time?: string;
  rules_primary?: string;
  rules_secondary?: string;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
  floor_strike_dollars?: string;
  cap_strike_dollars?: string;
  custom_strike?: Record<string, string>;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  yes_bid_size_fp?: string;
  yes_ask_size_fp?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  volume_24h_fp?: string;
  open_interest_fp?: string;
  liquidity_dollars?: string;
  notional_value_dollars?: string;
  early_close_condition?: string;
  can_close_early?: boolean;
  settlement_timer_seconds?: number;
  result?: string;
}

export interface KalshiSettlementSource {
  name?: string;
  url?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker?: string;
  title: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive?: boolean;
  strike_period?: string;
  settlement_sources?: KalshiSettlementSource[];
  markets?: KalshiMarket[];
}

export interface KalshiOrderBookSide {
  /** `[price_in_dollars, size]` pairs, ascending by price. These are *bids*. */
  yes_dollars?: Array<[string, string]>;
  no_dollars?: Array<[string, string]>;
}

export interface KalshiOrderBookResponse {
  orderbook_fp?: KalshiOrderBookSide;
  orderbook?: KalshiOrderBookSide;
}

export interface KalshiClientOptions {
  base_url?: string;
  /** Minimum gap between requests, in ms. Kalshi's public read tier is generous
   *  but not unlimited; 120ms (~8 req/s) stays well inside it. */
  min_request_interval_ms?: number;
  max_retries?: number;
  timeout_ms?: number;
  fetch_impl?: typeof fetch;
  user_agent?: string;
}

const DEFAULTS = {
  base_url: KALSHI_BASE_URL,
  min_request_interval_ms: 120,
  max_retries: 3,
  timeout_ms: 15_000,
  user_agent: 'ArbTerminal/0.1 (read-only market analysis)',
};

export class KalshiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'KalshiApiError';
  }
}

export class KalshiClient {
  private readonly options: Required<Omit<KalshiClientOptions, 'fetch_impl'>> & {
    fetch_impl: typeof fetch;
  };
  private nextAllowedAt = 0;
  /** Serializes requests so the rate limiter is not raced by concurrency. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: KalshiClientOptions = {}) {
    this.options = {
      ...DEFAULTS,
      ...options,
      fetch_impl: options.fetch_impl ?? globalThis.fetch.bind(globalThis),
    };
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.options.min_request_interval_ms;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private async request<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal): Promise<T> {
    const url = new URL(`${this.options.base_url}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.max_retries; attempt += 1) {
      await this.throttle();
      const timeout = AbortSignal.timeout(this.options.timeout_ms);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await this.options.fetch_impl(url.toString(), {
          headers: { accept: 'application/json', 'user-agent': this.options.user_agent },
          signal: combined,
        });
        if (response.status === 429 || response.status >= 500) {
          // Back off and retry: rate limiting and 5xx are both transient.
          lastError = new KalshiApiError(
            `Kalshi returned ${response.status}`,
            response.status,
            path,
          );
          await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
          continue;
        }
        if (!response.ok) {
          throw new KalshiApiError(
            `Kalshi returned ${response.status}: ${await response.text().catch(() => '')}`,
            response.status,
            path,
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof KalshiApiError && error.status < 500 && error.status !== 429) throw error;
        lastError = error;
        if (signal?.aborted) throw error;
        await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new KalshiApiError('Kalshi request failed', 0, path);
  }

  /**
   * Open events with their markets nested, following the cursor until
   * `limit` markets have been collected.
   */
  async listEvents(options: {
    limit?: number;
    status?: string;
    signal?: AbortSignal;
  } = {}): Promise<KalshiEvent[]> {
    const target = options.limit ?? 200;
    const collected: KalshiEvent[] = [];
    let cursor: string | undefined;
    let marketCount = 0;

    while (marketCount < target) {
      const page = await this.request<{ events?: KalshiEvent[]; cursor?: string }>(
        '/events',
        {
          limit: 200,
          status: options.status ?? 'open',
          with_nested_markets: true,
          cursor,
        },
        options.signal,
      );
      const events = page.events ?? [];
      if (events.length === 0) break;
      collected.push(...events);
      marketCount += events.reduce((sum, e) => sum + (e.markets?.length ?? 0), 0);
      cursor = page.cursor;
      if (!cursor) break;
    }
    return collected;
  }

  async getOrderBook(
    ticker: string,
    depth = 20,
    signal?: AbortSignal,
  ): Promise<KalshiOrderBookSide> {
    const response = await this.request<KalshiOrderBookResponse>(
      `/markets/${encodeURIComponent(ticker)}/orderbook`,
      { depth },
      signal,
    );
    return response.orderbook_fp ?? response.orderbook ?? {};
  }

  async getMarket(ticker: string, signal?: AbortSignal): Promise<KalshiMarket | null> {
    const response = await this.request<{ market?: KalshiMarket }>(
      `/markets/${encodeURIComponent(ticker)}`,
      {},
      signal,
    );
    return response.market ?? null;
  }
}
