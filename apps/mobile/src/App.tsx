import { useCallback, useEffect, useRef, useState } from 'react';
import { Preferences } from '@capacitor/preferences';
import { arbStatus } from '@arbterminal/core';
import { ResultCard } from './components/ResultCard.js';
import { scanOnDevice, type ScanOutput } from './scan.js';

/**
 * Phone UI.
 *
 * The desktop terminal is a dense multi-panel layout that does not survive a
 * phone screen, so this is not a port of it. It does the three things the app
 * is for: take a capture, compare it against Kalshi, and answer whether there
 * is an arbitrage, how much can go in, and what comes back. Everything the
 * engine knows beyond that stays in the engine.
 */

const STORE_CSV = 'arbterminal.csv';
const STORE_RULES = 'arbterminal.rules';
const STORE_SERIES = 'arbterminal.series';
const STORE_BANKROLL = 'arbterminal.bankroll';

type Tab = 'IMPORT' | 'RESULTS';

export function App() {
  const [tab, setTab] = useState<Tab>('IMPORT');
  const [csv, setCsv] = useState('');
  const [csvName, setCsvName] = useState('');
  const [rules, setRules] = useState('');
  const [series, setSeries] = useState('KXBTCMAXY,KXETHMAXY');
  const [bankroll, setBankroll] = useState('1000');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanOutput | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Restore the last capture so the app opens where it was left.
  useEffect(() => {
    void (async () => {
      const [c, r, s, b] = await Promise.all([
        Preferences.get({ key: STORE_CSV }),
        Preferences.get({ key: STORE_RULES }),
        Preferences.get({ key: STORE_SERIES }),
        Preferences.get({ key: STORE_BANKROLL }),
      ]);
      if (c.value) setCsv(c.value);
      if (r.value) setRules(r.value);
      if (s.value) setSeries(s.value);
      if (b.value) setBankroll(b.value);
    })();
  }, []);

  const persist = useCallback(async (key: string, value: string) => {
    await Preferences.set({ key, value });
  }, []);

  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setCsvName(file.name);
    await persist(STORE_CSV, text);
  }

  async function onScan() {
    setBusy(true);
    try {
      const output = await scanOnDevice({
        sources: csv.trim() ? [{ name: csvName || 'capture.csv', text: csv }] : [],
        rulesText: rules,
        series: series.split(',').map((s) => s.trim()).filter(Boolean),
        venue: 'draftkings',
        displayName: 'DraftKings',
        stakeLimitDollars: 500,
      });
      setResult(output);
      setTab('RESULTS');
      await Promise.all([
        persist(STORE_RULES, rules),
        persist(STORE_SERIES, series),
        persist(STORE_BANKROLL, bankroll),
      ]);
    } catch (e) {
      setResult({
        opportunities: [],
        counts: {
          total: 0,
          by_type: { GUARANTEED_ARB: 0, CROSS_VENUE_ARB: 0, NEAR_ARB: 0, RELATIVE_VALUE: 0 },
          by_assurance: {
            CERTIFIED: 0,
            QUALIFIED_CANDIDATE: 0,
            NOT_PROFITABLE: 0,
            DISQUALIFIED: 0,
            INFORMATIONAL: 0,
          },
          guaranteed: 0,
          venues: [],
          best_net_edge: null,
        },
        diagnostics: null,
        kalshiMarkets: 0,
        importedMarkets: 0,
        matches: 0,
        scannedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      });
      setTab('RESULTS');
    } finally {
      setBusy(false);
    }
  }

  const rowCount = csv.trim() ? Math.max(0, csv.trim().split('\n').length - 1) : 0;

  return (
    <div className="app">
      <header>
        <span className="brand">
          ARB<b>TERMINAL</b>
        </span>
        <span className="tag">read-only · no bets placed</span>
      </header>

      <nav>
        <button className={tab === 'IMPORT' ? 'on' : ''} onClick={() => setTab('IMPORT')}>
          Import
        </button>
        <button className={tab === 'RESULTS' ? 'on' : ''} onClick={() => setTab('RESULTS')}>
          Results
          {result ? ` (${result.opportunities.filter((o) => arbStatus(o) !== 'NONE').length})` : ''}
        </button>
      </nav>

      {tab === 'IMPORT' ? (
        <main>
          <section>
            <h2>1 · Your capture</h2>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={onPickFile}
              style={{ display: 'none' }}
            />
            <button className="primary wide" onClick={() => fileInput.current?.click()}>
              Choose CSV file
            </button>
            <p className="hint">
              {csv.trim()
                ? `${csvName || 'capture'} — ${rowCount} rows loaded`
                : 'No capture loaded yet. You can also paste the CSV below.'}
            </p>
            <textarea
              value={csv}
              placeholder="captured_at,market,outcome,yes_odds,no_odds,observations…"
              onChange={(e) => {
                setCsv(e.target.value);
                void persist(STORE_CSV, e.target.value);
              }}
              rows={5}
            />
          </section>

          <section>
            <h2>2 · Kalshi series to compare against</h2>
            <input
              value={series}
              onChange={(e) => setSeries(e.target.value)}
              placeholder="KXBTCMAXY,KXETHMAXY"
            />
            <p className="hint">
              Kalshi lists around 90,000 open markets and sweeping all of them takes half a
              minute on a phone. Naming the series your capture overlaps with keeps a scan to a
              couple of seconds.
            </p>
          </section>

          <section>
            <h2>3 · House rules (optional)</h2>
            <textarea
              value={rules}
              placeholder='{"source_document":"…","sections":{"Bitcoin":{"settlement_source":"…"}}}'
              onChange={(e) => setRules(e.target.value)}
              rows={3}
            />
            <p className="hint">
              Without a settlement basis for your book, matches still surface — as{' '}
              <b>possible</b> rather than guaranteed. Supplying one either confirms the hedge or
              reveals that the two venues settle differently.
            </p>
          </section>

          <button className="primary wide big" onClick={onScan} disabled={busy}>
            {busy ? 'Scanning…' : 'Compare against Kalshi'}
          </button>
        </main>
      ) : (
        <main>
          {!result ? (
            <p className="empty">Nothing scanned yet.</p>
          ) : (
            <>
              {result.error && (
                <div className="banner err">Kalshi request failed: {result.error}</div>
              )}

              {(() => {
                const actionable = result.opportunities.filter((o) => arbStatus(o) !== 'NONE');
                const rejected = result.opportunities.filter((o) => arbStatus(o) === 'NONE');
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
                        inputMode="numeric"
                        min="1"
                        step="100"
                        value={bankroll}
                        onChange={(e) => {
                          setBankroll(e.target.value);
                          void persist(STORE_BANKROLL, e.target.value);
                        }}
                      />
                    </div>

                    {shown.length === 0 ? (
                      <p className="empty">
                        <b>No arbitrage right now</b>
                        <br />
                        {rejected.length > 0
                          ? `${rejected.length} pairing${rejected.length === 1 ? '' : 's'} checked and none of them work.`
                          : 'Nothing here prices below its own payout. In an efficient market that is the normal result.'}
                      </p>
                    ) : (
                      shown.map((o) => (
                        <ResultCard
                          key={o.opportunity_id}
                          opportunity={o}
                          bankroll={bankrollDeciCents}
                        />
                      ))
                    )}

                    <div className="showing">
                      <span>
                        Showing {shown.length} of {result.opportunities.length} checked ·{' '}
                        {result.importedMarkets} imported vs {result.kalshiMarkets} Kalshi markets
                      </span>
                      {rejected.length > 0 && (
                        <button onClick={() => setShowRejected(!showRejected)}>
                          {showRejected ? 'Hide' : 'Show'} {rejected.length} rejected
                        </button>
                      )}
                    </div>

                    {result.diagnostics && result.diagnostics.rejected.length > 0 && (
                      <details className="rejects">
                        <summary>
                          {result.diagnostics.imported} rows imported ·{' '}
                          {result.diagnostics.rejected.length} rejected
                        </summary>
                        {result.diagnostics.rejected.map((r, i) => (
                          <div key={i} className="reject">
                            <b>{r.row.market || '(no market name)'}</b>
                            <span>{r.reason}</span>
                          </div>
                        ))}
                      </details>
                    )}
                  </>
                );
              })()}
            </>
          )}
        </main>
      )}
    </div>
  );
}
