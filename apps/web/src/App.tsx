import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Opportunity, OpportunityFilter, Section } from '@arbterminal/core';
import { api, type StatusResponse } from './api.js';
import { formatAge } from './format.js';
import { arbStatus } from '@arbterminal/core';
import { Analysis } from './components/Analysis.js';
import { ResultCard } from './components/ResultCard.js';
import { Cart, type CartEntry } from './components/Cart.js';
import { Filters } from './components/Filters.js';
import { PaperTradeDialog } from './components/PaperTradeDialog.js';
import { UfcBoard } from './components/UfcBoard.js';
import { Scanner } from './components/Scanner.js';
import { NflBoard } from './components/NflBoard.js';
import { Portfolio } from './components/Portfolio.js';

type Tab = 'ARBITRAGE' | 'NFL' | 'UFC' | 'FEATURED' | 'CART' | 'PORTFOLIO';

const POLL_MS = 10_000;

export function App() {
  const [tab, setTab] = useState<Tab>('ARBITRAGE');
  const [filter, setFilter] = useState<OpportunityFilter>({});
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [totalBeforeFilter, setTotalBeforeFilter] = useState(0);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tradingId, setTradingId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [portfolioKey, setPortfolioKey] = useState(0);
  // Dollars, as typed. Sizing is driven by what the user will actually
  // deploy, not by whatever depth happens to exist.
  const [bankroll, setBankroll] = useState('1000');
  // The point of the tool is to find opportunities, not to publish a feed of
  // things that do not work, so dead ends are collapsed until asked for.
  const [showRejected, setShowRejected] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // One arbitrage tab covers both sections. Splitting prediction markets from
  // sports was a distinction about where a contract is listed, not about
  // whether it is a hedge, and it hid half the opportunities behind a tab
  // nobody had a reason to click.
  const section: Section | undefined = undefined;

  const load = useCallback(async () => {
    try {
      const [opportunityResponse, statusResponse] = await Promise.all([
        api.opportunities(section ? { ...filter, section } : filter),
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
              ['ARBITRAGE', 'Arbitrage'],
              ['NFL', 'NFL'],
              ['UFC', 'UFC'],
              ['FEATURED', 'Featured'],
              ['CART', 'Cart'],
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

      {/* The filter rail and the cart both speak the engine's language —
          executable edge, match confidence, units of a position. Neither
          answers "is there an arbitrage", so neither sits in front of the
          results any more. */}
      <div className={`body single${showFilters && tab !== 'PORTFOLIO' && tab !== 'CART' && tab !== 'UFC' && tab !== 'NFL' && tab !== 'FEATURED' ? ' with-rail' : ''}`}>
        {showFilters && tab !== 'PORTFOLIO' && tab !== 'CART' && tab !== 'UFC' && tab !== 'NFL' && tab !== 'FEATURED' && (
          <Filters
            filter={filter}
            onChange={setFilter}
            status={status}
            matched={opportunities.length}
            total={totalBeforeFilter}
          />
        )}

        <div className="main">
          {tab === 'CART' ? (
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
          ) : tab === 'UFC' ? (
            <UfcBoard />
          ) : tab === 'NFL' ? (
            <NflBoard />
          ) : tab === 'FEATURED' ? (
            <Scanner />
          ) : tab === 'PORTFOLIO' ? (
            <Portfolio refreshKey={portfolioKey} />
          ) : (
            <>
              {(() => {
                const actionable = opportunities.filter((o) => arbStatus(o) !== 'NONE');
                const rejected = opportunities.filter((o) => arbStatus(o) === 'NONE');
                const shown = showRejected ? [...actionable, ...rejected] : actionable;
                const bankrollDeciCents = Math.round((Number(bankroll) || 0) * 1000);

                return (
                  <>
                    <div className="bankroll-bar">
                      <label htmlFor="bankroll">Your bankroll</label>
                      <span className="dollar">$</span>
                      <input
                        id="bankroll"
                        type="number"
                        min="1"
                        step="100"
                        value={bankroll}
                        onChange={(e) => setBankroll(e.target.value)}
                      />
                      <button
                        className="ghost"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => setShowFilters(!showFilters)}
                      >
                        {showFilters ? 'Hide filters' : 'Filters'}
                      </button>
                    </div>

                    {shown.length === 0 ? (
                      <div className="empty">
                        <strong>No arbitrage right now</strong>
                        {rejected.length > 0
                          ? `${rejected.length} pairing${rejected.length === 1 ? '' : 's'} checked and none of them work.`
                          : 'Nothing on these venues currently prices below its own payout. In an efficient market that is the normal state.'}
                      </div>
                    ) : (
                      <div className="results">
                        {shown.map((opportunity) => (
                          <ResultCard
                            key={opportunity.opportunity_id}
                            opportunity={opportunity}
                            bankroll={bankrollDeciCents}
                            onDetails={() =>
                              setSelectedId(
                                selectedId === opportunity.opportunity_id
                                  ? null
                                  : opportunity.opportunity_id,
                              )
                            }
                          />
                        ))}
                      </div>
                    )}

                    <div className="showing">
                      Showing {shown.length} of {opportunities.length} checked
                      {rejected.length > 0 && (
                        <button className="ghost" onClick={() => setShowRejected(!showRejected)}>
                          {showRejected ? 'Hide' : 'Show'} {rejected.length} rejected
                        </button>
                      )}
                    </div>
                  </>
                );
              })()}

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
