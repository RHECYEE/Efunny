import { useEffect, useState } from 'react';
import type { PaperTrade } from '@arbterminal/core';
import { api } from '../api.js';
import { edgeClass, formatEdge, formatMoney, formatPrice, typeLabel } from '../format.js';

interface Stats {
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
}

const CAUSE_LABEL: Record<string, string> = {
  PRICE_MOVED: 'Price moved',
  INSUFFICIENT_SIZE_AT_QUOTE: 'Not enough size at the quote',
  LEVEL_DISAPPEARED: 'Level disappeared',
  MARKET_CLOSED: 'Market closed',
};

/**
 * Paper portfolio and history.
 *
 * The headline metric is edge capture: what fraction of the edge this
 * terminal advertised was actually obtainable when it came time to fill.
 */
export function Portfolio({ refreshKey }: { refreshKey: number }) {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .trades()
      .then((response) => {
        if (cancelled) return;
        setTrades(response.trades);
        setStats(response.stats);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (error) return <div className="banner err">Could not load history: {error}</div>;

  if (trades.length === 0) {
    return (
      <div className="empty">
        <strong>No paper trades yet</strong>
        Simulate a fill on any opportunity. Each one records the book at detection and again at
        execution, then reports how much of the displayed edge was really there.
      </div>
    );
  }

  return (
    <>
      {stats && (
        <div className="analysis-grid" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="panel">
            <h3>Edge capture</h3>
            <div style={{ fontSize: 26, fontWeight: 700 }} className={edgeClass(1)}>
              {(stats.edge_capture_rate * 100).toFixed(1)}%
            </div>
            <div className="muted">
              of displayed edge was actually fillable across {stats.trades} simulated trades
            </div>
            <div className="decay-bar" style={{ marginTop: 8 }}>
              <span style={{ width: `${Math.max(0, Math.min(1, stats.edge_capture_rate)) * 100}%` }} />
            </div>
            <table className="num" style={{ marginTop: 8 }}>
              <tbody>
                <tr>
                  <td className="muted">Mean displayed edge</td>
                  <td className="r">{formatEdge(stats.mean_displayed_edge)}</td>
                </tr>
                <tr>
                  <td className="muted">Mean fillable edge</td>
                  <td className="r">{formatEdge(stats.mean_fillable_edge)}</td>
                </tr>
                <tr>
                  <td className="muted">Fully hedged</td>
                  <td className="r">{(stats.fully_hedged_rate * 100).toFixed(0)}%</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Why edge decayed</h3>
            {Object.keys(stats.shortfall_causes).length === 0 ? (
              <div className="muted">No leg has fallen short of its quote yet.</div>
            ) : (
              <table className="num">
                <tbody>
                  {Object.entries(stats.shortfall_causes)
                    .sort((a, b) => b[1] - a[1])
                    .map(([cause, count]) => (
                      <tr key={cause}>
                        <td>{CAUSE_LABEL[cause] ?? cause}</td>
                        <td className="r">{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h3>Position summary</h3>
            <table className="num">
              <tbody>
                <tr>
                  <td className="muted">Trades</td>
                  <td className="r">{stats.trades}</td>
                </tr>
                <tr>
                  <td className="muted">Open / resolved</td>
                  <td className="r">
                    {stats.open} / {stats.resolved}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Capital deployed</td>
                  <td className="r">{formatMoney(stats.capital_deployed)}</td>
                </tr>
                <tr>
                  <td className="muted">Realized P/L</td>
                  <td className={`r ${edgeClass(stats.realized_pl)}`}>
                    {formatMoney(stats.realized_pl)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {trades.map((trade) => {
        const captured =
          trade.displayed_edge !== 0
            ? Math.max(0, Math.min(1, trade.actually_fillable_edge / trade.displayed_edge))
            : 0;
        return (
          <div className="trade" key={trade.trade_id}>
            <div className="row between">
              <span style={{ color: '#fff' }}>{trade.event_title}</span>
              <span className={`pill ${trade.opportunity_type}`}>
                {typeLabel(trade.opportunity_type)}
              </span>
            </div>

            <div className="row" style={{ gap: 16, marginTop: 3 }}>
              <span className="num">
                <span className="muted">displayed </span>
                {formatEdge(trade.displayed_edge)}
              </span>
              <span className="num">
                <span className="muted">fillable </span>
                <span className={edgeClass(trade.actually_fillable_edge)}>
                  {formatEdge(trade.actually_fillable_edge)}
                </span>
              </span>
              <span className="num">
                <span className="muted">decay </span>
                <span className={trade.edge_decay > 0 ? 'neg' : 'pos'}>
                  {formatEdge(-trade.edge_decay)}
                </span>
              </span>
              <span className="num muted">
                {trade.units_executed.toFixed(0)} units ·{' '}
                {formatMoney(trade.capital_deployed)}
              </span>
              <span className={trade.fully_hedged ? 'pos' : 'warn'}>
                {/* An unhedged type was never going to be hedged; only a
                    hedgeable one that fell short is "partial". */}
                {trade.fully_hedged
                  ? 'hedged'
                  : trade.opportunity_type === 'RELATIVE_VALUE' ||
                      trade.opportunity_type === 'NEAR_ARB'
                    ? 'unhedged'
                    : 'partial'}
              </span>
              <span className="muted" style={{ marginLeft: 'auto' }}>
                {trade.resolution}
                {trade.realized_pl !== null && (
                  <span className={edgeClass(trade.realized_pl)}>
                    {' '}
                    {formatMoney(trade.realized_pl)}
                  </span>
                )}
              </span>
            </div>

            <div className="decay-bar">
              <span style={{ width: `${captured * 100}%` }} />
            </div>
            <div className="dim">{trade.decay_explanation}</div>

            <div style={{ marginTop: 4 }}>
              {trade.simulated_fills.map((fill, index) => (
                <div className="leg num" key={`${fill.market_id}-${index}`}>
                  <span className="venue">{fill.venue}</span>
                  <span className="label">
                    {fill.side === 'BUY_YES' ? 'YES' : 'NO'} {fill.market_id.split(':')[1]}
                  </span>
                  <span className="r">{formatPrice(fill.displayed_price)}</span>
                  <span className={`r ${fill.fill_vwap > fill.displayed_price ? 'neg' : 'pos'}`}>
                    {formatPrice(Math.round(fill.fill_vwap))}
                  </span>
                  <span className="dim">
                    {fill.shortfall_reason ? CAUSE_LABEL[fill.shortfall_reason] : 'filled'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
