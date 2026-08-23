import {
  EMPTY_BOOK,
  canonicalEventId,
  canonicalOutcomeId,
  marketId as makeMarketId,
  parseDecimalToDeciCents,
  priceToProbability,
  quoteId as makeQuoteId,
  venueApiProvenance,
  type BookLevel,
  type Event,
  type EventCategory,
  type Market,
  type MarketTier,
  type OrderBook,
  type Quote,
  type SettlementSpec,
} from '@arbterminal/core';
import type { PolymarketBook, PolymarketEvent, PolymarketMarket } from './client.js';

export const POLYMARKET_VENUE = 'polymarket';

/* ------------------------------------------------------------------ *
 * Category
 * ------------------------------------------------------------------ */

const CATEGORY_MAP: Array<[RegExp, EventCategory]> = [
  [/politic|election|congress|senate|president|nominee/i, 'POLITICS'],
  [/econom|inflation|\bfed\b|cpi|gdp|jobs|rate cut/i, 'ECONOMICS'],
  [/sport|nfl|nba|mlb|nhl|soccer|tennis|golf|ufc|mma|olympic|boxing/i, 'SPORTS'],
  [/climate|weather|temperature|hurricane/i, 'CLIMATE'],
  [/crypto|bitcoin|ethereum|\bbtc\b|\beth\b|solana/i, 'CRYPTO'],
  [/compan|business|earnings|stock|ipo/i, 'COMPANIES'],
  [/culture|entertainment|music|film|award|\btv\b/i, 'CULTURE'],
  [/geopolit|world|ukraine|israel|nato|war\b/i, 'WORLD'],
];

/**
 * Category from the event's own tags first, then its title.
 *
 * Tags are what Polymarket actually files a market under, and the fee rate
 * follows the category — so guessing from the title when a tag is present
 * would price the trade wrong, not merely label it wrong.
 */
export function categoryOf(event: PolymarketEvent): EventCategory {
  const tagText = (event.tags ?? [])
    .map((t) => `${t.label ?? ''} ${t.slug ?? ''}`)
    .join(' ');
  for (const [pattern, category] of CATEGORY_MAP) {
    if (pattern.test(tagText)) return category;
  }
  for (const [pattern, category] of CATEGORY_MAP) {
    if (pattern.test(event.title ?? '')) return category;
  }
  return 'OTHER';
}

/* ------------------------------------------------------------------ *
 * Wire helpers
 * ------------------------------------------------------------------ */

/** Gamma encodes small arrays as JSON strings inside the JSON. */
export function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

export function tokenIdsOf(market: PolymarketMarket): { yes: string | null; no: string | null } {
  const ids = parseJsonArray(market.clobTokenIds);
  return { yes: ids[0] ?? null, no: ids[1] ?? null };
}

/**
 * A CLOB side into our ladder, best price first.
 *
 * Polymarket returns both sides ascending by price, which means asks arrive
 * worst-first and bids best-last. Getting this backwards would size a
 * position against the least attractive level in the book and quietly report
 * a worse edge than exists — or, on the bid side, a better one.
 */
export function toLadder(
  levels: Array<{ price: string; size: string }> | undefined,
  side: 'ASK' | 'BID',
): BookLevel[] {
  const parsed = (levels ?? [])
    .map((l) => ({ price: parseDecimalToDeciCents(l.price), size: Number(l.size) }))
    .filter((l) => l.price > 0 && l.price < 1000 && Number.isFinite(l.size) && l.size > 0);

  parsed.sort((a, b) => (side === 'ASK' ? a.price - b.price : b.price - a.price));
  return parsed;
}

/**
 * Both sides of a Polymarket market are separate tokens with separate books.
 *
 * That is a real structural difference from Kalshi, where one matched ladder
 * is viewed from two sides and the complement is arithmetic. Here the YES and
 * NO books are quoted independently and can genuinely disagree, so they are
 * carried through as independent ladders rather than derived from each other.
 */
