import type { OpportunityFilter } from '@arbterminal/core';
import type { StatusResponse } from '../api.js';

interface Props {
  filter: OpportunityFilter;
  onChange: (next: OpportunityFilter) => void;
  status: StatusResponse | null;
  matched: number;
  total: number;
}

const SETTLEMENT_WINDOWS: Array<{ label: string; ms: number | undefined }> = [
  { label: 'Any', ms: undefined },
  { label: '< 24 hours', ms: 86_400_000 },
  { label: '< 7 days', ms: 7 * 86_400_000 },
  { label: '< 30 days', ms: 30 * 86_400_000 },
  { label: '< 1 year', ms: 365 * 86_400_000 },
];

export function Filters({ filter, onChange, status, matched, total }: Props) {
  const set = <K extends keyof OpportunityFilter>(key: K, value: OpportunityFilter[K]) => {
    const next = { ...filter };
    if (value === undefined || value === ('' as unknown as OpportunityFilter[K])) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  const number = (value: string): number | undefined => {
    if (value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const venues = status?.adapters.map((a) => a.venue) ?? [];

  return (
    <div className="rail">
      <div className="section-title">Filters</div>

      <div className="field">
        <label>Search</label>
        <input
          value={filter.search ?? ''}
          placeholder="event or outcome"
          onChange={(e) => set('search', e.target.value)}
        />
      </div>

      <div className="field">
        <label>Minimum executable edge (¢ per $1)</label>
        <input
          type="number"
          step="0.1"
          value={filter.min_net_edge !== undefined ? filter.min_net_edge / 10 : ''}
          placeholder="0.0"
          onChange={(e) => {
            const cents = number(e.target.value);
            set('min_net_edge', cents === undefined ? undefined : Math.round(cents * 10));
          }}
        />
        <div className="hint">Filters on the cost-adjusted edge, not the raw spread.</div>
      </div>

      <div className="field">
        <label>Minimum liquidity (contracts)</label>
        <input
          type="number"
          step="1"
          value={filter.min_liquidity ?? ''}
          placeholder="0"
          onChange={(e) => set('min_liquidity', number(e.target.value))}
        />
        <div className="hint">Applies to the thinnest leg.</div>
      </div>

      <div className="field">
        <label>Minimum match confidence</label>
        <select
          value={filter.min_match_confidence ?? ''}
          onChange={(e) => set('min_match_confidence', number(e.target.value))}
        >
          <option value="">Any above the 80% floor</option>
          <option value="0.8">80% — review band and up</option>
          <option value="0.95">95% — almost certainly identical</option>
          <option value="1">100% — mechanically identical only</option>
        </select>
        <div className="hint">
          Nothing below 80% is ever shown as arbitrage, whatever this is set to.
        </div>
      </div>

      <div className="field">
        <label>Maximum quote age</label>
        <select
          value={filter.max_quote_age_ms ?? ''}
          onChange={(e) => set('max_quote_age_ms', number(e.target.value))}
        >
          <option value="">Any</option>
          <option value="15000">15 seconds</option>
          <option value="60000">1 minute</option>
          <option value="300000">5 minutes</option>
        </select>
      </div>

      <div className="field">
        <label>Maximum capital required (USD)</label>
        <input
          type="number"
          step="10"
          value={filter.max_capital !== undefined ? filter.max_capital / 1000 : ''}
          placeholder="no cap"
          onChange={(e) => {
            const dollars = number(e.target.value);
            set('max_capital', dollars === undefined ? undefined : Math.round(dollars * 1000));
          }}
        />
      </div>

      <div className="field">
        <label>Time to settlement</label>
        <select
          value={filter.max_time_to_settlement_ms ?? ''}
          onChange={(e) => set('max_time_to_settlement_ms', number(e.target.value))}
        >
          {SETTLEMENT_WINDOWS.map((window) => (
            <option key={window.label} value={window.ms ?? ''}>
              {window.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Venue combination</label>
        <select
          value={(filter.venues ?? []).join(',')}
          onChange={(e) => set('venues', e.target.value === '' ? undefined : e.target.value.split(','))}
        >
          <option value="">All venues</option>
          {venues.map((venue) => (
            <option key={venue} value={venue}>
              {venue} only
            </option>
          ))}
          {venues.length > 1 && <option value={venues.join(',')}>{venues.join(' + ')}</option>}
        </select>
      </div>

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={filter.guaranteed_only === true}
            onChange={(e) => set('guaranteed_only', e.target.checked ? true : undefined)}
          />
          Guaranteed only
        </label>
        <div className="hint">
          {filter.guaranteed_only
            ? 'Showing hedged positions only.'
            : 'Including near-arb and relative value, which can lose.'}
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 4 }}>
        Result
      </div>
      <div className="field">
        <div className="row between">
          <span className="muted">Matching</span>
          <span className="num">
            {matched} / {total}
          </span>
        </div>
        {status?.counts && (
          <>
            <div className="row between">
              <span className="muted">Guaranteed</span>
              <span className="num pos">{status.counts.by_type.GUARANTEED_ARB}</span>
            </div>
            <div className="row between">
              <span className="muted">Cross-venue</span>
              <span className="num">{status.counts.by_type.CROSS_VENUE_ARB}</span>
            </div>
            <div className="row between">
              <span className="muted">Near arb</span>
              <span className="num warn">{status.counts.by_type.NEAR_ARB}</span>
            </div>
            <div className="row between">
              <span className="muted">Relative value</span>
              <span className="num">{status.counts.by_type.RELATIVE_VALUE}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
