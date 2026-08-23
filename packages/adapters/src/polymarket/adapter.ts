import type { EventSnapshot, MarketSnapshot, MarketTier, Quote } from '@arbterminal/core';
import type { AdapterCapabilities, FetchOptions, VenueAdapter } from '../types.js';
import { PolymarketClient, type PolymarketClientOptions } from './client.js';
import { PolymarketFeeModel } from './fees.js';
import {
  POLYMARKET_VENUE,
  categoryOf,
  detectExhaustive,
  isTradeable,
  toEvent,
  toMarket,
  toOrderBook,
  toQuote,
  tokenIdsOf,
} from './normalize.js';

export interface PolymarketAdapterOptions extends PolymarketClientOptions {
  client?: PolymarketClient;
  /** Events pulled per cycle. */
  event_limit?: number;
  /**
   * Tags to sweep instead of the whole exchange, e.g. `['ufc', 'politics']`.
   * The same lever as Kalshi's series targeting, for the same reason: a
   * narrow sweep is a couple of requests and a broad one is a minute.
   */
  tag_slugs?: string[];
}

/**
 * Polymarket adapter.
 *
 * The venue this app was really waiting for. A sportsbook capture can only
 * ever be a photograph of one price with an assumed size behind it; this is a
 * live exchange with a published ladder and a named resolution source, which
 * is what a cross-venue hedge needs before it can honestly be called
 * certified rather than merely plausible.
 */
export class PolymarketAdapter implements VenueAdapter {
  readonly venue = POLYMARKET_VENUE;
  readonly display_name = 'Polymarket';
  readonly fee_model = new PolymarketFeeModel();
  readonly capabilities: AdapterCapabilities = {
    order_book_depth: true,
    // Unlike Kalshi, YES and NO are separate tokens with separate books, so
    // the two sides can be quoted independently.
    independent_two_sided_asks: true,
    settlement_rules_text: true,
    mutually_exclusive_groups: true,
    sports_market_types: ['MONEYLINE', 'FUTURES'],
  };

  private readonly client: PolymarketClient;
  private readonly eventLimit: number;
  private readonly tagSlugs: string[];
  /** canonical market id -> clob token ids, for `fetchQuotes`. */
  private readonly tokenIndex = new Map<string, { yes: string | null; no: string | null }>();
  /** canonical market id -> the normalized market, for `fetchQuotes`. */
  private readonly marketIndex = new Map<string, MarketSnapshot['market']>();

  constructor(options: PolymarketAdapterOptions = {}) {
    this.client = options.client ?? new PolymarketClient(options);
    this.eventLimit = options.event_limit ?? 200;
    this.tagSlugs = options.tag_slugs ?? [];
  }

  async fetchSnapshots(options: FetchOptions = {}): Promise<EventSnapshot[]> {
    const events = await this.collectEvents(options);
    const now = new Date().toISOString();

    // One pass to work out which books are needed, then one batched fetch.
    const wanted: string[] = [];
    for (const event of events) {
      for (const market of event.markets ?? []) {
        if (!isTradeable(market)) continue;
        const { yes, no } = tokenIdsOf(market);
        if (yes) wanted.push(yes);
        if (no) wanted.push(no);
      }
    }

    const books =
      options.with_depth === false || wanted.length === 0
        ? new Map()
        : await this.client.books(wanted, options.signal);

    const snapshots: EventSnapshot[] = [];
    for (const event of events) {
      const category = categoryOf(event);
      const eventId = toEvent(event, []).event_id;
      const tier = category === 'SPORTS' ? this.tierFor(event) : 'NON_SPORT';

      // Counted, not ignored: a dropped outcome is the difference between a
      // complete outcome set and a set that merely looks complete.
      let dropped = 0;
      const marketSnapshots: MarketSnapshot[] = [];
      for (const raw of event.markets ?? []) {
        if (!isTradeable(raw)) {
          dropped += 1;
          continue;
        }
        const { yes, no } = tokenIdsOf(raw);
        const market = toMarket(raw, event, {
          category,
          eventId,
          tier: this.tierForMarket(raw, tier),
        });
        const book = toOrderBook(
          yes ? books.get(yes) : undefined,
          no ? books.get(no) : undefined,
        );
        // A market with no readable book prices nothing. Carrying it as an
        // empty ladder would let it be matched and then sized at zero.
        if (book.yes_asks.length === 0 && book.no_asks.length === 0) {
          dropped += 1;
          continue;
        }

        this.fee_model.declare(
          market.market_id,
          raw.feeSchedule?.rate ?? null,
          raw.feesEnabled !== false,
          category,
        );
        this.tokenIndex.set(market.market_id, { yes, no });
        this.marketIndex.set(market.market_id, market);

        marketSnapshots.push({ market, quote: toQuote(raw, market, book, now) });
      }

      if (marketSnapshots.length === 0) continue;
      snapshots.push({
        event: toEvent(
          event,
          marketSnapshots.map((m) => m.market),
          dropped,
        ),
        markets: marketSnapshots,
      });
    }

    return snapshots;
  }

