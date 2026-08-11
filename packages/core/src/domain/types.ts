import type { DeciCents, Money } from './money.js';

/* ------------------------------------------------------------------ *
 * Event
 * ------------------------------------------------------------------ */

export type EventCategory =
  | 'POLITICS'
  | 'ECONOMICS'
  | 'SPORTS'
  | 'CLIMATE'
  | 'CULTURE'
  | 'CRYPTO'
  | 'COMPANIES'
  | 'WORLD'
  | 'OTHER';

/**
 * The venue-independent thing being bet on. Two markets are only ever
 * comparable if the matcher has resolved them to the same `event_id`.
 */
export interface Event {
  event_id: string;
  category: EventCategory;
  participants: string[];
  start_time: string | null;
  end_time: string | null;
  /**
   * The set of outcomes known to be **mutually exclusive** — at most one may
   * resolve YES. `null` means that is not established, and no basket detector
   * may run on the event at all.
   */
  canonical_outcome_set: string[] | null;
  /**
   * Whether the outcome set is also **exhaustive** — exactly one outcome must
   * resolve YES.
   *
   * This distinction decides real money. Mutual exclusivity alone makes a NO
   * basket safe (at most one YES means at least N-1 NO legs pay), but a YES
   * basket can lose every leg unless some outcome is guaranteed to happen.
   * Venues rarely publish this, so it defaults to false and an adapter must
   * present positive evidence — typically a catch-all "any other" outcome.
   */
  exhaustive: boolean;
  /** How exhaustiveness was established, shown to the user when it matters. */
  exhaustive_basis: string;
}

/* ------------------------------------------------------------------ *
 * Market
 * ------------------------------------------------------------------ */

/**
 * Sports market hierarchy. Markets in different tiers are NEVER comparable,
 * even when tightly correlated: "Team -3.5" is not "Team to win".
 */
export type MarketTier = 'GAME' | 'TEAM_PROP' | 'PLAYER_PROP' | 'FUTURES' | 'NON_SPORT';

export type MarketType =
  // Non-sport prediction markets
  | 'BINARY'
  | 'SCALAR_THRESHOLD'
  // Game markets
  | 'MONEYLINE'
  | 'SPREAD'
  | 'TOTAL'
  // Team props
  | 'TEAM_TOTAL'
  | 'FIRST_HALF'
  | 'FIRST_QUARTER'
  // Player props
  | 'PLAYER_PASSING'
  | 'PLAYER_RUSHING'
  | 'PLAYER_RECEIVING'
  | 'PLAYER_POINTS'
  | 'PLAYER_REBOUNDS'
  | 'PLAYER_OTHER'
  // Futures
  | 'FUTURES_CHAMPIONSHIP'
  | 'FUTURES_CONFERENCE'
  | 'FUTURES_DIVISION'
  | 'FUTURES_AWARD';

export type ComparisonOperator = 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'BETWEEN' | 'NONE';

/** How a market resolves. Differences here are the whole point of the diff view. */
export interface SettlementSpec {
  /** e.g. "Associated Press", "certified state election results". */
  settlement_source: string;
  settlement_rules_text: string;
  void_rules: string;
  /** Whether overtime counts toward the result. Sports-critical; often differs. */
  overtime_rules: string;
}

export interface Market {
  market_id: string;
  event_id: string;
  venue: string;
  venue_market_id: string;
  /** Canonical outcome this market pays out on, e.g. `CANDIDATE_A_WINS`. */
  outcome: string;
  /** Human label for the outcome, as the venue words it. */
  outcome_label: string;
  market_type: MarketType;
  tier: MarketTier;
  line: number | null;
  comparison_operator: ComparisonOperator;
  threshold: number | null;
  settlement: SettlementSpec;
  jurisdiction: string;
  currency: string;
  /** 0..1. Set by the matching engine, never by an adapter. */
  match_confidence: number;
  title: string;
  status: 'OPEN' | 'CLOSED' | 'SETTLED' | 'UNKNOWN';
  close_time: string | null;
  /**
   * Payout per winning contract. Event contracts pay a fixed $1; a
   * sportsbook leg pays stake + profit and is modelled in `hedge.ts`.
   */
  payout_per_contract: DeciCents;
}

/* ------------------------------------------------------------------ *
 * Quote / order book
 * ------------------------------------------------------------------ */

/** One resting price level. `size` is in whole contracts (fractional allowed). */
export interface BookLevel {
  price: DeciCents;
  size: number;
}

