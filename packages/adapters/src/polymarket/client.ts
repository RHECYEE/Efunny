/**
 * Polymarket HTTP client.
 *
 * Two services, because Polymarket splits them: Gamma carries the market
 * catalogue (questions, outcomes, resolution source, fee schedule) and the
 * CLOB carries the order books. Nothing here needs an API key — both are
 * public read endpoints — which is what makes Polymarket usable as a real
 * second exchange rather than something a user has to photograph.
 */

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

/** Books are fetched in batches; the endpoint takes a list of token ids. */
const BOOK_BATCH_SIZE = 40;

export interface PolymarketFeeSchedule {
  rate: number;
  exponent?: number;
  takerOnly?: boolean;
  rebateRate?: number;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  groupItemTitle?: string;
  /** JSON-encoded array of two token ids: [yes, no]. */
  clobTokenIds?: string;
  /** JSON-encoded array of outcome names, normally ["Yes", "No"]. */
  outcomes?: string;
  outcomePrices?: string;
  description?: string;
  resolutionSource?: string;
  endDate?: string;
  endDateIso?: string;
  startDate?: string;
  closed?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  negRisk?: boolean;
  feesEnabled?: boolean;
  feeSchedule?: PolymarketFeeSchedule;
  bestBid?: number;
  bestAsk?: number;
  liquidityNum?: number;
  volumeNum?: number;
}

export interface PolymarketEvent {
  id: string;
  ticker?: string;
  slug: string;
  title: string;
  description?: string;
  endDate?: string;
  startDate?: string;
  closed?: boolean;
  active?: boolean;
  negRisk?: boolean;
  tags?: Array<{ id: string; label?: string; slug?: string }>;
  markets?: PolymarketMarket[];
}

export interface PolymarketBookLevel {
  price: string;
  size: string;
}

export interface PolymarketBook {
  asset_id: string;
  market?: string;
  tick_size?: string;
  asks?: PolymarketBookLevel[];
  bids?: PolymarketBookLevel[];
}

export interface PolymarketClientOptions {
  gamma_base?: string;
  clob_base?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch_impl?: typeof fetch;
  request_timeout_ms?: number;
}

export class PolymarketClient {
  private readonly gamma: string;
  private readonly clob: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PolymarketClientOptions = {}) {
    this.gamma = options.gamma_base ?? GAMMA_BASE;
    this.clob = options.clob_base ?? CLOB_BASE;
    this.fetchImpl = options.fetch_impl ?? fetch;
    this.timeoutMs = options.request_timeout_ms ?? 15_000;
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(url, {
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Polymarket ${response.status} for ${url}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Open events, optionally narrowed to a tag.
   *
   * Tag narrowing is the equivalent of Kalshi's series targeting: it is the
   * difference between pulling the whole exchange and pulling the handful of
   * events another venue also prices.
   */
  async events(
    options: { limit?: number; tag_slug?: string; signal?: AbortSignal } = {},
  ): Promise<PolymarketEvent[]> {
    const params = new URLSearchParams({
      closed: 'false',
      active: 'true',
      limit: String(options.limit ?? 200),
    });
    if (options.tag_slug) params.set('tag_slug', options.tag_slug);
    const body = await this.getJson<PolymarketEvent[]>(
      `${this.gamma}/events?${params.toString()}`,
      options.signal,
    );
    return Array.isArray(body) ? body : [];
  }

  /**
   * Order books for a set of CLOB token ids.
   *
   * Both sides of a Polymarket market are separate ERC-1155 tokens with
   * separate books, so a two-outcome market costs two token ids. They are
   * fetched together and matched back up by `asset_id`.
   */
  async books(tokenIds: string[], signal?: AbortSignal): Promise<Map<string, PolymarketBook>> {
    const out = new Map<string, PolymarketBook>();
    for (let i = 0; i < tokenIds.length; i += BOOK_BATCH_SIZE) {
      const batch = tokenIds.slice(i, i + BOOK_BATCH_SIZE);
      const response = await this.fetchImpl(`${this.clob}/books`, {
        method: 'POST',
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(batch.map((token_id) => ({ token_id }))),
      });
      if (!response.ok) throw new Error(`Polymarket CLOB ${response.status} on /books`);
      const books = (await response.json()) as PolymarketBook[];
      for (const book of books ?? []) {
        if (book?.asset_id) out.set(book.asset_id, book);
      }
    }
    return out;
  }
}
