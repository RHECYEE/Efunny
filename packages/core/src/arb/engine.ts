import { opportunityId } from '../domain/ids.js';
import { ONE_DOLLAR, roundHalfAway, type DeciCents } from '../domain/money.js';
import type {
  CostStackEntry,
  Event,
  Market,
  MarketMatch,
  Opportunity,
  OpportunityType,
  Quote,
  SettlementDiff,
} from '../domain/types.js';
import { CONFIDENCE, requiresManualReview } from '../match/confidence.js';
import { identicalSettlement } from '../match/settlementDiff.js';
import { consensusProbability } from '../normalize/odds.js';
import type { FeeBook } from './fees.js';
import {
  capitalRequired,
  depthLimitedUnits,
  maxProfitableUnits,
  pricePosition,
  topOfBookUnits,
  type LegSpec,
  type PositionCosts,
} from './position.js';
import { describeReserve, settlementMismatchReserve } from './reserve.js';

/**
 * The arbitrage engine.
 *
 * Pure deterministic code over normalized `Market` / `Quote` objects. It
 * contains no venue-specific branch, no network access and no LLM call —
 * a new venue reaches it only as more normalized snapshots plus a fee model.
 */

export interface MarketSnapshot {
  market: Market;
  quote: Quote;
}

export interface EventSnapshot {
  event: Event;
  markets: MarketSnapshot[];
}

export interface ArbEngineOptions {
  fees: FeeBook;
  /** Opportunities below this net edge (dc per $1 payout) are dropped. Default 0. */
  min_net_edge?: DeciCents;
  /** Quotes older than this attract a staleness warning. Default 60s. */
  stale_quote_ms?: number;
  /** Probability divergence needed to report RELATIVE_VALUE. Default 30 dc (3%). */
  relative_value_threshold?: DeciCents;
  /**
   * Widest bid-ask spread, in deci-cents, for a quote's mid to count as a
   * probability estimate. Default 100 dc (10c).
   *
   * A market quoted 1c/99c has a mid of 50c that means nothing, and summing a
   * basket of those produces an "overround" driven entirely by spread width
   * rather than by any disagreement about the outcome.
   */
  max_spread_for_divergence?: DeciCents;
  /**
   * The same limit for venues that quote both sides with a margin instead of
   * a two-sided book. Default 250 dc (25%).
   *
   * A sportsbook has no bid to subtract, so its two-way width is the
   * overround. That runs far wider than an exchange spread and is *removable*
   * — the margin sits on both sides and de-vigging recovers a usable
   * probability — so holding it to the exchange limit would discard every
   * sportsbook quote as noise.
   */
  max_overround_for_divergence?: DeciCents;
  /** Positions with less capacity than this are dropped as untradeable. Default 1 unit. */
  min_capacity_units?: number;
  now?: () => Date;
}

interface ResolvedOptions extends Required<Omit<ArbEngineOptions, 'fees' | 'now'>> {
  fees: FeeBook;
  now: () => Date;
}

function resolve(options: ArbEngineOptions): ResolvedOptions {
  return {
    fees: options.fees,
    min_net_edge: options.min_net_edge ?? 0,
    stale_quote_ms: options.stale_quote_ms ?? 60_000,
    relative_value_threshold: options.relative_value_threshold ?? 30,
    max_spread_for_divergence: options.max_spread_for_divergence ?? 100,
    max_overround_for_divergence: options.max_overround_for_divergence ?? 250,
    min_capacity_units: options.min_capacity_units ?? 1,
    now: options.now ?? (() => new Date()),
  };
}

/* ------------------------------------------------------------------ *
 * Opportunity assembly
 * ------------------------------------------------------------------ */

interface BuildInput {
  type: OpportunityType;
  event: Event;
  eventTitle: string;
  legs: LegSpec[];
  matchConfidence: number;
  settlementDiff: SettlementDiff | null;
  opts: ResolvedOptions;
  /** Overrides the guaranteed-payout framing for RELATIVE_VALUE. */
  grossEdgeOverride?: DeciCents;
  extraWarnings?: string[];
}

