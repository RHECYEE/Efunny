import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Opportunity, OpportunityFilter, Section } from '@arbterminal/core';
import { api, type StatusResponse } from './api.js';
import { formatAge } from './format.js';
import { Analysis } from './components/Analysis.js';
import { Cart, type CartEntry } from './components/Cart.js';
import { Filters } from './components/Filters.js';
import { OpportunityCard } from './components/OpportunityCard.js';
import { PaperTradeDialog } from './components/PaperTradeDialog.js';
import { Portfolio } from './components/Portfolio.js';

type Tab = 'PREDICTION' | 'SPORTS' | 'PORTFOLIO';

const POLL_MS = 10_000;

export function App() {
  const [tab, setTab] = useState<Tab>('PREDICTION');
  const [filter, setFilter] = useState<OpportunityFilter>({});
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [totalBeforeFilter, setTotalBeforeFilter] = useState(0);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tradingId, setTradingId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [portfolioKey, setPortfolioKey] = useState(0);

  const section: Section = tab === 'SPORTS' ? 'SPORTS' : 'PREDICTION';

  const load = useCallback(async () => {
    try {
      const [opportunityResponse, statusResponse] = await Promise.all([
        api.opportunities({ ...filter, section }),
        api.status(),
      ]);
      setOpportunities(opportunityResponse.opportunities);
      setTotalBeforeFilter(opportunityResponse.total_before_filter);
      setStatus(statusResponse);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter, section]);

  useEffect(() => {
    void load();
    if (tab === 'PORTFOLIO') return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, tab]);

  const selected = useMemo(
    () => opportunities.find((o) => o.opportunity_id === selectedId) ?? null,
    [opportunities, selectedId],
  );
  const trading = useMemo(
    () => opportunities.find((o) => o.opportunity_id === tradingId) ?? null,
    [opportunities, tradingId],
  );

  const toggleCart = (opportunity: Opportunity) => {
    setCart((current) =>
      current.some((entry) => entry.opportunity_id === opportunity.opportunity_id)
        ? current.filter((entry) => entry.opportunity_id !== opportunity.opportunity_id)
        : [
            ...current,
            {
              opportunity_id: opportunity.opportunity_id,
              units: Math.max(1, Math.floor(opportunity.capacity)),
            },
          ],
    );
  };

  const lastCycle = status?.last_cycle;
  const scanAge = status?.last_scan_at ? Date.now() - Date.parse(status.last_scan_at) : null;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          ARB<span>TERMINAL</span>
        </div>

        <div className="tabs">
          {(
            [
              ['PREDICTION', 'Prediction markets'],
              ['SPORTS', 'Sports'],
              ['PORTFOLIO', 'Paper portfolio'],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              className={`tab${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="status-strip num">
          <span>{status?.adapters.map((a) => a.display_name).join(' · ') ?? '—'}</span>
          <span>{lastCycle ? `${lastCycle.markets} markets` : '—'}</span>
          <span>{status ? `${status.quote_log_rows.toLocaleString()} quotes logged` : '—'}</span>
          <span className={scanAge !== null && scanAge > 120_000 ? 'warn' : ''}>
            scan {scanAge !== null ? formatAge(scanAge) : '—'} ago
          </span>
          <span className={status?.running ? 'pos' : 'warn'}>
            {status?.running ? '● live' : '○ idle'}
          </span>
        </div>
      </div>

      {error && <div className="banner err">API unreachable: {error}</div>}
      {lastCycle && lastCycle.errors.length > 0 && (
        <div className="banner">
          {lastCycle.errors.map((venueError) => (
            <div key={venueError.venue}>
              ⚠ {venueError.venue}: {venueError.message}
            </div>
          ))}
        </div>
      )}

      <div className={`body${tab === 'PORTFOLIO' ? ' no-cart' : ''}`}>
        {tab === 'PORTFOLIO' ? (
          <div className="rail">
            <div className="section-title">Paper portfolio</div>
            <div className="field">
              <div className="muted">
                Every simulated fill is priced against a book re-fetched at execution time. No order
                is ever placed at any venue.
              </div>
            </div>
          </div>
        ) : (
          <Filters
            filter={filter}
            onChange={setFilter}
            status={status}
            matched={opportunities.length}
            total={totalBeforeFilter}
          />
        )}

        <div className="main">
          {tab === 'PORTFOLIO' ? (
            <Portfolio refreshKey={portfolioKey} />
          ) : (
            <>
              {opportunities.length === 0 ? (
                <div className="empty">
                  <strong>Nothing clears the bar right now</strong>
                  {tab === 'SPORTS' ? (
                    <>
                      Sports coverage is moneyline-only and needs a second venue to produce
                      cross-venue opportunities. Stage 2 adds a licensed odds provider; until then
                      this section shows only single-venue sports contracts.
                    </>
                  ) : (
                    <>
                      {totalBeforeFilter > 0
                        ? `${totalBeforeFilter} opportunities exist but none match these filters.`
                        : 'No opportunity currently survives fees, slippage and the settlement reserve. That is the normal state of an efficient market.'}
                    </>
                  )}
                </div>
              ) : (
                <div className="cards">
                  {opportunities.map((opportunity) => (
                    <OpportunityCard
                      key={opportunity.opportunity_id}
                      opportunity={opportunity}
                      selected={selectedId === opportunity.opportunity_id}
                      inCart={cart.some(
                        (entry) => entry.opportunity_id === opportunity.opportunity_id,
                      )}
                      onSelect={() =>
                        setSelectedId((current) =>
                          current === opportunity.opportunity_id
                            ? null
                            : opportunity.opportunity_id,
                        )
                      }
                      onPaperTrade={() => setTradingId(opportunity.opportunity_id)}
                      onToggleCart={() => toggleCart(opportunity)}
                    />
                  ))}
                </div>
              )}

              {selected && (
                <Analysis
                  opportunity={selected}
                  onClose={() => setSelectedId(null)}
                  onPaperTrade={() => setTradingId(selected.opportunity_id)}
                />
              )}
            </>
          )}
        </div>

        {tab !== 'PORTFOLIO' && (
          <Cart
            entries={cart}
            opportunities={opportunities}
            onSetUnits={(id, units) =>
              setCart((current) =>
                current.map((entry) =>
                  entry.opportunity_id === id ? { ...entry, units } : entry,
                ),
              )
            }
            onRemove={(id) =>
              setCart((current) => current.filter((entry) => entry.opportunity_id !== id))
            }
            onClear={() => setCart([])}
          />
        )}
      </div>

      {trading && (
        <PaperTradeDialog
          opportunity={trading}
          onClose={() => setTradingId(null)}
          onExecuted={() => setPortfolioKey((key) => key + 1)}
        />
      )}
    </div>
  );
}
