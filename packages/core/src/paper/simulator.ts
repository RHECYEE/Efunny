import { tradeId } from '../domain/ids.js';
import { ONE_DOLLAR, roundHalfAway, type DeciCents, type Money } from '../domain/money.js';
import type {
  Leg,
  Opportunity,
  PaperTrade,
  Quote,
  QuoteSnapshot,
  ShortfallReason,
  SimulatedFill,
  TradeResolution,
} from '../domain/types.js';
import { walkBook } from '../normalize/book.js';
import type { FeeBook } from '../arb/fees.js';
import { settlementMismatchReserve } from '../arb/reserve.js';

/**
 * Paper trading.
 *
 * The point of this module is not to pretend the user made money. It is to
 * show the gap between the edge a card advertised and the edge that was
 * actually obtainable a moment later, and to attribute that gap to a specific
 * cause. That delta is the app's core educational payoff.
 *
 * No order is ever placed anywhere. Fills are simulated against a real,
 * re-fetched order book.
 */

export interface ExecuteInput {
  opportunity: Opportunity;
  /** Books as they were when the opportunity was detected. */
  detection_quotes: Quote[];
  /** Books re-fetched at the moment the user pressed Paper Trade. */
  execution_quotes: Quote[];
  /** Capital the user is willing to deploy, in deci-cents. */
  bankroll: Money;
  fees: FeeBook;
  now?: () => Date;
}

function ladderFor(quote: Quote, side: Leg['side']) {
  return side === 'BUY_YES' ? quote.book.yes_asks : quote.book.no_asks;
}

function shortfallFor(
  displayedPrice: DeciCents,
  topPrice: DeciCents | null,
  requested: number,
  filled: number,
  marketOpen: boolean,
): { reason: ShortfallReason | null; detail: string } {
  if (!marketOpen) {
    return { reason: 'MARKET_CLOSED', detail: 'Market was no longer open at execution time.' };
  }
  if (topPrice === null) {
    return {
      reason: 'LEVEL_DISAPPEARED',
      detail: 'The entire ask ladder was gone at execution time; nothing was fillable.',
    };
  }
  if (topPrice > displayedPrice && filled < requested - 1e-9) {
    return {
      reason: 'PRICE_MOVED',
      detail:
        `Best ask moved from ${(displayedPrice / 1000).toFixed(4)} to ` +
        `${(topPrice / 1000).toFixed(4)} and depth ran out before the order filled.`,
    };
  }
  if (topPrice > displayedPrice) {
    return {
      reason: 'PRICE_MOVED',
      detail:
        `Best ask moved from ${(displayedPrice / 1000).toFixed(4)} to ` +
        `${(topPrice / 1000).toFixed(4)} between detection and execution.`,
    };
  }
  if (filled < requested - 1e-9) {
    return {
      reason: 'INSUFFICIENT_SIZE_AT_QUOTE',
      detail:
        `Only ${filled.toFixed(2)} of ${requested.toFixed(2)} contracts were available ` +
        `across the visible book.`,
    };
  }
  return { reason: null, detail: 'Filled in full at or better than the displayed price.' };
}

export function executePaperTrade(input: ExecuteInput): PaperTrade {
  const { opportunity, bankroll, fees } = input;
  const now = (input.now ?? (() => new Date()))();
  const executionByMarket = new Map(input.execution_quotes.map((q) => [q.market_id, q]));

  // Contracts per unit, recovered from the sized position on the card.
  const perUnit = new Map<string, number>();
  for (const leg of opportunity.legs) {
    perUnit.set(
      `${leg.market_id}:${leg.side}`,
      opportunity.capacity > 0 ? leg.contracts / opportunity.capacity : 0,
    );
  }

  // Size to whatever the bankroll supports, never above the card's capacity.
  const affordableUnits =
    opportunity.unit_cost > 0 ? bankroll / opportunity.unit_cost : 0;
  const requestedUnits = Math.min(opportunity.capacity, affordableUnits);

  const fills: SimulatedFill[] = [];
  let unitsExecutable = requestedUnits;

  for (const leg of opportunity.legs) {
    const cpu = perUnit.get(`${leg.market_id}:${leg.side}`) ?? 0;
    const requested = requestedUnits * cpu;
    const quote = executionByMarket.get(leg.market_id);
    const ladder = quote ? ladderFor(quote, leg.side) : [];
    const walk = walkBook(ladder, requested);
    const shortfall = shortfallFor(
      leg.price,
      walk.top_price,
      requested,
      walk.filled,
      quote !== undefined && ladder.length > 0,
    );

    const model = fees.for(leg.venue);
    const context = {
      venue: leg.venue,
      product: leg.market_id.split(':')[1]?.split('-')[0] ?? '',
      side: leg.side,
      price: walk.vwap,
      contracts: walk.filled,
      role: 'TAKER' as const,
    };
    const legFees = model.tradingFee(context) + model.settlementFee(context);

    fills.push({
      market_id: leg.market_id,
      venue: leg.venue,
      side: leg.side,
      requested_contracts: requested,
      filled_contracts: walk.filled,
      // Set once the weakest leg is known and the position is scaled.
      held_contracts: 0,
      displayed_price: leg.price,
      fill_vwap: walk.vwap,
      fees: legFees,
      cost: roundHalfAway(walk.cost),
      shortfall_reason: shortfall.reason,
      shortfall_detail: shortfall.detail,
    });

    if (cpu > 0) unitsExecutable = Math.min(unitsExecutable, walk.filled / cpu);
  }

  // A hedge is only a hedge if every leg fills. Scale the whole position down
  // to the weakest leg rather than reporting a broken hedge as complete.
  const unitsExecuted = Math.max(0, unitsExecutable);
  const fullyHedged = unitsExecuted >= requestedUnits - 1e-6 && requestedUnits > 0;

  let capitalDeployed = 0;
  let fillableCostPerUnit = 0;
  for (const fill of fills) {
    const cpu = perUnit.get(`${fill.market_id}:${fill.side}`) ?? 0;
    fill.held_contracts = unitsExecuted * cpu;
    capitalDeployed += fill.fill_vwap * fill.held_contracts;
    if (fill.held_contracts > 0) capitalDeployed += fill.fees;
    fillableCostPerUnit += fill.fill_vwap * cpu;
  }

  const reserve = settlementMismatchReserve(
    opportunity.settlement_diff,
    opportunity.match_confidence,
  );
  const feePerUnit = unitsExecuted > 0
    ? fills.reduce((sum, f) => sum + f.fees, 0) / unitsExecuted
    : 0;

  const fillableEdge =
    unitsExecuted > 0
      ? ONE_DOLLAR - fillableCostPerUnit - feePerUnit - reserve
      : // Nothing filled: none of the displayed edge was obtainable.
        0;

  const displayedEdge = opportunity.net_edge;
  const decay = displayedEdge - roundHalfAway(fillableEdge);

  return {
    trade_id: tradeId(now),
    opportunity_id: opportunity.opportunity_id,
    opportunity_type: opportunity.type,
    event_id: opportunity.event_id,
    event_title: opportunity.event_title,
    bankroll,
    simulated_fills: fills,
    quote_snapshot_at_detection: snapshotOf(input.detection_quotes, opportunity.detected_at),
    quote_snapshot_at_execution: snapshotOf(input.execution_quotes, now.toISOString()),
    displayed_edge: displayedEdge,
    actually_fillable_edge: roundHalfAway(fillableEdge),
    edge_decay: decay,
    decay_explanation: explainDecay(fills, decay, requestedUnits, unitsExecuted),
    fully_hedged: fullyHedged,
    units_executed: unitsExecuted,
    capital_deployed: roundHalfAway(capitalDeployed),
    guaranteed_payout: fullyHedged ? roundHalfAway(unitsExecuted * ONE_DOLLAR) : 0,
    resolution: unitsExecuted > 0 ? 'OPEN' : 'ABANDONED',
    realized_pl: null,
    created_at: opportunity.detected_at,
    executed_at: now.toISOString(),
    resolved_at: null,
  };
}