function buildCostStack(
  costs: PositionCosts,
  reserve: DeciCents,
  reserveNote: string,
  feeNotes: string[],
  grossEdge: DeciCents,
  slippageNote: string,
): CostStackEntry[] {
  return [
    {
      label: 'Raw edge',
      amount: grossEdge,
      detail: `$1.0000 payout less ${(costs.top_cost / 1000).toFixed(4)} top-of-book cost`,
    },
    {
      label: 'Venue fees',
      amount: -costs.fees,
      detail: feeNotes.join('; ') || 'no fee schedule declared',
    },
    {
      label: 'Modeled slippage',
      amount: -costs.slippage,
      detail: slippageNote,
    },
    {
      label: 'Settlement mismatch reserve',
      amount: -reserve,
      detail: reserveNote,
    },
  ];
}

function classify(
  requested: OpportunityType,
  venues: string[],
  grossEdge: DeciCents,
  netEdge: DeciCents,
): OpportunityType {
  if (requested === 'RELATIVE_VALUE') return 'RELATIVE_VALUE';
  if (netEdge <= 0) {
    // A spread exists but costs ate it. That is NEAR_ARB, never "arbitrage".
    return grossEdge > 0 ? 'NEAR_ARB' : 'RELATIVE_VALUE';
  }
  return venues.length > 1 ? 'CROSS_VENUE_ARB' : 'GUARANTEED_ARB';
}

