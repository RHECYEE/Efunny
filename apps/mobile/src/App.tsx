import { useCallback, useEffect, useRef, useState } from 'react';
import { Preferences } from '@capacitor/preferences';
import { formatEdge, formatMoney, formatPrice } from './format.js';
import { scanOnDevice, type ScanOutput } from './scan.js';

/**
 * Phone UI.
 *
 * The desktop terminal is a dense multi-panel layout that does not survive a
 * phone screen, so this is not a port of it. It does the three things the
 * app is for: take a capture, compare it against Kalshi, and show what came
 * back — with the assurance grade leading, since on a small screen the one
 * thing that must not get lost is how far a number can be trusted.
 */

const STORE_CSV = 'arbterminal.csv';
const STORE_RULES = 'arbterminal.rules';
const STORE_SERIES = 'arbterminal.series';

type Tab = 'IMPORT' | 'RESULTS';

const GRADE_COPY: Record<string, { title: string; body: string; cls: string }> = {
  CERTIFIED: {
    title: 'CERTIFIED',
    body: 'Same contract, same settlement basis, fillable at these prices.',
    cls: 'g-cert',
  },
  QUALIFIED_CANDIDATE: {
    title: '⚠ QUALIFIED — NOT CERTIFIED',
    body:
      'The contracts look complementary and imply an arbitrage, but settlement ' +
      'equivalence could not be verified. A settlement mismatch could break the hedge.',
    cls: 'g-qual',
  },
  DISQUALIFIED: {
    title: '✕ DISQUALIFIED',
    body: 'The venues name different settlement bases. This cannot be a hedge.',
    cls: 'g-dis',
  },
  NOT_PROFITABLE: {
    title: 'NOT PROFITABLE',
    body: 'A spread exists but fees and slippage consume it.',
    cls: 'g-near',
  },
  INFORMATIONAL: {
    title: 'INFORMATIONAL',
    body: 'A price divergence with no hedge available. This position can lose.',
    cls: 'g-info',
  },
};

export function App() {
  const [tab, setTab] = useState<Tab>('IMPORT');
  const [csv, setCsv] = useState('');
  const [csvName, setCsvName] = useState('');
  const [rules, setRules] = useState('');
  const [series, setSeries] = useState('KXBTCMAXY,KXETHMAXY');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanOutput | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Restore the last capture so the app opens where it was left.
  useEffect(() => {
    void (async () => {
      const [c, r, s] = await Promise.all([
        Preferences.get({ key: STORE_CSV }),
        Preferences.get({ key: STORE_RULES }),
        Preferences.get({ key: STORE_SERIES }),
      ]);
      if (c.value) setCsv(c.value);
      if (r.value) setRules(r.value);
      if (s.value) setSeries(s.value);
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
      await Promise.all([persist(STORE_RULES, rules), persist(STORE_SERIES, series)]);
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
          Results{result ? ` (${result.opportunities.length})` : ''}
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
              Without a settlement basis for your book, matches can still surface — they are
              graded <b>unverifiable</b> rather than hidden. Supplying one either confirms the
              hedge or reveals that the venues settle differently.
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

              <div className="stats">
                <div>
                  <b>{result.kalshiMarkets}</b>
                  <span>Kalshi markets</span>
                </div>
                <div>
                  <b>{result.importedMarkets}</b>
                  <span>imported</span>
                </div>
                <div>
                  <b>{result.matches}</b>
                  <span>cross-venue matches</span>
                </div>
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

              {result.opportunities.length === 0 ? (
                <p className="empty">
                  Nothing surfaced. With an efficient market that is the normal result — the
                  scan ran, it just found no divergence worth reporting.
                </p>
              ) : (
                result.opportunities.map((o) => {
                  const grade = GRADE_COPY[o.assurance] ?? GRADE_COPY.INFORMATIONAL!;
                  const open = expanded === o.opportunity_id;
                  return (
                    <article
                      key={o.opportunity_id}
                      className={`card ${grade.cls}`}
                      onClick={() => setExpanded(open ? null : o.opportunity_id)}
                    >
                      <div className="gtitle">{grade.title}</div>
                      <h3>{o.event_title}</h3>

                      <div className="edge">
                        <b>{formatEdge(o.net_edge)}</b>
                        <span>per $1 of payout</span>
                      </div>

                      <div className="legs">
                        {o.legs.map((l, i) => (
                          <div key={i}>
                            <span className="v">{l.venue}</span>
                            <span>
                              {l.side === 'BUY_YES' ? 'YES' : 'NO'} {l.outcome_label}
                            </span>
                            <span className="p">{formatPrice(l.price)}</span>
                            <span className="q">×{Math.round(l.contracts)}</span>
                          </div>
                        ))}
                      </div>

                      <div className="meta">
                        <span>cost {formatPrice(o.unit_cost)}</span>
                        <span>size {o.capacity.toFixed(0)}</span>
                        <span>capital {formatMoney(o.capacity_capital)}</span>
                      </div>

                      {open && (
                        <div className="detail">
                          <p className="gbody">{grade.body}</p>

                          {o.settlement && (
                            <table>
                              <tbody>
                                <tr>
                                  <td>{o.venues[0]}</td>
                                  <td>{o.settlement.left_source}</td>
                                </tr>
                                <tr>
                                  <td>{o.venues[1]}</td>
                                  <td>{o.settlement.right_source}</td>
                                </tr>
                                <tr>
                                  <td>Equivalence</td>
                                  <td className={`s-${o.settlement.assurance}`}>
                                    {o.settlement.assurance}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          )}

                          {o.settlement && o.settlement.assurance !== 'CONFIRMED' && (
                            <table>
                              <tbody>
                                <tr>
                                  <td>Edge if bases match</td>
                                  <td className="pos">
                                    {formatEdge(o.edge_if_settlement_equivalent)}
                                  </td>
                                </tr>
                                <tr>
                                  <td>Worst case if not</td>
                                  <td className="neg">
                                    {formatMoney(o.worst_case_if_settlement_differs)}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          )}

                          <div className="stack">
                            {o.cost_stack.map((c) => (
                              <div key={c.label}>
                                <span>{c.label}</span>
                                <span className={c.amount < 0 ? 'neg' : 'pos'}>
                                  {formatEdge(c.amount)}
                                </span>
                              </div>
                            ))}
                          </div>

                          {o.warnings.map((w) => (
                            <p key={w} className="warn">
                              ⚠ {w}
                            </p>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })
              )}
            </>
          )}
        </main>
      )}
    </div>
  );
}
