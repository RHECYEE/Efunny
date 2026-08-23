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

/**
 * Where a record came from and what was done to it before it got here.
 *
 * Not every venue is an API. A manually captured price is still usable, but it
 * carries risks an API response does not — transcription error, no order book,
 * a single snapshot — and those risks have to travel with the record rather
 * than being forgotten at the ingestion boundary.
 */
export interface Provenance {
  source: 'VENUE_API' | 'MANUAL_IMPORT';
  /** Human description of where this came from, shown on the card. */
  origin: string;
  /** Whether the record was altered before ingestion (e.g. OCR repair). */
  repaired: boolean;
  /** Specific repairs applied, for display. Empty when untouched. */
  repairs: string[];
  /**
   * Hard cap on any match confidence involving this market, 0..1.
   *
   * A repaired record can never be presented as mechanically identical to
   * anything, however well it scores — the text it was matched on is not
   * exactly the text the venue published.
   */
  confidence_ceiling: number;
  /**
   * Whether the venue published real order-book depth. False means any
   * capacity figure is an assumption and slippage cannot be modelled.
   */
  depth_observed: boolean;
  /** When the underlying price was observed, if different from the quote. */
  captured_at: string | null;
  /**
   * How specifically the settlement rules attached to this market were
   * written. A venue that documents rules for a whole product rather than per
   * market yields a weaker claim about any one contract, and that shows on
   * the card rather than being flattened into the confidence number alone.
   */
  settlement_rules_scope?: 'MARKET' | 'SECTION' | 'VENUE' | 'NONE';
  /** Human note about where the settlement text came from. */
  settlement_rules_note?: string;
}

/** Provenance for a record read straight from a venue's own API. */
export function venueApiProvenance(venue: string): Provenance {
  return {
    source: 'VENUE_API',
    origin: `${venue} public API`,
    repaired: false,
    repairs: [],
    confidence_ceiling: 1,
    depth_observed: true,
    captured_at: null,
  };
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
  /**
   * What the NO side of this market is called, when it has a name of its own.
   *
   * Usually there isn't one — the complement of "Bitcoin above $100k" is just
   * "not above $100k", and saying so adds nothing. But a two-way contest
   * names both sides, and there the complement is a different person: NO on
   * "Song Yadong" is a bet on Umar Nurmagomedov. Rendering that as "Bet NO ·
   * Song Yadong" reads like a bet on the man whose name is on it, which is
   * the opposite of the position being described.
   */
  complement_label?: string | null;
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
  provenance: Provenance;
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
  /**
   * Canonical outcome this leg pays on.
   *
   * Distinct from `market_id`: a cross-venue hedge holds two *different*
   * markets that resolve on the *same* proposition. Anything reasoning about
   * how the event can turn out has to group by this, or it invents impossible
   * worlds where one venue's market wins and the other's does not.
   */
  outcome: string;
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
  /** What this leg pays on, in the venue's own words. */
  outcome_label: string;
  /**
   * True when `outcome_label` is the *other* side's name rather than the
   * market's own. A NO leg on a named two-way contest pays on the opponent,
   * so the instruction has to read "back this person", never "bet NO on"
   * them — the second says the opposite of what the position does.
   */
  label_is_complement?: boolean;
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
  /** Composed standing: certified, qualified candidate, disqualified, ... */
  assurance: AssuranceGrade;
  contract: ContractComparison | null;
  settlement: SettlementAssessment | null;
  execution_quality: ExecutionQuality;
  /**
   * Net edge assuming the two venues do settle off the same facts. Equal to
   * `net_edge` when settlement is CONFIRMED.
   */
  edge_if_settlement_equivalent: DeciCents;
  /**
   * What a settlement mismatch would cost, per unit, in the worst case.
   *
   * For a two-leg hedge this is the entire outlay: if the venues' references
   * straddle the threshold, the YES leg and the NO leg can both lose. Stated
   * as its own number rather than folded into a reserve, because pricing an
   * unquantified basis risk to the deci-cent would be false precision.
   */
  worst_case_if_settlement_differs: Money;
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
  /**
   * True when both venues documented this rule and the two statements
   * disagree, as opposed to one side simply saying nothing.
   *
   * The distinction is not cosmetic. Silence is an unknown that might resolve
   * either way; a stated conflict is a known difference, and it costs more.
   */
  conflict: boolean;
}

export interface SettlementDiff {
  fields: SettlementFieldDiff[];
  worst_severity: DiffSeverity;
  /** Confidence penalty, 0..1, applied to the match. */
  confidence_penalty: number;
  summary: string;
}