function buildOpportunity(input: BuildInput): Opportunity | null {
  const { legs, opts, matchConfidence, settlementDiff } = input;
  if (legs.length === 0) return null;

  const reserve = settlementMismatchReserve(settlementDiff, matchConfidence);
  const profitableUnits = maxProfitableUnits(legs, opts.fees, reserve, opts.min_net_edge);
  // When no size clears costs we still price the position, at its
  // zero-slippage size, so the user can see how far short it falls.
  const units = profitableUnits > 0 ? profitableUnits : Math.max(topOfBookUnits(legs), 0);
  if (!Number.isFinite(units) || units <= 0) return null;

  const costs = pricePosition(legs, units, opts.fees);
  const grossEdge = input.grossEdgeOverride ?? costs.gross_edge;
  const netEdge = grossEdge - costs.fees - costs.slippage - reserve;

  const venues = [...new Set(legs.map((l) => l.market.venue))].sort();
  const type = classify(input.type, venues, grossEdge, netEdge);

  if (type !== 'RELATIVE_VALUE' && netEdge < opts.min_net_edge && type !== 'NEAR_ARB') {
    return null;
  }

  const now = opts.now();
  const quoteTimes = legs.map((l) => Date.parse(l.quote.timestamp)).filter(Number.isFinite);
  const oldestQuote = quoteTimes.length > 0 ? Math.min(...quoteTimes) : now.getTime();
  const quoteAge = Math.max(0, now.getTime() - oldestQuote);

  const closeTimes = legs
    .map((l) => (l.market.close_time ? Date.parse(l.market.close_time) : NaN))
    .filter(Number.isFinite);
  const timeToSettlement =
    closeTimes.length > 0 ? Math.min(...closeTimes) - now.getTime() : null;

  const warnings = [...(input.extraWarnings ?? [])];
  for (const venue of venues) {
    if (!opts.fees.has(venue)) {
      warnings.push(
        `No fee schedule declared for ${venue}; the executable edge shown is an upper bound.`,
      );
    }
  }
  if (quoteAge > opts.stale_quote_ms) {
    warnings.push(`Quotes are ${(quoteAge / 1000).toFixed(0)}s old and may no longer be live.`);
  }
  if (!costs.fully_fillable) {
    warnings.push('Visible depth does not cover the sized position on every leg.');
  }

  // A venue that publishes no order book gives the sizing model nothing to
  // walk. Slippage then computes as zero, which is not the same as there
  // being none, and the capacity figure is an assumption rather than an
  // observation. Both have to be said out loud.
  const assumedDepth = legs.filter((l) => !l.market.provenance.depth_observed);
  if (assumedDepth.length > 0) {
    const venuesWithout = [...new Set(assumedDepth.map((l) => l.market.venue))].sort();
    warnings.push(
      `${venuesWithout.join(', ')} publishes no order-book depth. The capacity shown is an ` +
        `assumed stake limit, not observed liquidity, and slippage on those legs is not ` +
        `modelled — the executable edge is an upper bound.`,
    );
  }

  const repairedLegs = legs.filter((l) => l.market.provenance.repaired);
  if (repairedLegs.length > 0) {
    warnings.push(
      `Repaired source data on ${repairedLegs.length} leg(s): ` +
        `${[...new Set(repairedLegs.flatMap((l) => l.market.provenance.repairs))].join('; ')}.`,
    );
  }

  const captured = legs
    .map((l) => l.market.provenance.captured_at)
    .filter((c): c is string => c !== null)
    .sort();
  if (captured.length > 0) {
    const age = now.getTime() - Date.parse(captured[0]!);
    if (Number.isFinite(age)) {
      warnings.push(
        `Manually captured prices are ${(age / 60_000).toFixed(0)} minutes old and do not ` +
          `update on their own.`,
      );
    }
  }
  if (requiresManualReview(matchConfidence)) {
    warnings.push(
      `Match confidence ${(matchConfidence * 100).toFixed(0)}% is in the manual-review band; ` +
        `verify the settlement comparison before treating this as hedged.`,
    );
  }
  if (legs.some((l) => l.market.status !== 'OPEN')) {
    warnings.push('At least one leg is not open for trading.');
  }
  if (type === 'RELATIVE_VALUE') {
    warnings.push('No guaranteed hedge exists for this position; it is a directional view.');
  }

  const feeNotes = venues.map((v) =>
    opts.fees.for(v).describe({
      venue: v,
      product: '',
      side: 'BUY_YES',
      price: 500,
      contracts: 1,
      role: 'TAKER',
    }),
  );

  const legKeys = legs.map((l) => `${l.market.market_id}:${l.side}`);

  return {
    opportunity_id: opportunityId(type, legKeys),
    type,
    event_id: input.event.event_id,
    event_title: input.eventTitle,
    category: input.event.category,
    markets: legs.map((l) => l.market.market_id),
    legs: costs.legs,
    gross_edge: roundHalfAway(grossEdge),
    fees: roundHalfAway(costs.fees),
    slippage: roundHalfAway(costs.slippage),
    settlement_mismatch_reserve: reserve,
    net_edge: roundHalfAway(netEdge),
    net_roi: costs.unit_cost > 0 ? netEdge / costs.unit_cost : 0,
    gross_roi: costs.top_cost > 0 ? grossEdge / costs.top_cost : 0,
    capacity: units,
    capacity_capital: capitalRequired(costs),
    unit_cost: roundHalfAway(costs.unit_cost),
    match_confidence: matchConfidence,
    cost_stack: buildCostStack(
      costs,
      reserve,
      describeReserve(settlementDiff, matchConfidence),
      feeNotes,
      grossEdge,
      assumedDepth.length > 0
        ? 'Not modelled: at least one venue publishes no order book to walk'
        : costs.slippage > 0
          ? `Walking the book for ${costs.units.toFixed(2)} units lifts the average price`
          : 'Top level absorbs the full size',
    ),
    warnings,
    settlement_diff: settlementDiff,
    venues,
    detected_at: now.toISOString(),
    quote_age_ms: quoteAge,
    time_to_settlement_ms: timeToSettlement,
  };
}

/* ------------------------------------------------------------------ *
 * Detectors
 * ------------------------------------------------------------------ */

/**
 * Buying both sides of one binary market for less than the $1 it pays.
 *
 * On a venue that publishes bid-only books this requires a crossed book and
 * is therefore vanishingly rare, but it is the mechanically simplest
 * guaranteed arb and it is the correct check to run on any venue that quotes
 * two independent ask ladders.
 */
