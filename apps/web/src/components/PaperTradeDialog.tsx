import { useState } from 'react';
import type { Opportunity, PaperTrade } from '@arbterminal/core';
import { api } from '../api.js';
import {
  dollarsToDeciCents,
  edgeClass,
  formatEdge,
  formatMoney,
  formatPrice,
  formatSize,
} from '../format.js';

interface Props {
  opportunity: Opportunity;
  onClose: () => void;
  onExecuted: (trade: PaperTrade) => void;
}

const SHORTFALL_LABEL: Record<string, string> = {
  PRICE_MOVED: 'Price moved',
  INSUFFICIENT_SIZE_AT_QUOTE: 'Not enough size at the quote',
  LEVEL_DISAPPEARED: 'Level disappeared',
  MARKET_CLOSED: 'Market closed',
};

/**
 * Paper trading.
 *
 * On execute the server re-fetches the live book, so the result compares the
 * edge the card advertised against the edge that was actually obtainable a
 * moment later — and says which leg cost what.
 */
export function PaperTradeDialog({ opportunity, onClose, onExecuted }: Props) {
  const suggested = Math.min(
    Math.round(opportunity.capacity_capital / 1000),
    1000,
  );
  const [bankroll, setBankroll] = useState<string>(String(Math.max(suggested, 1)));
  const [busy, setBusy] = useState(false);
  const [trade, setTrade] = useState<PaperTrade | null>(null);
  const [refetched, setRefetched] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function execute() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.paperTrade(
        opportunity.opportunity_id,
        dollarsToDeciCents(Number(bankroll)),
      );
      setTrade(response.trade);
      setRefetched(response.execution_quotes_refetched);
      onExecuted(response.trade);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hedgeable =
    opportunity.type === 'GUARANTEED_ARB' || opportunity.type === 'CROSS_VENUE_ARB';

  const captured =
    trade && trade.displayed_edge !== 0
      ? Math.max(0, Math.min(1, trade.actually_fillable_edge / trade.displayed_edge))
      : 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Paper trade — no order is placed anywhere</strong>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div style={{ color: '#fff', marginBottom: 6 }}>{opportunity.event_title}</div>

          {!trade ? (
            <>
              <table className="num">
                <tbody>
                  <tr>
                    <td className="muted">Displayed executable edge</td>
                    <td className={`r ${edgeClass(opportunity.net_edge)}`}>
                      {formatEdge(opportunity.net_edge)}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Cost per $1 of payout</td>
                    <td className="r">{formatPrice(opportunity.unit_cost)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Capacity</td>
                    <td className="r">
                      {opportunity.capacity.toFixed(2)} units ·{' '}
                      {formatMoney(opportunity.capacity_capital)}
                    </td>
                  </tr>
                </tbody>
              </table>

              <div className="field" style={{ padding: '8px 0 0' }}>
                <label>Bankroll to deploy (USD)</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={bankroll}
                  onChange={(e) => setBankroll(e.target.value)}
                />
                <div className="hint">
                  The book is re-fetched at execution and the position is scaled to whichever leg
                  fills worst, so a broken hedge is never reported as complete.
                </div>
              </div>

              {error && <div className="banner err" style={{ marginTop: 8 }}>{error}</div>}
            </>
          ) : (
            <>
              {!refetched && (
                <div className="banner">
                  The venue could not be re-queried, so this fill was priced against the cached
                  book. Treat the decay figure as a lower bound.
                </div>
              )}

              <table className="num">
                <tbody>
                  <tr>
                    <td className="muted">Displayed edge</td>
                    <td className="r">{formatEdge(trade.displayed_edge)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Actually fillable edge</td>
                    <td className={`r ${edgeClass(trade.actually_fillable_edge)}`}>
                      {formatEdge(trade.actually_fillable_edge)}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <strong>Edge decay</strong>
                    </td>
                    <td className={`r ${trade.edge_decay > 0 ? 'neg' : 'pos'}`}>
                      <strong>{formatEdge(-trade.edge_decay)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>

              <div className="decay-bar">
                <span style={{ width: `${captured * 100}%` }} />
              </div>
              <div className="dim">
                {(captured * 100).toFixed(0)}% of the displayed edge was really there.
              </div>

              <div style={{ marginTop: 8 }}>{trade.decay_explanation}</div>

              <h3 style={{ marginTop: 12, fontSize: 10, letterSpacing: '0.13em', color: '#55647a' }}>
                SIMULATED FILLS
              </h3>
              <table className="num">
                <thead>
                  <tr>
                    <th>Leg</th>
                    <th className="r">Shown</th>
                    <th className="r">Filled at</th>
                    <th className="r">Req / fill</th>
                    <th>Why short</th>
                  </tr>
                </thead>
                <tbody>
                  {trade.simulated_fills.map((fill, index) => (
                    <tr key={`${fill.market_id}-${index}`}>
                      <td>
                        {fill.venue} {fill.side === 'BUY_YES' ? 'YES' : 'NO'}
                      </td>
                      <td className="r">{formatPrice(fill.displayed_price)}</td>
                      <td
                        className={`r ${
                          fill.fill_vwap > fill.displayed_price ? 'neg' : 'pos'
                        }`}
                      >
                        {formatPrice(Math.round(fill.fill_vwap))}
                      </td>
                      <td className="r dim">
                        {formatSize(fill.requested_contracts)} / {formatSize(fill.filled_contracts)}
                      </td>
                      <td className="dim">
                        {fill.shortfall_reason
                          ? SHORTFALL_LABEL[fill.shortfall_reason] ?? fill.shortfall_reason
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <table className="num" style={{ marginTop: 8 }}>
                <tbody>
                  <tr>
                    <td className="muted">Units executed</td>
                    <td className="r">{trade.units_executed.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Capital deployed</td>
                    <td className="r">{formatMoney(trade.capital_deployed)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Guaranteed payout</td>
                    <td className="r">{formatMoney(trade.guaranteed_payout)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Hedged</td>
                    <td className={`r ${trade.fully_hedged ? 'pos' : 'warn'}`}>
                      {trade.fully_hedged
                        ? 'yes — both branches pay the same'
                        : hedgeable
                          ? 'no — a leg fell short, so the position was scaled down'
                          : 'no — this is a directional view, not a hedge'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="modal-foot">
          {!trade ? (
            <>
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" onClick={execute} disabled={busy || Number(bankroll) <= 0}>
                {busy ? 'Re-fetching book…' : 'Simulate fill'}
              </button>
            </>
          ) : (
            <button className="primary" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
