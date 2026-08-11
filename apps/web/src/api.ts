import type {
  CartSummary,
  Market,
  MarketMatch,
  Opportunity,
  OpportunityCounts,
  OpportunityFilter,
  PaperTrade,
  Quote,
} from '@arbterminal/core';

/** Thin typed wrapper over the read-only API. */

export interface StatusResponse {
  adapters: Array<{
    venue: string;
    display_name: string;
    capabilities: Record<string, unknown>;
  }>;
  last_cycle: {
    started_at: string;
    finished_at: string;
    duration_ms: number;
    events: number;
    markets: number;
    matches: number;
    opportunities: number;
    errors: Array<{ venue: string; message: string }>;
  } | null;
  last_scan_at: string | null;
  counts: OpportunityCounts;
  quote_log_rows: number;
  running: boolean;
}

export interface QuoteHistoryPoint {
  timestamp: string;
  bid: number | null;
  ask: number | null;
  no_bid: number | null;
  no_ask: number | null;
  implied_probability: number | null;
  liquidity: number;
}

export interface AnalysisResponse {
  opportunity: Opportunity;
  markets: Market[];
  quotes: Quote[];
  consensus_probability: number | null;
  price_history: Record<string, QuoteHistoryPoint[]>;
  edge_history: Array<{
    detected_at: string;
    net_edge: number;
    gross_edge: number;
    capacity: number;
  }>;
  matches: MarketMatch[];
}

export interface OpportunitiesResponse {
  opportunities: Opportunity[];
  counts: OpportunityCounts;
  total_before_filter: number;
  scanned_at: string | null;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(detail.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function filterToQuery(filter: OpportunityFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return params.toString();
}

export const api = {
  status: () => json<StatusResponse>('/api/status'),

  opportunities: (filter: OpportunityFilter) =>
    json<OpportunitiesResponse>(`/api/opportunities?${filterToQuery(filter)}`),

  analysis: (id: string) => json<AnalysisResponse>(`/api/opportunities/${encodeURIComponent(id)}`),

  paperTrade: (id: string, bankroll: number) =>
    json<{ trade: PaperTrade; execution_quotes_refetched: boolean }>(
      `/api/opportunities/${encodeURIComponent(id)}/paper-trade`,
      { method: 'POST', body: JSON.stringify({ bankroll }) },
    ),

  trades: () =>
    json<{
      trades: PaperTrade[];
      stats: {
        trades: number;
        open: number;
        resolved: number;
        capital_deployed: number;
        realized_pl: number;
        mean_displayed_edge: number;
        mean_fillable_edge: number;
        edge_capture_rate: number;
        fully_hedged_rate: number;
        shortfall_causes: Record<string, number>;
      };
    }>('/api/trades'),

  cartSummary: (entries: Array<{ opportunity_id: string; units: number }>) =>
    json<{ summary: CartSummary }>('/api/cart/summary', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    }),
};