/* ------------------------------------------------------------------ *
 * Assurance: three orthogonal questions, never one score
 * ------------------------------------------------------------------ */

/**
 * Does each venue's contract state the same proposition?
 *
 * This is a *logical* question with a hard answer. "Above $100,000" and
 * "above $105,000" are different propositions at any price, and no amount of
 * corroboration elsewhere rescues the pairing.
 */
export type ContractMatchState =
  /** Same proposition, and both venues word it the same way. */
  | 'IDENTICAL'
  /** Same proposition in different words: same underlying, threshold, direction, deadline. */
  | 'EQUIVALENT'
  /** Demonstrably different propositions. Never comparable. */
  | 'MISMATCHED';

/**
 * Do the two contracts settle off the same facts?
 *
 * Distinct from contract match, and crucially *three*-valued. Collapsing
 * "unverifiable" into "conflict" rejects every pairing with a venue that does
 * not publish its settlement source — which is most sportsbooks, and would
 * quietly discard nearly everything this tool exists to find.
 */
export type SettlementAssurance =
  /** Both venues name a settlement basis and they agree. */
  | 'CONFIRMED'
  /** At least one venue does not expose its settlement basis. Unresolved basis risk, not proven incompatibility. */
  | 'UNVERIFIABLE'
  /** Both venues name a basis and they differ, or a rule directly contradicts. */
  | 'CONFLICT';

/**
 * How well the position could actually be filled, as opposed to priced.
 */
export type ExecutionQuality =
  /** Real order-book depth on every leg. */
  | 'OBSERVED'
  /** At least one venue publishes no depth; capacity is an assumption. */
  | 'ASSUMED_DEPTH'
  /** At least one quote is too old to act on. */
  | 'STALE';

/**
 * The overall standing of an opportunity, composed from the three states
 * above rather than from a single number.
 *
 * `CERTIFIED` is deliberately hard to reach: it asserts that the contracts
 * state the same proposition, settle off the same facts, and are fillable at
 * the prices shown. Anything less says so on its face instead of being
 * withheld.
 */
export type AssuranceGrade =
  | 'CERTIFIED'
  /** Prices imply an arbitrage, but settlement equivalence is not established. */
  | 'QUALIFIED_CANDIDATE'
  /** A spread exists that costs do not survive. */
  | 'NOT_PROFITABLE'
  /** A demonstrated settlement conflict; the hedge is known to be unsound. */
  | 'DISQUALIFIED'
  /** No hedge is claimed at all. */
  | 'INFORMATIONAL';

/** One dimension of the contract comparison, for the checklist display. */
export interface ContractDimension {
  name: string;
  label: string;
  agreed: boolean;
  /** Set when the dimension proves the propositions differ. */
  disqualifying: boolean;
  left: string;
  right: string;
  detail: string;
}

export interface ContractComparison {
  state: ContractMatchState;
  dimensions: ContractDimension[];
  /**
   * 0..1 over *proposition identity only*. Settlement is not folded in — that
   * is what `SettlementAssurance` is for, and mixing them is what made an
   * unknown index indistinguishable from a wrong one.
   */
  confidence: number;
}

export interface SettlementAssessment {
  assurance: SettlementAssurance;
  /** Per-venue statement of the settlement basis, or that none is published. */
  left_source: string;
  right_source: string;
  /** Which venue each source belongs to. Without these a caller has to guess,
   *  and guessing from a sorted venue list names the wrong one. */
  left_venue: string;
  right_venue: string;
  /** The venue that failed to publish a basis, when assurance is UNVERIFIABLE. */
  unverified_venue: string | null;
  diff: SettlementDiff;
  /** Plain-language reason for the assurance state. */
  reason: string;
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
  /** Proposition identity only. See `ContractComparison.confidence`. */
  confidence: number;
  tier: MatchTier;
  method: MatchMethod;
  settlement_diff: SettlementDiff;
  /** Is this the same proposition? A logical question with a hard answer. */
  contract: ContractComparison;
  /** Do the two settle off the same facts? Three-valued, never folded into the score. */
  settlement: SettlementAssessment;
  /** Every deterministic check that ran, and whether it passed. */
  checks: MatchCheck[];
  /**
   * Whether the pairing may be presented as an arbitrage *of some grade*.
   * A demonstrated settlement conflict bars it; an unexposed settlement
   * source does not — that is basis risk to disclose, not proof of
   * incompatibility.
   */
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
