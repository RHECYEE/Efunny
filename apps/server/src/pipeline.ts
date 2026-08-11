import {
  countOpportunities,
  matchMarkets,
  scan,
  type EventSnapshot,
  type Market,
  type MarketMatch,
  type MarketSnapshot,
  type Opportunity,
  type Quote,
  type ScanResult,
} from '@arbterminal/core';
import { feeBookFor, type VenueAdapter } from '@arbterminal/adapters';
import type { Store } from './db.js';

/**
 * The ingestion pipeline.
 *
 *   adapters -> normalized snapshots -> matching engine -> arb engine -> state
 *
 * The pipeline itself is venue-agnostic: it iterates whatever adapters it was
 * constructed with. Adding a venue means passing one more adapter here.
 */

export interface PipelineOptions {
  market_limit: number;
  stale_quote_ms: number;
  min_net_edge: number;
  history_retention_days: number;
}

export interface CycleResult {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  events: number;
  markets: number;
  matches: number;
  opportunities: number;
  errors: Array<{ venue: string; message: string }>;
}

export class Pipeline {
  private snapshots: EventSnapshot[] = [];
  private marketIndex = new Map<string, MarketSnapshot>();
  private matches: MarketMatch[] = [];
  private latest: ScanResult | null = null;
  private lastCycle: CycleResult | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly adapters: VenueAdapter[],
    private readonly store: Store,
    private readonly options: PipelineOptions,
  ) {}

  get opportunities(): Opportunity[] {
    return this.latest?.opportunities ?? [];
  }

  get events(): EventSnapshot[] {
    return this.snapshots;
  }

  get status() {
    return {
      adapters: this.adapters.map((a) => ({
        venue: a.venue,
        display_name: a.display_name,
        capabilities: a.capabilities,
      })),
      last_cycle: this.lastCycle,
      last_scan_at: this.latest?.scanned_at ?? null,
      counts: countOpportunities(this.opportunities),
      quote_log_rows: this.store.count('quote_log'),
      running: this.running,
    };
  }

  snapshotFor(marketId: string): MarketSnapshot | undefined {
    return this.marketIndex.get(marketId);
  }

  opportunity(id: string): Opportunity | undefined {
    return this.opportunities.find((o) => o.opportunity_id === id);
  }

  /** Every market currently known, across every venue. */
  markets(): Market[] {
    return [...this.marketIndex.values()].map((m) => m.market);
  }

  matchesFor(marketId: string): MarketMatch[] {
    return this.matches.filter(
      (m) => m.left_market_id === marketId || m.right_market_id === marketId,
    );
  }

  /**
   * Re-fetch quotes straight from the venue. Paper trading uses this so a
   * simulated fill is priced against a live book rather than the cached one
   * that produced the card.
   */
  async freshQuotes(marketIds: string[]): Promise<Quote[]> {
    const byVenue = new Map<string, string[]>();
    for (const marketId of marketIds) {
      const venue = marketId.split(':')[0] ?? '';
      const bucket = byVenue.get(venue);
      if (bucket) bucket.push(marketId);
      else byVenue.set(venue, [marketId]);
    }

    const quotes: Quote[] = [];
    for (const [venue, ids] of byVenue) {
      const adapter = this.adapters.find((a) => a.venue === venue);
      if (!adapter) continue;
      quotes.push(...(await adapter.fetchQuotes(ids)));
    }
    return quotes;
  }

  async runCycle(): Promise<CycleResult> {
    const startedAt = new Date();
    const errors: CycleResult['errors'] = [];
    const snapshots: EventSnapshot[] = [];

    for (const adapter of this.adapters) {
      try {
        snapshots.push(...(await adapter.fetchSnapshots({ limit: this.options.market_limit })));
      } catch (error) {
        errors.push({
          venue: adapter.venue,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Keep the previous cycle's data if every venue failed, so the terminal
    // shows stale-but-labelled prices rather than an empty screen.
    if (snapshots.length === 0 && errors.length > 0) {
      const finishedAt = new Date();
      this.lastCycle = {
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        events: this.snapshots.length,
        markets: this.marketIndex.size,
        matches: this.matches.length,
        opportunities: this.opportunities.length,
        errors,
      };
      return this.lastCycle;
    }

    this.snapshots = snapshots;
    this.marketIndex = new Map();
    for (const snapshot of snapshots) {
      for (const marketSnapshot of snapshot.markets) {
        this.marketIndex.set(marketSnapshot.market.market_id, marketSnapshot);
      }
    }

    // Cross-venue pairings. With a single venue registered this is empty by
    // construction, since a match requires two distinct venues.
    this.matches =
      this.adapters.length > 1 ? matchMarkets(this.markets()) : [];

    this.latest = scan(
      { events: snapshots, matches: this.matches },
      {
        fees: feeBookFor(this.adapters),
        stale_quote_ms: this.options.stale_quote_ms,
        min_net_edge: this.options.min_net_edge,
      },
    );

    this.store.recordQuotes(
      [...this.marketIndex.values()].map((m) => ({
        quote: m.quote,
        venue: m.market.venue,
      })),
    );
    this.store.recordOpportunities(this.latest.opportunities);

    const finishedAt = new Date();
    this.lastCycle = {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      events: snapshots.length,
      markets: this.marketIndex.size,
      matches: this.matches.length,
      opportunities: this.latest.opportunities.length,
      errors,
    };
    return this.lastCycle;
  }

  start(intervalMs: number): void {
    if (this.running) return;
    this.running = true;

    const tick = async () => {
      try {
        await this.runCycle();
        this.store.prune(this.options.history_retention_days);
      } catch (error) {
        // A cycle failure must never stop the loop; the next one may succeed.
        console.error('[pipeline] cycle failed:', error);
      }
      if (this.running) this.timer = setTimeout(tick, intervalMs);
    };

    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
