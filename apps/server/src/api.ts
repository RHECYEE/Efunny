import Fastify, { type FastifyInstance } from 'fastify';
import {
  consensusFor,
  countOpportunities,
  executePaperTrade,
  filterOpportunities,
  portfolioStats,
  resolvePaperTrade,
  summarizeCart,
  type OpportunityFilter,
  type Section,
} from '@arbterminal/core';
import { feeBookFor, type VenueAdapter } from '@arbterminal/adapters';
import type { Store } from './db.js';
import type { Pipeline } from './pipeline.js';

/**
 * Read-only HTTP API.
 *
 * There is deliberately no order-entry route here, and none of the venue
 * clients behind it can place one. `POST /paper-trade` simulates a fill
 * against a freshly fetched book and writes a row to the local database;
 * it never contacts a venue's trading surface.
 */

function numberParam(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function listParam(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

export function parseFilter(query: Record<string, unknown>): OpportunityFilter {
  const filter: OpportunityFilter = {};
  const assign = <K extends keyof OpportunityFilter>(key: K, value: OpportunityFilter[K]) => {
    if (value !== undefined) filter[key] = value;
  };

  assign('min_net_edge', numberParam(query.min_net_edge));
  assign('min_liquidity', numberParam(query.min_liquidity));
  assign('min_match_confidence', numberParam(query.min_match_confidence));
  assign('max_quote_age_ms', numberParam(query.max_quote_age_ms));
  assign('max_capital', numberParam(query.max_capital));
  assign('max_time_to_settlement_ms', numberParam(query.max_time_to_settlement_ms));
  assign('min_time_to_settlement_ms', numberParam(query.min_time_to_settlement_ms));
  assign('venues', listParam(query.venues));
  assign('types', listParam(query.types) as OpportunityFilter['types']);
  if (typeof query.section === 'string') assign('section', query.section as Section);
  if (query.guaranteed_only === 'true') assign('guaranteed_only', true);
  if (query.certified_only === 'true') assign('certified_only', true);
  assign('assurance', listParam(query.assurance) as OpportunityFilter['assurance']);
  assign(
    'settlement_assurance',
    listParam(query.settlement_assurance) as OpportunityFilter['settlement_assurance'],
  );
  if (typeof query.search === 'string') assign('search', query.search);
  return filter;
}

export interface ApiDeps {
  pipeline: Pipeline;
  store: Store;
  adapters: VenueAdapter[];
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { pipeline, store, adapters } = deps;

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  app.get('/api/status', async () => pipeline.status);

  app.get('/api/opportunities', async (request) => {
    const filter = parseFilter(request.query as Record<string, unknown>);
    const all = pipeline.opportunities;
    const filtered = filterOpportunities(all, filter);
    return {
      opportunities: filtered,
      counts: countOpportunities(filtered),
      total_before_filter: all.length,
      scanned_at: pipeline.status.last_scan_at,
    };
  });

  /** Full analysis payload for one opportunity. */
  app.get('/api/opportunities/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const opportunity = pipeline.opportunity(id);
    if (!opportunity) return reply.code(404).send({ error: 'opportunity not found' });

    const snapshots = opportunity.markets
      .map((marketId) => pipeline.snapshotFor(marketId))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);

    return {
      opportunity,
      markets: snapshots.map((s) => s.market),
      quotes: snapshots.map((s) => s.quote),
      consensus_probability: consensusFor(snapshots),
      price_history: Object.fromEntries(
        opportunity.markets.map((marketId) => [marketId, store.quoteHistory(marketId, 240)]),
      ),
      edge_history: store.opportunityHistory(id, 240),
      matches: opportunity.markets.flatMap((marketId) => pipeline.matchesFor(marketId)),
    };
  });

  /**
   * Simulate taking an opportunity. Quotes are re-fetched from the venue at
   * this moment so the displayed edge can be compared against what was
   * actually fillable a beat later.
   */
  app.post('/api/opportunities/:id/paper-trade', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { bankroll?: number };
    const opportunity = pipeline.opportunity(id);
    if (!opportunity) return reply.code(404).send({ error: 'opportunity not found' });

    const bankroll = Number(body.bankroll);
    if (!Number.isFinite(bankroll) || bankroll <= 0) {
      return reply.code(400).send({ error: 'bankroll must be a positive number of deci-cents' });
    }

    const detectionQuotes = opportunity.markets
      .map((marketId) => pipeline.snapshotFor(marketId)?.quote)
      .filter((q): q is NonNullable<typeof q> => q !== undefined);

    let executionQuotes = detectionQuotes;
    let refetched = true;
    try {
      const fresh = await pipeline.freshQuotes(opportunity.markets);
      if (fresh.length > 0) executionQuotes = fresh;
      else refetched = false;
    } catch {
      // If the venue is unreachable the honest thing is to price against the
      // cached book and say so, not to fail the simulation silently.
      refetched = false;
    }

    const trade = executePaperTrade({
      opportunity,
      detection_quotes: detectionQuotes,
      execution_quotes: executionQuotes,
      bankroll,
      fees: feeBookFor(adapters),
    });

    store.saveTrade(trade);
    return { trade, execution_quotes_refetched: refetched };
  });

  app.get('/api/trades', async () => {
    const trades = store.trades(500);
    return { trades, stats: portfolioStats(trades) };
  });

  app.post('/api/trades/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { winning_market_id?: string; void?: boolean };
    const trade = store.trade(id);
    if (!trade) return reply.code(404).send({ error: 'trade not found' });

    const resolved = body.void
      ? resolvePaperTrade(trade, { void: true })
      : body.winning_market_id
        ? resolvePaperTrade(trade, { winning_market_id: body.winning_market_id })
        : null;
    if (!resolved) {
      return reply.code(400).send({ error: 'supply winning_market_id or void: true' });
    }

    store.saveTrade(resolved);
    return { trade: resolved };
  });

  app.post('/api/cart/summary', async (request, reply) => {
    const body = (request.body ?? {}) as {
      entries?: Array<{ opportunity_id: string; units: number }>;
    };
    const entries = (body.entries ?? [])
      .map((entry) => {
        const opportunity = pipeline.opportunity(entry.opportunity_id);
        return opportunity ? { opportunity, units: Number(entry.units) || 0 } : null;
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    if (entries.length !== (body.entries ?? []).length) {
      // A repriced cycle can retire an opportunity; the cart must say so
      // rather than quietly costing a position that no longer exists.
      reply.header('x-arbterminal-stale-entries', 'true');
    }

    return {
      summary: summarizeCart(entries),
      resolved_entries: entries.map((e) => ({
        opportunity_id: e.opportunity.opportunity_id,
        units: e.units,
      })),
    };
  });

  app.get('/api/markets/:id/history', async (request) => {
    const { id } = request.params as { id: string };
    const limit = numberParam((request.query as Record<string, unknown>).limit) ?? 240;
    return { market_id: id, history: store.quoteHistory(id, limit) };
  });

  return app;
}