export function toOrderBook(
  yesBook: PolymarketBook | undefined,
  noBook: PolymarketBook | undefined,
): OrderBook {
  if (!yesBook && !noBook) return EMPTY_BOOK;
  return {
    yes_asks: toLadder(yesBook?.asks, 'ASK'),
    yes_bids: toLadder(yesBook?.bids, 'BID'),
    no_asks: toLadder(noBook?.asks, 'ASK'),
    no_bids: toLadder(noBook?.bids, 'BID'),
  };
}

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

/**
 * Settlement as Polymarket states it.
 *
 * `resolutionSource` is the field that makes a Kalshi pairing checkable at
 * all — it names the authority the UMA oracle is meant to read. When it is
 * empty the gap stays visible rather than being filled with the description,
 * which is rules prose and would diff badly against another venue's wording.
 */
export function toSettlement(market: PolymarketMarket): SettlementSpec {
  return {
    settlement_source: (market.resolutionSource ?? '').trim(),
    settlement_rules_text: (market.description ?? '').trim(),
    void_rules: '',
    overtime_rules: '',
  };
}

/* ------------------------------------------------------------------ *
 * Exhaustiveness
 * ------------------------------------------------------------------ */

/**
 * A catch-all outcome is what turns a mutually exclusive set into an
 * exhaustive one — without one, every YES leg can lose together.
 */
const CATCH_ALL_PATTERNS = [
  /\bany other\b/i,
  /\bnone of the above\b/i,
  /\bsomeone else\b/i,
  /\banother (?:candidate|person|team|option|fighter|opponent)\b/i,
  /\bno one\b/i,
  /\bother\b\s*$/i,
];

/**
 * Whether a neg-risk group may be treated as exhaustive.
 *
 * Neg-risk establishes *mutual exclusivity*: at most one outcome resolves
 * YES, which is enough for a NO basket. It is not enough for a YES basket,
 * and treating it as such is how this venue produced its first false
 * positives here — a group whose winner had already resolved still looked
 * like twelve outcomes costing a tenth of a cent each for a guaranteed
 * dollar, because the outcome that had actually won was no longer quoting a
 * book and had been filtered out of the very set being called complete.
 *
 * So exhaustiveness needs two things beyond the flag: every outcome in the
 * group still present, and a catch-all covering the cases nobody listed.
 */
export function detectExhaustive(
  event: PolymarketEvent,
  presentLabels: string[] = [],
  droppedCount = 0,
): { exhaustive: boolean; basis: string } {
  if (!event.negRisk) {
    return {
      exhaustive: false,
      basis: 'not a neg-risk group, so nothing states these outcomes are exhaustive',
    };
  }
  if (droppedCount > 0) {
    return {
      exhaustive: false,
      basis:
        `neg-risk group, but ${droppedCount} of its outcomes are not quoting a book — ` +
        `an outcome that has already resolved stops quoting, and a basket missing the ` +
        `winner is not a hedge`,
    };
  }
  const catchAll = presentLabels.find((label) => CATCH_ALL_PATTERNS.some((p) => p.test(label)));
  if (catchAll) {
    return {
      exhaustive: true,
      basis:
        `Polymarket neg-risk group with catch-all outcome "${catchAll}", so exactly one ` +
        `outcome must resolve YES`,
    };
  }
  return {
    exhaustive: false,
    basis:
      'neg-risk group establishes mutual exclusivity but names no catch-all outcome, so ' +
      'every listed outcome can miss',
  };
}

/* ------------------------------------------------------------------ *
 * Markets, quotes, events
 * ------------------------------------------------------------------ */

/** A market is tradeable only if the venue says it is taking orders. */
export function isTradeable(market: PolymarketMarket): boolean {
  return (
    market.closed !== true &&
    market.active !== false &&
    market.acceptingOrders !== false &&
    market.enableOrderBook !== false
  );
}

export interface NormalizeContext {
  category: EventCategory;
  eventId: string;
  /** Sports markets need a tier; everything else is NON_SPORT. */
  tier: MarketTier;
}

/**
 * What YES and NO actually pay on.
 *
 * Most Polymarket markets are `["Yes", "No"]` and the group item title is the
 * proposition. A head-to-head contest is not: its outcomes are two people,
 * and YES is the *first* of them. Reading the label off `groupItemTitle`
 * there yields "Song Yadong vs. Umar Nurmagomedov", which names both fighters
 * and identifies neither — and a hedge built on it can back the same man on
 * both venues while reporting itself as a hedge.
 */