/**
 * Both sides of a binary market's book, already normalized to *executable*
 * ladders: `yes_asks` is what it costs to buy YES, ascending.
 *
 * Venues that publish only resting bids (Kalshi) have their ask ladders
 * reconstructed by the adapter via `reconstructAsks`, not by the engine.
 */
export interface OrderBook {
  yes_bids: BookLevel[];
  yes_asks: BookLevel[];
  no_bids: BookLevel[];
  no_asks: BookLevel[];
}

export interface Quote {
  quote_id: string;
  market_id: string;
  /** Best executable prices. Null when that side of the book is empty. */
  bid: DeciCents | null;
  ask: DeciCents | null;
  no_bid: DeciCents | null;
  no_ask: DeciCents | null;
  /** Mid-derived implied probability of the YES outcome, 0..1. */
  implied_probability: number | null;
  /** Contracts available at the best ask. */
  liquidity: number;
  book: OrderBook;
  timestamp: string;
}

/* ------------------------------------------------------------------ *
 * Opportunity
 * ------------------------------------------------------------------ */

export type OpportunityType =
  /** All mutually exclusive outcomes purchasable for less than guaranteed payout. */
  | 'GUARANTEED_ARB'
  /** Equivalent opposite positions across two venues produce guaranteed positive payoff. */
  | 'CROSS_VENUE_ARB'
  /** A spread exists but fees/slippage eliminate the guaranteed profit. */
  | 'NEAR_ARB'
  /** Markets imply meaningfully different probabilities, with no guaranteed hedge. */
  | 'RELATIVE_VALUE';

export type LegSide = 'BUY_YES' | 'BUY_NO';

export interface Leg {
  market_id: string;
  venue: string;
  side: LegSide;
  /** Best displayed price for this leg at detection time. */
  price: DeciCents;
  /** Size the detector sized this leg at, in contracts. */
  contracts: number;
  /** Volume-weighted average price after walking the book for `contracts`. */
  vwap: DeciCents;
  /** `vwap - price`, per contract. Zero when the top level absorbs the size. */
  slippage_per_contract: DeciCents;
  /** Contracts available across the whole visible ladder. */
  depth_available: number;
  outcome_label: string;
}

/** One line of the cost-adjustment stack, in display order. */
export interface CostStackEntry {
  label: string;
  /** Signed deci-cents per $1 of payout. Negative reduces edge. */
  amount: DeciCents;
  detail: string;
}

export interface Opportunity {
  opportunity_id: string;
  type: OpportunityType;
  event_id: string;
  event_title: string;
  category: EventCategory;
  markets: string[];
  legs: Leg[];
  /** Per unit of guaranteed payout, in deci-cents. */
  gross_edge: DeciCents;
  fees: DeciCents;
  slippage: DeciCents;
  settlement_mismatch_reserve: DeciCents;
  net_edge: DeciCents;
  /** Return on capital deployed, as a fraction of total cost. */
  net_roi: number;
  gross_roi: number;
  /** Max units executable given visible depth. */
  capacity: number;
  /** Capital required to take `capacity` units, in deci-cents. */
  capacity_capital: Money;
  /** Cost of one unit of the position, in deci-cents. */
  unit_cost: Money;
  match_confidence: number;
  cost_stack: CostStackEntry[];
  /** Non-fatal caveats: stale quote, thin book, settlement wording gap, ... */
  warnings: string[];
  /** Populated for multi-venue opportunities only. */
  settlement_diff: SettlementDiff | null;
  venues: string[];
  detected_at: string;
  /** Oldest quote timestamp feeding this opportunity. */
  quote_age_ms: number;
  time_to_settlement_ms: number | null;
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

export type SettlementFieldKey =
  | 'settlement_source'
  | 'settlement_rules_text'
  | 'void_rules'
  | 'overtime_rules';

export type DiffSeverity = 'IDENTICAL' | 'COSMETIC' | 'MATERIAL' | 'DISQUALIFYING';

export interface SettlementFieldDiff {
  field: SettlementFieldKey;
  label: string;
  severity: DiffSeverity;
  left: string;
  right: string;
  /** Readable, specific description of what actually differs. */
  explanation: string;
  /** Token-level diff so the UI can render the wording gap, not just a score. */
  left_only_terms: string[];
  right_only_terms: string[];
}

export interface SettlementDiff {
  fields: SettlementFieldDiff[];
  worst_severity: DiffSeverity;
  /** Confidence penalty, 0..1, applied to the match. */
  confidence_penalty: number;
  summary: string;
}

export type MatchTier =
  | 'MECHANICALLY_IDENTICAL' // 1.00
  | 'ALMOST_CERTAIN' // 0.95 - 0.99
  | 'REVIEW_REQUIRED' // 0.80 - 0.94
  | 'REJECTED'; // < 0.80

export type MatchMethod = 'EXACT' | 'FUZZY' | 'SEMANTIC_PROPOSED';

export interface MarketMatch {
  match_id: string;
  left_market_id: string;
  right_market_id: string;
  event_id: string;
  confidence: number;
  tier: MatchTier;
  method: MatchMethod;
  settlement_diff: SettlementDiff;
  /** Every deterministic check that ran, and whether it passed. */
  checks: MatchCheck[];
  /** True only if the match is allowed to be shown as arbitrage. */
  eligible_for_arbitrage: boolean;
}

export interface MatchCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** A failed blocking check rejects the match outright, whatever the score. */
  blocking: boolean;
}

