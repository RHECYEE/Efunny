import {
  EMPTY_BOOK,
  bestPrice,
  bookFromComplementaryBids,
  canonicalEventId,
  canonicalOutcomeId,
  extractYears,
  marketId as makeMarketId,
  parseDecimalToDeciCents,
  priceToProbability,
  quoteId as makeQuoteId,
  totalDepth,
  type BookLevel,
  type ComparisonOperator,
  type Event,
  type EventCategory,
  type Market,
  type MarketTier,
  type MarketType,
  type OrderBook,
  type Quote,
  type SettlementSpec,
} from '@arbterminal/core';
import type { KalshiEvent, KalshiMarket, KalshiOrderBookSide } from './client.js';

export const KALSHI_VENUE = 'kalshi';

/* ------------------------------------------------------------------ *
 * Category
 * ------------------------------------------------------------------ */

const CATEGORY_MAP: Array<[RegExp, EventCategory]> = [
  [/politic|election|congress|senate|president/i, 'POLITICS'],
  [/econom|inflation|fed|cpi|gdp|jobs|rate/i, 'ECONOMICS'],
  [/sport|nfl|nba|mlb|nhl|soccer|tennis|golf|ufc|olympic/i, 'SPORTS'],
  [/climate|weather|temperature|hurricane/i, 'CLIMATE'],
  [/crypto|bitcoin|ethereum|btc|eth/i, 'CRYPTO'],
  [/compan|business|earnings|stock|ipo/i, 'COMPANIES'],
  [/culture|entertainment|music|film|award|tv/i, 'CULTURE'],
  [/world|geopolit|international/i, 'WORLD'],
];

export function categoryOf(raw: string | undefined): EventCategory {
  if (!raw) return 'OTHER';
  for (const [pattern, category] of CATEGORY_MAP) {
    if (pattern.test(raw)) return category;
  }
  return 'OTHER';
}

/* ------------------------------------------------------------------ *
 * Exhaustiveness
 * ------------------------------------------------------------------ */

/**
 * A catch-all outcome ("any other candidate", "none of the above") is what
 * turns a mutually exclusive set into an exhaustive one. Without it, every
 * YES leg of a basket can lose, so we require positive evidence rather than
 * assuming completeness.
 */
const CATCH_ALL_PATTERNS = [
  /\bany other\b/i,
  /\bnone of the above\b/i,
  /\bsomeone else\b/i,
  /\banother (?:candidate|person|team|option)\b/i,
  /\bno one\b/i,
  /\bother\b\s*$/i,
];

export function detectExhaustive(event: KalshiEvent): {
  exhaustive: boolean;
  basis: string;
} {
  if (!event.mutually_exclusive) {
    return { exhaustive: false, basis: 'venue does not flag these outcomes as mutually exclusive' };
  }
  const markets = event.markets ?? [];

  const catchAll = markets.find((m) =>
    CATCH_ALL_PATTERNS.some((p) => p.test(m.yes_sub_title ?? m.subtitle ?? m.title ?? '')),
  );
  if (catchAll) {
    return {
      exhaustive: true,
      basis: `catch-all outcome "${catchAll.yes_sub_title ?? catchAll.title}" covers every ` +
        `remaining case, so exactly one outcome must resolve YES`,
    };
  }

  // A two-outcome mutually exclusive event whose outcomes are stated as
  // negations of each other is exhaustive by construction.
  if (markets.length === 2) {
    const labels = markets.map((m) => (m.yes_sub_title ?? m.title ?? '').toLowerCase());
    if (labels.some((l) => /\bno\b|\bnot\b|\bunder\b|\bbelow\b/.test(l))) {
      return {
        exhaustive: true,
        basis: 'two mutually exclusive outcomes stated as complements of each other',
      };
    }
  }

  return {
    exhaustive: false,
    basis:
      'outcomes are mutually exclusive but no catch-all outcome is listed, so none of them ' +
      'resolving YES is possible',
  };
}

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

const OVERTIME_SENTENCE = /[^.]*\b(overtime|extra time|extra innings|regulation|shootout)\b[^.]*\./gi;
const VOID_SENTENCE =
  /[^.]*\b(void|cancel\w*|postpon\w*|reschedul\w*|suspend\w*|no action|refund\w*)\b[^.]*\./gi;

function sentencesMatching(text: string, pattern: RegExp): string {
  const matches = text.match(pattern);
  return matches ? matches.map((s) => s.trim()).join(' ') : '';
}