function snapshotOf(quotes: Quote[], takenAt: string): QuoteSnapshot {
  return { taken_at: takenAt, quotes };
}

function explainDecay(
  fills: SimulatedFill[],
  decay: DeciCents,
  requestedUnits: number,
  executedUnits: number,
): string {
  const causes = fills
    .filter((f) => f.shortfall_reason !== null)
    .map((f) => `${f.venue} ${f.side === 'BUY_YES' ? 'YES' : 'NO'}: ${f.shortfall_detail}`);

  if (executedUnits <= 0) {
    return (
      `Nothing was fillable at execution time, so none of the displayed edge was real. ` +
      (causes.join(' ') || 'The book had emptied.')
    );
  }
  if (causes.length === 0) {
    return decay === 0
      ? 'The book was unchanged between detection and execution; the displayed edge was fully obtainable.'
      : `Every leg filled as displayed; the ${(Math.abs(decay) / 10).toFixed(2)}c difference is ` +
          `rounding on the scaled position size.`;
  }
  const sizeNote =
    executedUnits < requestedUnits - 1e-6
      ? ` Position scaled down from ${requestedUnits.toFixed(2)} to ${executedUnits.toFixed(2)} ` +
        `units to keep every leg hedged.`
      : '';
  return `${(Math.abs(decay) / 10).toFixed(2)}c of edge was lost. ${causes.join(' ')}${sizeNote}`;
}

/**
 * Settle a paper trade once the real outcome is known.
 *
 * `winningMarketId` is the market whose YES condition came true. Payout is
 * computed leg by leg, so it is correct for baskets and partial hedges alike,
 * not just for the two-leg case.
 */
export function resolvePaperTrade(
  trade: PaperTrade,
  outcome: { winning_market_id: string } | { void: true },
  now: Date = new Date(),
): PaperTrade {
  if ('void' in outcome) {
    const feesPaid = trade.simulated_fills.reduce((sum, f) => sum + f.fees, 0);
    return {
      ...trade,
      resolution: 'VOID',
      // A void returns stakes but not fees paid at trade time. Subtracting
      // from zero rather than negating keeps a fee-free void at +0.
      realized_pl: 0 - feesPaid,
      resolved_at: now.toISOString(),
    };
  }

  // A BUY_YES leg pays when its own market resolves YES; a BUY_NO leg pays
  // whenever some *other* market in the event does. Walking the legs this way
  // settles baskets and two-leg hedges with the same rule.
  let payout = 0;
  for (const fill of trade.simulated_fills) {
    const wins =
      fill.side === 'BUY_YES'
        ? fill.market_id === outcome.winning_market_id
        : fill.market_id !== outcome.winning_market_id;
    if (wins) payout += fill.held_contracts * ONE_DOLLAR;
  }

  const realized = roundHalfAway(payout) - trade.capital_deployed;
  let resolution: TradeResolution;
  if (trade.units_executed <= 0) resolution = 'ABANDONED';
  else if (!trade.fully_hedged) resolution = 'PARTIAL';
  else resolution = realized >= 0 ? 'WON' : 'LOST';

  return { ...trade, resolution, realized_pl: realized, resolved_at: now.toISOString() };
}