export function detectComplementary(
  snapshot: EventSnapshot,
  opts: ResolvedOptions,
): Opportunity[] {
  const out: Opportunity[] = [];
  for (const { market, quote } of snapshot.markets) {
    if (market.status !== 'OPEN') continue;
    const yesAsks = quote.book.yes_asks;
    const noAsks = quote.book.no_asks;
    if (yesAsks.length === 0 || noAsks.length === 0) continue;
    if (yesAsks[0]!.price + noAsks[0]!.price >= ONE_DOLLAR) continue;

    const legs: LegSpec[] = [
      { market, quote, side: 'BUY_YES', ladder: yesAsks, contracts_per_unit: 1 },
      { market, quote, side: 'BUY_NO', ladder: noAsks, contracts_per_unit: 1 },
    ];
    const opportunity = buildOpportunity({
      type: 'GUARANTEED_ARB',
      event: snapshot.event,
      eventTitle: market.title,
      legs,
      matchConfidence: CONFIDENCE.MECHANICALLY_IDENTICAL,
      settlementDiff: identicalSettlement(),
      opts,
    });
    if (opportunity) out.push(opportunity);
  }
  return out;
}

/**
 * Guards for the NO basket: buying NO on every leg.
 *
 * Mutual exclusivity is sufficient here. At most one outcome resolves YES, so
 * of any subset of S legs at least S-1 must pay — the guarantee holds even if
 * the venue lists outcomes we cannot see.
 */
function noBasketEligible(snapshot: EventSnapshot): { ok: boolean; reason: string } {
  if (!snapshot.event.canonical_outcome_set) {
    return { ok: false, reason: 'outcomes are not established as mutually exclusive' };
  }
  if (snapshot.markets.length < 2) {
    return { ok: false, reason: 'fewer than two outcomes' };
  }
  if (snapshot.markets.some((m) => m.market.status !== 'OPEN')) {
    return { ok: false, reason: 'at least one outcome is closed or settled' };
  }
  return { ok: true, reason: '' };
}

/**
 * Guards for the YES basket: buying YES on every leg.
 *
 * This needs strictly more than mutual exclusivity. If no outcome is
 * guaranteed to occur, every YES leg can expire worthless and the "cost below
 * guaranteed payout" framing is simply false — so the outcome set must be
 * exhaustive *and* completely present.
 */
