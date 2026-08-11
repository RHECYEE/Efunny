import {
  ONE_DOLLAR,
  americanToContractPrice,
  americanToDecimal,
  canonicalEventId,
  canonicalOutcomeId,
  extractYears,
  marketId as makeMarketId,
  priceToProbability,
  quoteId as makeQuoteId,
  type ComparisonOperator,
  type Event,
  type EventCategory,
  type Market,
  type MarketTier,
  type MarketType,
  type OrderBook,
  type Provenance,
  type Quote,
} from '@arbterminal/core';
import type { ValidRow } from './repair.js';
import {
  ceilingForScope,
  describeScope,
  resolveRules,
  type HouseRules,
  type ResolvedRules,
} from './rules.js';

/**
 * Turning a captured sportsbook row into the shared schema.
 *
 * A sportsbook quotes odds, not contract prices, and publishes no order book.
 * Both gaps are handled here in the adapter rather than being pushed into the
 * engine: odds become a cost per $1 of payout, and the absence of depth is
 * recorded as provenance so nothing downstream mistakes an assumed size for an
 * observed one.
 */

const CATEGORY_PATTERNS: Array<[RegExp, EventCategory]> = [
  [/bitcoin|ethereum|crypto|btc|eth|solana|xrp|doge/i, 'CRYPTO'],
  [/nfl|nba|mlb|nhl|soccer|tennis|golf|ufc|super bowl|playoff/i, 'SPORTS'],
  [/election|president|senate|congress|prime minister/i, 'POLITICS'],
  [/inflation|gdp|fed|rate|cpi|unemployment/i, 'ECONOMICS'],
];

export function categoryOf(text: string): EventCategory {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return 'OTHER';
}

/** `65,000` / `$100k` / `1.5m` -> a number. */
function parseAmount(raw: string): number | null {
  const match = raw.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  const multiplier = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : suffix === 'b' ? 1e9 : 1;
  return value * multiplier;
}

export interface Interpretation {
  operator: ComparisonOperator;
  /** Lower bound for a range, or the strike for a threshold. */
  threshold: number | null;
  /** Upper bound for a range. Null for a one-sided threshold. */
  line: number | null;
  market_type: MarketType;
  tier: MarketTier;
  /** Deadline stated by the outcome, if it is a date rather than a price. */
  deadline: string | null;
}

const RANGE = /([\d,]+(?:\.\d+)?)\s*(?:to|-|–)\s*([\d,]+(?:\.\d+)?)/;
const CROSSES = /\b(?:cross(?:es)?|reach(?:es)?|hits?|above|over|exceeds?)\b[^\d$]*(\$?[\d,]+(?:\.\d+)?\s*[kmb]?)/i;
const BELOW = /\b(?:below|under|beneath)\b[^\d$]*(\$?[\d,]+(?:\.\d+)?\s*[kmb]?)/i;

/**
 * Read the market and outcome text into a comparison. Anything not
 * recognised stays a plain binary with no threshold, which is the safe
 * default: a market with no parsed threshold can only match another market
 * with no threshold, so an unparsed line can never be silently equated with
 * a parsed one.
 */