export function outcomeLabels(market: PolymarketMarket): { yes: string; no: string | null } {
  const outcomes = parseJsonArray(market.outcomes);
  const first = (outcomes[0] ?? '').trim();
  const second = (outcomes[1] ?? '').trim();
  const plainBinary = /^(yes|no)$/i.test(first);

  if (!plainBinary && first !== '') {
    return { yes: first, no: second !== '' ? second : null };
  }
  return { yes: (market.groupItemTitle ?? market.question ?? '').trim(), no: null };
}

export function toMarket(
  market: PolymarketMarket,
  event: PolymarketEvent,
  context: NormalizeContext,
): Market {
  const labels = outcomeLabels(market);
  const label = labels.yes;
  const provenance = venueApiProvenance(POLYMARKET_VENUE);

  return {
    market_id: makeMarketId(POLYMARKET_VENUE, market.id),
    event_id: context.eventId,
    venue: POLYMARKET_VENUE,
    venue_market_id: market.id,
    outcome: canonicalOutcomeId(label, 'OCCURS'),
    outcome_label: label,
    complement_label: labels.no,
    // A head-to-head contest is a moneyline whatever else it is called; the
    // tier says which contest, the type says which question about it.
    market_type: context.tier === 'GAME' ? 'MONEYLINE' : 'BINARY',
    tier: context.tier,
    line: null,
    comparison_operator: 'NONE',
    threshold: null,
    settlement: toSettlement(market),
    // Polymarket settles in USDC on Polygon and is not a CFTC-designated
    // venue; recording that plainly is what lets a jurisdiction filter work.
    jurisdiction: 'NON-US',
    currency: 'USDC',
    match_confidence: 0,
    title: market.question ?? event.title,
    status: isTradeable(market) ? 'OPEN' : 'CLOSED',
    close_time: market.endDate ?? event.endDate ?? null,
    payout_per_contract: 1000,
    provenance: {
      ...provenance,
      // Depth is genuinely observed here — a real ladder, not an assumed
      // stake limit — which is what lets these pairings reach CERTIFIED.
      depth_observed: true,
      settlement_rules_note:
        (market.resolutionSource ?? '').trim() !== ''
          ? `Resolution source published by the venue: ${market.resolutionSource}`
          : 'Venue publishes rules prose but names no resolution source',
    },
  };
}

export function toQuote(
  market: PolymarketMarket,
  normalized: Market,
  book: OrderBook,
  now: string,
): Quote {
  const yesAsk = book.yes_asks[0]?.price ?? null;
  const yesBid = book.yes_bids[0]?.price ?? null;
  const noAsk = book.no_asks[0]?.price ?? null;
  const noBid = book.no_bids[0]?.price ?? null;

  const mid =
    yesAsk !== null && yesBid !== null
      ? priceToProbability((yesAsk + yesBid) / 2)
      : yesAsk !== null
        ? priceToProbability(yesAsk)
        : null;

  return {
    quote_id: makeQuoteId(normalized.market_id, now),
    market_id: normalized.market_id,
    bid: yesBid,
    ask: yesAsk,
    no_bid: noBid,
    no_ask: noAsk,
    implied_probability: mid,
    liquidity: book.yes_asks.reduce((sum, l) => sum + l.size, 0),
    book,
    timestamp: now,
  };
}

export function toEvent(event: PolymarketEvent, markets: Market[], droppedCount = 0): Event {
  const { exhaustive, basis } = detectExhaustive(
    event,
    markets.map((m) => m.outcome_label),
    droppedCount,
  );
  return {
    event_id: canonicalEventId([event.slug || event.id]),
    category: categoryOf(event),
    participants: [],
    start_time: event.startDate ?? null,
    end_time: event.endDate ?? null,
    // Only a neg-risk group is a stated outcome set. Anything else is a
    // collection of independent questions that happen to share a page.
    canonical_outcome_set: event.negRisk ? markets.map((m) => m.outcome) : null,
    exhaustive,
    exhaustive_basis: basis,
  };
}