  /**
   * CLOB token ids for a market this adapter has already seen.
   *
   * Price history is per *token*, not per market, and the mapping only exists
   * inside this adapter — deriving it anywhere else would mean re-deriving
   * Polymarket's two-token structure outside the one file that is allowed to
   * know about it.
   */
  tokensFor(marketId: string): { yes: string | null; no: string | null } | null {
    return this.tokenIndex.get(marketId) ?? null;
  }

  async fetchQuotes(marketIds: string[], options: FetchOptions = {}): Promise<Quote[]> {
    const wanted: string[] = [];
    for (const id of marketIds) {
      const tokens = this.tokenIndex.get(id);
      if (tokens?.yes) wanted.push(tokens.yes);
      if (tokens?.no) wanted.push(tokens.no);
    }
    if (wanted.length === 0) return [];

    const books = await this.client.books(wanted, options.signal);
    const now = new Date().toISOString();

    const quotes: Quote[] = [];
    for (const id of marketIds) {
      const tokens = this.tokenIndex.get(id);
      const market = this.marketIndex.get(id);
      if (!tokens || !market) continue;
      const book = toOrderBook(
        tokens.yes ? books.get(tokens.yes) : undefined,
        tokens.no ? books.get(tokens.no) : undefined,
      );
      quotes.push(toQuote({ id: market.venue_market_id } as never, market, book, now));
    }
    return quotes;
  }

  /**
   * Sports tier.
   *
   * A single fight's winner and "champion at the end of the year" are both
   * SPORTS, and comparing one against the other would be nonsense however
   * well the names matched — so the distinction is drawn here, at the point
   * the venue's own wording is still available. "X vs. Y" is a contest;
   * anything else priced against a season is a future.
   */
  private tierFor(event: { title?: string }): 'GAME' | 'FUTURES' {
    const title = event.title ?? '';
    return /\bvs\.?\b|\bversus\b/i.test(title) ? 'GAME' : 'FUTURES';
  }

  /**
   * A contest event carries more than the contest.
   *
   * Polymarket lists a fight alongside nine props about it — go the distance,
   * won by KO, won by submission. They share an event and a deadline, and if
   * they also shared a tier the standing rule that tiers are never
   * cross-compared would be silently unenforceable exactly where it matters
   * most: "Kai Asakura wins" and "this fight ends by KO" are not the same bet
   * and no price makes them one.
   *
   * The discriminator is the venue's own group title: the contest market is
   * the one titled with the matchup itself. Reading it off the outcome list
   * instead is not enough — a round total also names two outcomes, and
   * "Over" and "Under" would pass for fighters.
   */
  private tierForMarket(
    raw: { groupItemTitle?: string; question?: string },
    eventTier: 'GAME' | 'FUTURES' | 'NON_SPORT',
  ): MarketTier {
    if (eventTier !== 'GAME') return eventTier;
    const group = raw.groupItemTitle ?? '';
    return /\bvs\.?\b|\bversus\b/i.test(group) ? 'GAME' : 'TEAM_PROP';
  }

  private async collectEvents(options: FetchOptions) {
    if (this.tagSlugs.length === 0) {
      return this.client.events({
        limit: options.limit ?? this.eventLimit,
        signal: options.signal,
      });
    }

    const seen = new Set<string>();
    const all = [];
    for (const tag of this.tagSlugs) {
      const batch = await this.client.events({
        limit: options.limit ?? this.eventLimit,
        tag_slug: tag,
        signal: options.signal,
      });
      for (const event of batch) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        all.push(event);
      }
    }
    return all;
  }
}