function yesBasketEligible(snapshot: EventSnapshot): { ok: boolean; reason: string } {
  const base = noBasketEligible(snapshot);
  if (!base.ok) return base;

  const outcomes = snapshot.event.canonical_outcome_set!;
  if (!snapshot.event.exhaustive) {
    return {
      ok: false,
      reason:
        'outcome set is not known to be exhaustive, so every YES leg could lose — ' +
        'a YES basket is not a hedge here',
    };
  }
  if (snapshot.markets.length !== outcomes.length) {
    return {
      ok: false,
      reason: `only ${snapshot.markets.length} of ${outcomes.length} outcomes are present`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * Buying YES on every outcome of a mutually exclusive, exhaustive event for
 * less than the $1 that exactly one of them must pay.
 */
export function detectYesBasket(
  snapshot: EventSnapshot,
  opts: ResolvedOptions,
): Opportunity | null {
  if (!yesBasketEligible(snapshot).ok) return null;

  const legs: LegSpec[] = [];
  let cost = 0;
  for (const { market, quote } of snapshot.markets) {
    const ladder = quote.book.yes_asks;
    if (ladder.length === 0) return null;
    cost += ladder[0]!.price;
    legs.push({ market, quote, side: 'BUY_YES', ladder, contracts_per_unit: 1 });
  }
  if (cost >= ONE_DOLLAR) return null;

  return buildOpportunity({
    type: 'GUARANTEED_ARB',
    event: snapshot.event,
    eventTitle: snapshot.markets[0]?.market.title ?? snapshot.event.event_id,
    legs,
    matchConfidence: CONFIDENCE.MECHANICALLY_IDENTICAL,
    settlementDiff: identicalSettlement(),
    opts,
  });
}

/**
 * The dual: buying NO on every outcome. Exactly one outcome resolves YES, so
 * N-1 of the NO legs pay. One unit therefore holds 1/(N-1) contracts of each
 * leg, which makes the guaranteed payout exactly $1 and keeps the position
 * comparable with every other opportunity type.
 */
export function detectNoBasket(
  snapshot: EventSnapshot,
  opts: ResolvedOptions,
): Opportunity | null {
  if (!noBasketEligible(snapshot).ok) return null;

  const n = snapshot.markets.length;
  const winners = n - 1;
  if (winners < 1) return null;
  const contractsPerUnit = 1 / winners;

  const legs: LegSpec[] = [];
  let cost = 0;
  for (const { market, quote } of snapshot.markets) {
    const ladder = quote.book.no_asks;
    if (ladder.length === 0) return null;
    cost += ladder[0]!.price * contractsPerUnit;
    legs.push({ market, quote, side: 'BUY_NO', ladder, contracts_per_unit: contractsPerUnit });
  }
  if (cost >= ONE_DOLLAR) return null;

  return buildOpportunity({
    type: 'GUARANTEED_ARB',
    event: snapshot.event,
    eventTitle: snapshot.markets[0]?.market.title ?? snapshot.event.event_id,
    legs,
    matchConfidence: CONFIDENCE.MECHANICALLY_IDENTICAL,
    settlementDiff: identicalSettlement(),
    opts,
    extraWarnings: snapshot.event.exhaustive
      ? []
      : [
          `Outcome set is not known to be exhaustive. That is safe for a NO basket — if no ` +
            `outcome resolves YES, all ${n} legs pay — so $1.00 per unit is the floor, not the ` +
            `expected payout.`,
        ],
  });
}

/**
 * Opposite positions on two venues in the same outcome. Buying YES on one and
 * NO on the other guarantees exactly one leg pays $1, so the position is
 * hedged whenever the two asks sum to less than a dollar — provided the
 * matcher has cleared the pairing.
 */
export function detectCrossVenue(
  match: MarketMatch,
  byId: Map<string, MarketSnapshot>,
  eventsById: Map<string, Event>,
  opts: ResolvedOptions,
): Opportunity | null {
  if (!match.eligible_for_arbitrage) return null;
  const left = byId.get(match.left_market_id);
  const right = byId.get(match.right_market_id);
  if (!left || !right) return null;
  if (left.market.status !== 'OPEN' || right.market.status !== 'OPEN') return null;

  const directions: Array<[MarketSnapshot, MarketSnapshot]> = [
    [left, right],
    [right, left],
  ];

  let best: Opportunity | null = null;
  for (const [yesSide, noSide] of directions) {
    const yesLadder = yesSide.quote.book.yes_asks;
    const noLadder = noSide.quote.book.no_asks;
    if (yesLadder.length === 0 || noLadder.length === 0) continue;
    if (yesLadder[0]!.price + noLadder[0]!.price >= ONE_DOLLAR) continue;

    const legs: LegSpec[] = [
      { market: yesSide.market, quote: yesSide.quote, side: 'BUY_YES', ladder: yesLadder, contracts_per_unit: 1 },
      { market: noSide.market, quote: noSide.quote, side: 'BUY_NO', ladder: noLadder, contracts_per_unit: 1 },
    ];

    const event = eventsById.get(yesSide.market.event_id);
    const opportunity = buildOpportunity({
      type: 'CROSS_VENUE_ARB',
      event: event ?? {
        event_id: yesSide.market.event_id,
        category: 'OTHER',
        participants: [],
        start_time: null,
        end_time: null,
        canonical_outcome_set: null,
        exhaustive: false,
        exhaustive_basis: 'unknown event',
      },
      eventTitle: yesSide.market.title,
      legs,
      matchConfidence: match.confidence,
      settlementDiff: match.settlement_diff,
      opts,
    });
    if (opportunity && (!best || opportunity.net_edge > best.net_edge)) best = opportunity;
  }
  return best;
}

/**
 * How wide the two-way market is, or null when the quote is too wide — or too
 * one-sided — for its implied probability to mean anything.
 *
 * Two venue shapes, one question. An exchange quotes a bid and an ask, and
 * the midpoint is only informative when they are close. A sportsbook quotes
 * both outcomes with a margin baked in and no bid at all, so its width is the
 * overround. Both are the cost of a round trip; only the scale differs.
 */
function quoteWidth(quote: Quote, opts: ResolvedOptions): DeciCents | null {
  if (quote.bid !== null && quote.ask !== null) {
    const spread = quote.ask - quote.bid;
    return spread >= 0 && spread <= opts.max_spread_for_divergence ? spread : null;
  }
  if (quote.ask !== null && quote.no_ask !== null) {
    const overround = quote.ask + quote.no_ask - ONE_DOLLAR;
    return overround >= 0 && overround <= opts.max_overround_for_divergence ? overround : null;
  }
  return null;
}

/**
 * Markets that imply meaningfully different probabilities with no guaranteed
 * hedge available. Reported so the divergence is visible, but never as
 * arbitrage — the position can lose.
 */
export function detectRelativeValue(
  match: MarketMatch,
  byId: Map<string, MarketSnapshot>,
  eventsById: Map<string, Event>,
  opts: ResolvedOptions,
): Opportunity | null {
  const left = byId.get(match.left_market_id);
  const right = byId.get(match.right_market_id);
  if (!left || !right) return null;
  if (match.confidence < CONFIDENCE.REVIEW_MIN) return null;

  const leftProb = left.quote.implied_probability;
  const rightProb = right.quote.implied_probability;
  if (leftProb === null || rightProb === null) return null;

  // Two wide books can "disagree" purely because their midpoints are noise.
  if (quoteWidth(left.quote, opts) === null || quoteWidth(right.quote, opts) === null) {
    return null;
  }

  const divergence = Math.abs(leftProb - rightProb) * ONE_DOLLAR;
  if (divergence < opts.relative_value_threshold) return null;

  // Express the view as buying the cheaper side outright.
  const cheap = leftProb <= rightProb ? left : right;
  const ladder = cheap.quote.book.yes_asks;
  if (ladder.length === 0) return null;

  const event = eventsById.get(cheap.market.event_id);
  return buildOpportunity({
    type: 'RELATIVE_VALUE',
    event: event ?? {
      event_id: cheap.market.event_id,
      category: 'OTHER',
      participants: [],
      start_time: null,
      end_time: null,
      canonical_outcome_set: null,
      exhaustive: false,
      exhaustive_basis: 'unknown event',
    },
    eventTitle: cheap.market.title,
    legs: [
      { market: cheap.market, quote: cheap.quote, side: 'BUY_YES', ladder, contracts_per_unit: 1 },
    ],
    matchConfidence: match.confidence,
    settlementDiff: match.settlement_diff,
    opts,
    grossEdgeOverride: roundHalfAway(divergence),
    extraWarnings: [
      `Venues disagree by ${(divergence / 10).toFixed(1)} cents on this outcome's probability, ` +
        `but no offsetting position is available at a hedgeable price.`,
    ],
  });
}

/**
 * Single-venue probability divergence: an exhaustive outcome set whose mid
 * prices do not sum to $1. Not hedgeable at the quoted asks, so it is
 * reported as relative value rather than arbitrage.
 */
export function detectBasketDivergence(
  snapshot: EventSnapshot,
  opts: ResolvedOptions,
): Opportunity | null {
  // Divergence is a description, not a hedge, so mutual exclusivity is enough.
  if (!noBasketEligible(snapshot).ok) return null;

  // Every outcome must be quoted tightly enough for its mid to be a
  // probability. One 1c/99c market in the basket is enough to manufacture an
  // arbitrarily large "overround" out of nothing but spread width.
  const spreads = snapshot.markets.map((m) => quoteWidth(m.quote, opts));
  if (spreads.some((s) => s === null)) return null;
  const widestSpread = Math.max(...(spreads as number[]));

  const probs = snapshot.markets.map((m) => m.quote.implied_probability);
  if (probs.some((p) => p === null)) return null;
  const sum = (probs as number[]).reduce((a, b) => a + b, 0);

  // Direction matters, and only one direction is informative when the
  // outcome set is not exhaustive. Mutually exclusive outcomes must sum to at
  // most 1, so an *overround* is always an anomaly — but an underround is the
  // expected state whenever some unlisted outcome can also occur. Flagging it
  // would report every far-dated multi-candidate market as mispriced.
  const overround = sum - 1;
  const divergence = snapshot.event.exhaustive
    ? Math.abs(overround) * ONE_DOLLAR
    : Math.max(0, overround) * ONE_DOLLAR;
  if (divergence < opts.relative_value_threshold) return null;

  // Underround (sum < 1) points at the YES basket; overround at the NO basket.
  const cheapest = snapshot.markets
    .slice()
    .sort((a, b) => (a.quote.ask ?? ONE_DOLLAR) - (b.quote.ask ?? ONE_DOLLAR))[0];
  if (!cheapest) return null;
  const ladder = cheapest.quote.book.yes_asks;
  if (ladder.length === 0) return null;

  return buildOpportunity({
    type: 'RELATIVE_VALUE',
    event: snapshot.event,
    eventTitle: cheapest.market.title,
    legs: [
      {
        market: cheapest.market,
        quote: cheapest.quote,
        side: 'BUY_YES',
        ladder,
        contracts_per_unit: 1,
      },
    ],
    matchConfidence: CONFIDENCE.MECHANICALLY_IDENTICAL,
    settlementDiff: identicalSettlement(),
    opts,
    grossEdgeOverride: roundHalfAway(divergence),
    extraWarnings: [
      `Mid prices across the ${snapshot.markets.length} mutually exclusive outcomes sum to ` +
        `${sum.toFixed(4)}, ${
          overround > 0
            ? 'above the 1.0000 they can jointly be worth'
            : 'below the 1.0000 this exhaustive set must be worth'
        }, but the ask side is too wide to lock the difference in. Widest ` +
        `bid-ask across the outcomes is ${(widestSpread / 10).toFixed(1)}c.`,
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

export interface ScanInput {
  events: EventSnapshot[];
  /** Cross-venue pairings that the matching engine has already validated. */
  matches?: MarketMatch[];
}

export interface ScanResult {
  opportunities: Opportunity[];
  scanned_events: number;
  scanned_markets: number;
  scanned_at: string;
}

export function scan(input: ScanInput, options: ArbEngineOptions): ScanResult {
  const opts = resolve(options);
  const found: Opportunity[] = [];

  const byId = new Map<string, MarketSnapshot>();
  const eventsById = new Map<string, Event>();
  let marketCount = 0;

  for (const snapshot of input.events) {
    eventsById.set(snapshot.event.event_id, snapshot.event);
    for (const m of snapshot.markets) {
      byId.set(m.market.market_id, m);
      marketCount += 1;
    }
  }

  for (const snapshot of input.events) {
    found.push(...detectComplementary(snapshot, opts));
    const yesBasket = detectYesBasket(snapshot, opts);
    if (yesBasket) found.push(yesBasket);
    const noBasket = detectNoBasket(snapshot, opts);
    if (noBasket) found.push(noBasket);
    if (!yesBasket && !noBasket) {
      const divergence = detectBasketDivergence(snapshot, opts);
      if (divergence) found.push(divergence);
    }
  }

  for (const match of input.matches ?? []) {
    const cross = detectCrossVenue(match, byId, eventsById, opts);
    if (cross) {
      found.push(cross);
      continue;
    }
    const relative = detectRelativeValue(match, byId, eventsById, opts);
    if (relative) found.push(relative);
  }

  // Deduplicate: two detectors can legitimately reach the same leg set.
  const deduped = new Map<string, Opportunity>();
  for (const opportunity of found) {
    const existing = deduped.get(opportunity.opportunity_id);
    if (!existing || opportunity.net_edge > existing.net_edge) {
      deduped.set(opportunity.opportunity_id, opportunity);
    }
  }

  const opportunities = [...deduped.values()]
    .filter((o) => o.capacity >= opts.min_capacity_units || o.type === 'RELATIVE_VALUE')
    .sort((a, b) => b.net_edge - a.net_edge);

  return {
    opportunities,
    scanned_events: input.events.length,
    scanned_markets: marketCount,
    scanned_at: opts.now().toISOString(),
  };
}

/** Consensus probability across every venue quoting an outcome. */
export function consensusFor(snapshots: MarketSnapshot[]): number | null {
  return consensusProbability(
    snapshots
      .filter((s) => s.quote.implied_probability !== null)
      .map((s) => ({
        probability: s.quote.implied_probability as number,
        spread:
          s.quote.ask !== null && s.quote.bid !== null ? Math.abs(s.quote.ask - s.quote.bid) : 100,
      })),
  );
}