export function interpret(row: ValidRow): Interpretation {
  const combined = `${row.market} ${row.outcome}`;
  const tier: MarketTier = categoryOf(combined) === 'SPORTS' ? 'FUTURES' : 'NON_SPORT';

  // "55,000 to 59,999.99"
  const range = row.outcome.match(RANGE);
  if (range) {
    return {
      operator: 'BETWEEN',
      threshold: Number(range[1]!.replace(/,/g, '')),
      line: Number(range[2]!.replace(/,/g, '')),
      market_type: 'SCALAR_THRESHOLD',
      tier,
      deadline: null,
    };
  }

  const deadline = parseDeadline(row.outcome);

  // "When will Bitcoin cross $100k again?" -> above 100000
  const crosses = row.market.match(CROSSES) ?? row.outcome.match(CROSSES);
  if (crosses) {
    const amount = parseAmount(crosses[1]!);
    if (amount !== null) {
      return {
        operator: 'GT',
        threshold: amount,
        line: null,
        market_type: 'SCALAR_THRESHOLD',
        tier,
        deadline,
      };
    }
  }

  const below = row.market.match(BELOW) ?? row.outcome.match(BELOW);
  if (below) {
    const amount = parseAmount(below[1]!);
    if (amount !== null) {
      return {
        operator: 'LT',
        threshold: amount,
        line: null,
        market_type: 'SCALAR_THRESHOLD',
        tier,
        deadline,
      };
    }
  }

  return { operator: 'NONE', threshold: null, line: null, market_type: 'BINARY', tier, deadline };
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** "Before January 2027", "December 31, 2026" -> an ISO instant. */
export function parseDeadline(text: string): string | null {
  const explicit = text.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (explicit) {
    const month = MONTHS[explicit[1]!.toLowerCase()];
    if (month !== undefined) {
      return new Date(Date.UTC(Number(explicit[3]), month, Number(explicit[2]), 23, 59, 59)).toISOString();
    }
  }

  const before = text.match(/before\s+([a-z]+)\s+(\d{4})/i);
  if (before) {
    const month = MONTHS[before[1]!.toLowerCase()];
    // "Before January 2027" ends the instant that month begins.
    if (month !== undefined) return new Date(Date.UTC(Number(before[2]), month, 1)).toISOString();
  }

  const monthYear = text.match(/^([a-z]+)\s+(\d{4})$/i);
  if (monthYear) {
    const month = MONTHS[monthYear[1]!.toLowerCase()];
    if (month !== undefined) return new Date(Date.UTC(Number(monthYear[2]), month + 1, 1)).toISOString();
  }

  return null;
}

export interface NormalizeContext {
  venue: string;
  display_name: string;
  /**
   * Stake the user believes this book would accept on one leg, in deci-cents.
   * It is an assumption, recorded as such, not observed liquidity.
   */
  assumed_stake_limit: number;
  jurisdiction: string;
  currency: string;
  /** House rules for the venue, loaded once from `rules.json`. */
  house_rules?: HouseRules | null;
}

function provenanceFor(
  row: ValidRow,
  context: NormalizeContext,
  rules: ResolvedRules,
): Provenance {
  // A repaired record was not matched against the venue's own text, so it can
  // never present as mechanically identical. Rule scope caps it further: a
  // venue-wide rule applied to one contract is an inference about that
  // contract, not a statement of it. The tighter ceiling wins.
  const repairCeiling = row.repairs.length > 0 ? 0.94 : 0.97;

  return {
    source: 'MANUAL_IMPORT',
    origin: `${context.display_name} captured manually${row.source ? ` from ${row.source}` : ''}`,
    repaired: row.repairs.length > 0,
    repairs: row.repairs,
    confidence_ceiling: Math.min(repairCeiling, ceilingForScope(rules.scope)),
    depth_observed: false,
    captured_at: row.captured_at || null,
    settlement_rules_scope: rules.scope,
    settlement_rules_note: describeScope(rules.scope, rules.source_document),
  };
}

/**
 * Settlement rules as captured.
 *
 * A capture that carries no rules text leaves these empty, and that is the
 * right answer: the differ treats silence as a *material* gap rather than as
 * agreement, which correctly stops an uncorroborated pairing from clearing
 * the arbitrage floor.
 *
 * What must not happen is filling the gap with something that is not the
 * venue's rules. Writing the board section here ("Listed under Bitcoin")
 * would look like documentation while diffing badly against the other venue's
 * real wording — worse than admitting the text is missing. Include
 * `settlement_source` and `settlement_rules` columns in the capture and they
 * are used; otherwise the gap stays visible.
 */


export function toMarket(row: ValidRow, context: NormalizeContext): Market {
  const reading = interpret(row);
  const rules = resolveRules(context.house_rules ?? null, row);
  const venueMarketId = `${row.market}|${row.outcome}`.replace(/\s+/g, '_').slice(0, 120);
  const title = `${row.market} — ${row.outcome}`;
  const years = extractYears(`${row.market} ${row.outcome}`);

  return {
    market_id: makeMarketId(context.venue, venueMarketId),
    event_id: canonicalEventId([row.market, years.join('_')]),
    venue: context.venue,
    venue_market_id: venueMarketId,
    outcome: canonicalOutcomeId(row.outcome, 'OCCURS'),
    outcome_label: row.outcome,
    market_type: reading.market_type,
    tier: reading.tier,
    line: reading.line,
    comparison_operator: reading.operator,
    threshold: reading.threshold,
    settlement: rules.settlement,
    jurisdiction: context.jurisdiction,
    currency: context.currency,
    match_confidence: 0,
    title,
    status: 'OPEN',
    close_time: reading.deadline,
    payout_per_contract: ONE_DOLLAR,
    provenance: provenanceFor(row, context, rules),
  };
}

export function toEvent(row: ValidRow, market: Market): Event {
  return {
    event_id: market.event_id,
    category: categoryOf(`${row.market} ${row.outcome}`),
    participants: [],
    start_time: null,
    end_time: market.close_time,
    // A captured slice of a sportsbook's board is not a proven partition:
    // outcomes may be missing and nothing states they are exclusive.
    canonical_outcome_set: null,
    exhaustive: false,
    exhaustive_basis: 'manually captured rows are not a proven outcome set',
  };
}

/**
 * A single-level book at the quoted price, sized to the assumed stake limit.
 *
 * This is the honest shape of a sportsbook quote: one price, and a size the
 * user supplied rather than the venue. `depth_observed: false` on the market
 * is what stops the engine presenting the resulting capacity as real.
 */
export function toBook(row: ValidRow, context: NormalizeContext): OrderBook {
  const yesAsk = americanToContractPrice(row.yes_odds);
  const noAsk = row.no_odds !== null ? americanToContractPrice(row.no_odds) : null;

  // Contracts affordable at this price with the assumed stake.
  const size = yesAsk > 0 ? context.assumed_stake_limit / yesAsk : 0;
  const noSize = noAsk !== null && noAsk > 0 ? context.assumed_stake_limit / noAsk : 0;

  return {
    yes_asks: yesAsk > 0 && yesAsk < ONE_DOLLAR ? [{ price: yesAsk, size }] : [],
    no_asks: noAsk !== null && noAsk > 0 && noAsk < ONE_DOLLAR ? [{ price: noAsk, size: noSize }] : [],
    // A sportsbook does not let you sell, so there is no bid side to quote.
    // The engine reads an empty bid ladder as "cannot exit", which is right.
    yes_bids: [],
    no_bids: [],
  };
}

export function toQuote(row: ValidRow, market: Market, context: NormalizeContext): Quote {
  const book = toBook(row, context);
  const yesAsk = book.yes_asks[0]?.price ?? null;
  const noAsk = book.no_asks[0]?.price ?? null;

  // Both sides quoted means the vig can be stripped to get a fair estimate.
  // With only one side there is no way to separate price from margin.
  const impliedProbability =
    yesAsk !== null && noAsk !== null
      ? priceToProbability(yesAsk) / (priceToProbability(yesAsk) + priceToProbability(noAsk))
      : null;

  return {
    quote_id: makeQuoteId(market.market_id, row.captured_at),
    market_id: market.market_id,
    // A sportsbook quote is one-way: you can buy, not sell.
    bid: null,
    ask: yesAsk,
    no_bid: null,
    no_ask: noAsk,
    implied_probability: impliedProbability,
    liquidity: book.yes_asks[0]?.size ?? 0,
    book,
    timestamp: row.captured_at || new Date().toISOString(),
  };
}

/** Decimal odds, for display alongside the contract price. */
export function decimalOdds(american: number): number {
  return americanToDecimal(american);
}