export function settlementSpecOf(event: KalshiEvent, market: KalshiMarket): SettlementSpec {
  const sources = (event.settlement_sources ?? [])
    .map((s) => s.name?.trim())
    .filter((name): name is string => Boolean(name && name.length > 0));

  const rules = [market.rules_primary, market.rules_secondary]
    .filter((r): r is string => Boolean(r && r.trim().length > 0))
    .join(' ');

  const voidRules = [
    sentencesMatching(rules, VOID_SENTENCE),
    market.early_close_condition ?? '',
  ]
    .filter((s) => s.length > 0)
    .join(' ');

  return {
    settlement_source: sources.length > 0 ? sources.join('; ') : '',
    settlement_rules_text: market.rules_primary?.trim() ?? '',
    void_rules: voidRules.trim(),
    overtime_rules: sentencesMatching(rules, OVERTIME_SENTENCE),
  };
}

/* ------------------------------------------------------------------ *
 * Market type / tier
 * ------------------------------------------------------------------ */

const OPERATOR_MAP: Record<string, ComparisonOperator> = {
  greater: 'GT',
  greater_or_equal: 'GTE',
  less: 'LT',
  less_or_equal: 'LTE',
  between: 'BETWEEN',
};

export function strikeOf(market: KalshiMarket): {
  operator: ComparisonOperator;
  threshold: number | null;
  line: number | null;
} {
  const operator = OPERATOR_MAP[market.strike_type ?? ''] ?? 'NONE';
  const floor =
    market.floor_strike ??
    (market.floor_strike_dollars ? Number(market.floor_strike_dollars) : undefined);
  const cap =
    market.cap_strike ?? (market.cap_strike_dollars ? Number(market.cap_strike_dollars) : undefined);

  const threshold =
    operator === 'LT' || operator === 'LTE'
      ? (cap ?? floor ?? null)
      : (floor ?? cap ?? null);

  return {
    operator,
    threshold: Number.isFinite(threshold as number) ? (threshold as number) : null,
    line: null,
  };
}

/**
 * Sports classification is deliberately conservative. Stage 1 and 2 only
 * treat two-outcome head-to-head events as moneyline; everything else in the
 * sports category is a future, so nothing can be accidentally compared across
 * tiers later.
 */
export function classifyMarket(
  event: KalshiEvent,
  market: KalshiMarket,
  category: EventCategory,
): { tier: MarketTier; market_type: MarketType } {
  const strike = strikeOf(market);

  if (category !== 'SPORTS') {
    return {
      tier: 'NON_SPORT',
      market_type: strike.operator === 'NONE' ? 'BINARY' : 'SCALAR_THRESHOLD',
    };
  }

  const outcomes = event.markets?.length ?? 0;
  if (event.mutually_exclusive && outcomes === 2 && strike.operator === 'NONE') {
    return { tier: 'GAME', market_type: 'MONEYLINE' };
  }
  return { tier: 'FUTURES', market_type: 'FUTURES_CHAMPIONSHIP' };
}

function statusOf(market: KalshiMarket): Market['status'] {
  switch ((market.status ?? '').toLowerCase()) {
    case 'active':
    case 'open':
      return 'OPEN';
    case 'closed':
    case 'inactive':
    case 'paused':
      return 'CLOSED';
    case 'settled':
    case 'finalized':
    case 'determined':
      return 'SETTLED';
    default:
      return 'UNKNOWN';
  }
}

/* ------------------------------------------------------------------ *
 * Event / Market / Quote
 * ------------------------------------------------------------------ */

/**
 * Venue-neutral event identity. Derived from the event's own wording so that
 * a second venue describing the same event can land on the same id, with the
 * close date appended when the title carries no year to disambiguate
 * recurring events.
 */
export function eventIdOf(event: KalshiEvent): string {
  const title = [event.title, event.sub_title].filter(Boolean).join(' ');
  const years = extractYears(title);
  if (years.length > 0) return canonicalEventId([event.title, years.join('_')]);

  const firstClose = event.markets?.[0]?.close_time ?? '';
  const day = firstClose.slice(0, 10);
  return canonicalEventId([event.title, event.sub_title, day]);
}

