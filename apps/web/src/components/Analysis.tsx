import { useEffect, useState } from 'react';
import type { Opportunity } from '@arbterminal/core';
import { api, type AnalysisResponse, type QuoteHistoryPoint } from '../api.js';
import {
  edgeClass,
  edgeLabel,
  headlineEdgeClass,
  isHedged,
  formatAge,
  formatCountdown,
  formatEdge,
  formatMoney,
  formatPercent,
  formatPrice,
  formatRoi,
  formatSize,
  typeLabel,
} from '../format.js';
import { AssurancePanel } from './AssurancePanel.js';
import { SettlementChecklist } from './SettlementChecklist.js';

interface Props {
  opportunity: Opportunity;
  onClose: () => void;
  onPaperTrade: () => void;
}

/** Sparkline over a price series. Inline SVG — no charting dependency. */
function Sparkline({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) {
    return <div className="dim">Not enough history logged yet.</div>;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 100 - ((value - min) / span) * 100;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg className="spark" viewBox="0 0 100 100" preserveAspectRatio="none">
      <path d={path} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Analysis({ opportunity, onClose, onPaperTrade }: Props) {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .analysis(opportunity.opportunity_id)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [opportunity.opportunity_id]);

  const executable = opportunity.net_edge;
  const hedged = isHedged(opportunity.type);

  return (
    <div className="analysis">
      <div className="analysis-head">
        <span className={`pill ${opportunity.type}`}>{typeLabel(opportunity.type)}</span>
        <strong style={{ color: '#fff' }}>{opportunity.event_title}</strong>
        <span className="dim">{opportunity.event_id}</span>
        <div style={{ marginLeft: 'auto' }} className="row">
          <button className="primary" onClick={onPaperTrade}>
            Paper trade
          </button>
          <button className="ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>
      </div>

      {error && <div className="banner err">Could not load analysis: {error}</div>}

      <div className="analysis-grid">
        {/* ---------------- assurance ---------------- */}
        <AssurancePanel opportunity={opportunity} />

        {/* ---------------- venue prices ---------------- */}
        <div className="panel">
          <h3>Venue prices &amp; implied probability</h3>
          <div className="tablewrap">
            <table className="num">
              <thead>
                <tr>
                  <th>Leg</th>
                  <th className="r">Price</th>
                  <th className="r">Impl</th>
                  <th className="r">VWAP</th>
                  <th className="r">Depth</th>
                </tr>
              </thead>
              <tbody>
                {opportunity.legs.map((leg, index) => (
                  <tr key={`${leg.market_id}-${index}`}>
                    <td className="trunc">
                      <span className="dim">{leg.venue}</span>{' '}
                      {leg.side === 'BUY_YES' ? 'YES' : 'NO'} {leg.outcome_label}
                    </td>
                    <td className="r">{formatPrice(leg.price)}</td>
                    <td className="r">{formatPercent(leg.price / 1000)}</td>
                    <td className="r">{formatPrice(Math.round(leg.vwap))}</td>
                    <td className="r">{formatSize(leg.depth_available)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Combined cost per $1 payout</strong>
                  </td>
                  <td className="r" colSpan={4}>
                    <strong>{formatPrice(opportunity.unit_cost)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="row between" style={{ marginTop: 7 }}>
            <span className="muted">Consensus probability</span>
            <span className="num">
              {data?.consensus_probability !== null && data?.consensus_probability !== undefined
                ? formatPercent(data.consensus_probability)
                : '—'}
            </span>
          </div>
          <div className="row between">
            <span className="muted">Quote age / staleness</span>
            <span className={opportunity.quote_age_ms > 60_000 ? 'warn num' : 'num'}>
              {formatAge(opportunity.quote_age_ms)}
            </span>
          </div>
          <div className="row between">
            <span className="muted">Time to settlement</span>
            <span className="num">{formatCountdown(opportunity.time_to_settlement_ms)}</span>
          </div>
          <div className="row between">
            <span className="muted">Match confidence</span>
            <span className="num">{formatPercent(opportunity.match_confidence, 0)}</span>
          </div>
        </div>

        {/* ---------------- cost stack ---------------- */}
        <div className="panel">
          <h3>Arbitrage before &amp; after costs</h3>
          {opportunity.cost_stack.map((entry) => (
            <div className="stack-row" key={entry.label}>
              <span>{entry.label}</span>
              <span className={`r num ${edgeClass(entry.amount)}`} style={{ textAlign: 'right' }}>
                {formatEdge(entry.amount)}
              </span>
              <span className="detail">{entry.detail}</span>
            </div>
          ))}
          <div className="stack-row total">
            <span>{edgeLabel(opportunity.type)}</span>
            <span
              className={`num ${headlineEdgeClass(opportunity.type, executable)}`}
              style={{ textAlign: 'right' }}
            >
              {formatEdge(executable)}
            </span>
          </div>

          <table className="num" style={{ marginTop: 9 }}>
            <tbody>
              {/* ROI and modeled profit only mean anything for a position with
                  a guaranteed payoff. Showing them against an unhedged view
                  would present a directional bet as banked money. */}
              {hedged ? (
                <>
                  <tr>
                    <td className="muted">Gross ROI</td>
                    <td className="r">{formatRoi(opportunity.gross_roi)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Net ROI on capital</td>
                    <td className={`r ${edgeClass(opportunity.net_edge)}`}>
                      {formatRoi(opportunity.net_roi)}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Max arb size</td>
                    <td className="r">{opportunity.capacity.toFixed(0)} units</td>
                  </tr>
                  <tr>
                    <td className="muted">Capital at max</td>
                    <td className="r">{formatMoney(opportunity.capacity_capital)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Guaranteed profit</td>
                    <td className={`r ${edgeClass(opportunity.net_edge)}`}>
                      {formatMoney(opportunity.net_edge * opportunity.capacity)}
                    </td>
                  </tr>
                </>
              ) : (
                <>
                  <tr>
                    <td className="muted">Max size</td>
                    <td className="r">{opportunity.capacity.toFixed(0)} units</td>
                  </tr>
                  <tr>
                    <td className="muted">Capital at risk</td>
                    <td className="r neg">{formatMoney(opportunity.capacity_capital)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Worst case (expires worthless)</td>
                    <td className="r neg">
                      −{formatMoney(opportunity.capacity_capital)}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>

          {opportunity.warnings.length > 0 && (
            <div className="warnbox">
              {opportunity.warnings.map((warning) => (
                <div key={warning}>⚠ {warning}</div>
              ))}
            </div>
          )}
        </div>

        {/* ---------------- market depth ---------------- */}
        <div className="panel">
          <h3>Market depth</h3>
          {data ? (
            data.quotes.map((quote) => {
              const leg = opportunity.legs.find((l) => l.market_id === quote.market_id);
              const ladder = leg?.side === 'BUY_NO' ? quote.book.no_asks : quote.book.yes_asks;
              return (
                <div key={quote.market_id} style={{ marginBottom: 9 }}>
                  <div className="row between">
                    <span className="muted">
                      {leg?.side === 'BUY_NO' ? 'NO' : 'YES'} ask ladder ·{' '}
                      {leg?.outcome_label ?? quote.market_id}
                    </span>
                    <span className="dim">{ladder.length} levels</span>
                  </div>
                  <table className="num">
                    <thead>
                      <tr>
                        <th className="r">Price</th>
                        <th className="r">Size</th>
                        <th className="r">Cumulative</th>
                        <th className="r">Cum. cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ladder.slice(0, 8).map((level, index, all) => {
                        const cumulative = all
                          .slice(0, index + 1)
                          .reduce((sum, l) => sum + l.size, 0);
                        const cost = all
                          .slice(0, index + 1)
                          .reduce((sum, l) => sum + l.size * l.price, 0);
                        return (
                          <tr key={`${level.price}-${index}`}>
                            <td className="r">{formatPrice(level.price)}</td>
                            <td className="r">{formatSize(level.size)}</td>
                            <td className="r dim">{formatSize(cumulative)}</td>
                            <td className="r dim">{formatMoney(cost)}</td>
                          </tr>
                        );
                      })}
                      {ladder.length === 0 && (
                        <tr>
                          <td colSpan={4} className="dim">
                            No resting liquidity on this side.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              );
            })
          ) : (
            <div className="dim">Loading depth…</div>
          )}
        </div>

        {/* ---------------- settlement ---------------- */}
        <SettlementChecklist
          diff={opportunity.settlement_diff}
          matches={data?.matches ?? []}
        />

        {/* ---------------- history ---------------- */}
        <div className="panel">
          <h3>Price history</h3>
          {data ? (
            Object.entries(data.price_history).map(([marketId, history]) => {
              const series = (history as QuoteHistoryPoint[])
                .map((point) => point.ask)
                .filter((value): value is number => value !== null);
              return (
                <div key={marketId} style={{ marginBottom: 10 }}>
                  <div className="row between">
                    <span className="muted">{marketId}</span>
                    <span className="dim">{series.length} logged quotes</span>
                  </div>
                  <Sparkline points={series} color="#4aa8ff" />
                </div>
              );
            })
          ) : (
            <div className="dim">Loading history…</div>
          )}

          <h3 style={{ marginTop: 10 }}>Edge history</h3>
          {data && data.edge_history.length > 1 ? (
            <>
              <Sparkline points={data.edge_history.map((e) => e.net_edge)} color="#35d07f" />
              <div className="dim">
                {data.edge_history.length} observations · latest{' '}
                {formatEdge(data.edge_history[data.edge_history.length - 1]!.net_edge)}
              </div>
            </>
          ) : (
            <div className="dim">
              This opportunity has been seen once. History accumulates each polling cycle.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