/**
 * A *proposal* that some non-deterministic source (fuzzy scoring, or an LLM)
 * thinks two markets are the same. It carries no authority: the matching
 * engine re-derives confidence from deterministic checks before anything is
 * shown to a user.
 */
export interface MatchProposal {
  left_market_id: string;
  right_market_id: string;
  source: 'HEURISTIC' | 'LLM';
  /** The proposer's own confidence. Recorded for audit; never displayed as the match confidence. */
  proposed_confidence: number;
  rationale: string;
}

/* ------------------------------------------------------------------ *
 * Paper trading
 * ------------------------------------------------------------------ */

export interface SimulatedFill {
  market_id: string;
  venue: string;
  side: LegSide;
  requested_contracts: number;
  filled_contracts: number;
  /**
   * Contracts retained after the whole position was scaled down to its
   * weakest leg. A hedge only holds if every leg is sized proportionally, so
   * this — not `filled_contracts` — is what settles.
   */
  held_contracts: number;
  /** Price the opportunity card advertised. */
  displayed_price: DeciCents;
  /** VWAP actually achieved walking the book at execution time. */
  fill_vwap: DeciCents;
  fees: Money;
  cost: Money;
  /** Why the fill fell short of what was displayed. */
  shortfall_reason: ShortfallReason | null;
  shortfall_detail: string;
}

export type ShortfallReason =
  | 'PRICE_MOVED'
  | 'INSUFFICIENT_SIZE_AT_QUOTE'
  | 'LEVEL_DISAPPEARED'
  | 'MARKET_CLOSED';

export type TradeResolution = 'OPEN' | 'WON' | 'LOST' | 'PARTIAL' | 'VOID' | 'ABANDONED';

export interface PaperTrade {
  trade_id: string;
  opportunity_id: string;
  opportunity_type: OpportunityType;
  event_id: string;
  event_title: string;
  /** Capital the user allocated to this trade, in deci-cents. */
  bankroll: Money;
  simulated_fills: SimulatedFill[];
  quote_snapshot_at_detection: QuoteSnapshot;
  quote_snapshot_at_execution: QuoteSnapshot;
  /** Edge the card showed, per unit of payout. */
  displayed_edge: DeciCents;
  /** Edge actually obtainable against the execution-time book. */
  actually_fillable_edge: DeciCents;
  /** `displayed_edge - actually_fillable_edge`, the number this app exists to show. */
  edge_decay: DeciCents;
  decay_explanation: string;
  /** Whether every leg filled in full. A partial fill breaks the hedge. */
  fully_hedged: boolean;
  units_executed: number;
  capital_deployed: Money;
  guaranteed_payout: Money;
  resolution: TradeResolution;
  realized_pl: Money | null;
  created_at: string;
  executed_at: string;
  resolved_at: string | null;
}

export interface QuoteSnapshot {
  taken_at: string;
  quotes: Quote[];
}

/* ------------------------------------------------------------------ *
 * Cart
 * ------------------------------------------------------------------ */

export interface CartSummary {
  entries: number;
  capital_required: Money;
  modeled_profit: Money;
  /** modeled_profit / capital_required. */
  return_on_deployed_capital: number;
  worst_case_pl: Money;
  guaranteed_entries: number;
  speculative_entries: number;
  lowest_match_confidence: number;
  venues: string[];
  warnings: string[];
}