export function toEvent(raw: KalshiEvent): Event {
  const category = categoryOf(raw.category ?? raw.series_ticker);
  const markets = raw.markets ?? [];
  const { exhaustive, basis } = detectExhaustive(raw);

  return {
    event_id: eventIdOf(raw),
    category,
    participants: markets
      .map((m) => (m.yes_sub_title ?? '').trim())
      .filter((p) => p.length > 0),
    start_time: markets[0]?.open_time ?? null,
    end_time: markets[0]?.close_time ?? null,
    canonical_outcome_set: raw.mutually_exclusive
      ? markets.map((m) => canonicalOutcomeId(m.yes_sub_title ?? m.ticker))
      : null,
    exhaustive,
    exhaustive_basis: basis,
  };
}

export function toMarket(rawEvent: KalshiEvent, raw: KalshiMarket): Market {
  const category = categoryOf(rawEvent.category ?? rawEvent.series_ticker);
  const { tier, market_type } = classifyMarket(rawEvent, raw, category);
  const strike = strikeOf(raw);
  const outcomeLabel = (raw.yes_sub_title ?? raw.subtitle ?? raw.title ?? raw.ticker).trim();

  return {
    market_id: makeMarketId(KALSHI_VENUE, raw.ticker),
    event_id: eventIdOf(rawEvent),
    venue: KALSHI_VENUE,
    venue_market_id: raw.ticker,
    outcome: canonicalOutcomeId(outcomeLabel),
    outcome_label: outcomeLabel,
    market_type,
    tier,
    line: strike.line,
    comparison_operator: strike.operator,
    threshold: strike.threshold,
    settlement: settlementSpecOf(rawEvent, raw),
    jurisdiction: 'US-CFTC',
    currency: 'USD',
    // Matching is the matching engine's job; an adapter never asserts one.
    match_confidence: 0,
    title: rawEvent.title || raw.title,
    status: statusOf(raw),
    close_time: raw.close_time ?? raw.expiration_time ?? null,
    // Kalshi event contracts settle at exactly $1.00.
    payout_per_contract: 1000,
  };
}

function toLevels(pairs: Array<[string, string]> | undefined): BookLevel[] {
  if (!pairs) return [];
  return pairs
    .map(([price, size]) => ({
      price: parseDecimalToDeciCents(price),
      size: Number(size),
    }))
    .filter((level) => Number.isFinite(level.size) && level.size > 0);
}

/**
 * Kalshi publishes *resting bids* on each side. The executable ask ladders
 * are the exact complements of the opposite side's bids, which is why the
 * reconstruction lives here in the adapter rather than in the engine.
 */
export function toOrderBook(side: KalshiOrderBookSide | undefined): OrderBook {
  if (!side) return EMPTY_BOOK;
  return bookFromComplementaryBids(toLevels(side.yes_dollars), toLevels(side.no_dollars));
}

/**
 * Build a book from the top-of-book fields on the market payload, for when a
 * depth fetch was skipped. Depth is limited to the quoted best size, so
 * slippage modelling stays honest rather than assuming unseen liquidity.
 */
export function topOfBookOnly(raw: KalshiMarket): OrderBook {
  const yesBid = parseDecimalToDeciCents(raw.yes_bid_dollars ?? '0');
  const noBid = parseDecimalToDeciCents(raw.no_bid_dollars ?? '0');
  const yesBidSize = Number(raw.yes_bid_size_fp ?? '0');
  const yesAskSize = Number(raw.yes_ask_size_fp ?? '0');

  // A YES ask is a NO bid; its size is the quoted YES ask size.
  const yesBids: BookLevel[] = yesBid > 0 && yesBidSize > 0 ? [{ price: yesBid, size: yesBidSize }] : [];
  const noBids: BookLevel[] = noBid > 0 && yesAskSize > 0 ? [{ price: noBid, size: yesAskSize }] : [];
  return bookFromComplementaryBids(yesBids, noBids);
}

export function toQuote(marketId: string, book: OrderBook, timestamp: string): Quote {
  const yesBid = bestPrice(book.yes_bids);
  const yesAsk = bestPrice(book.yes_asks);
  const noBid = bestPrice(book.no_bids);
  const noAsk = bestPrice(book.no_asks);

  // Mid of the two-sided YES market. With one side missing there is no mid,
  // and reporting the single side as a probability would overstate certainty.
  const impliedProbability =
    yesBid !== null && yesAsk !== null ? priceToProbability((yesBid + yesAsk) / 2) : null;

  return {
    quote_id: makeQuoteId(marketId, timestamp),
    market_id: marketId,
    bid: yesBid,
    ask: yesAsk,
    no_bid: noBid,
    no_ask: noAsk,
    implied_probability: impliedProbability,
    liquidity: totalDepth(book.yes_asks),
    book,
    timestamp,
  };
}
