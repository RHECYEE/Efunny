import { useEffect, useState } from 'react';
import type { CartSummary, Opportunity } from '@arbterminal/core';
import { api } from '../api.js';
import { edgeClass, formatEdge, formatMoney, formatRoi, typeLabel } from '../format.js';

export interface CartEntry {
  opportunity_id: string;
  units: number;
}

interface Props {
  entries: CartEntry[];
  opportunities: Opportunity[];
  onSetUnits: (opportunityId: string, units: number) => void;
  onRemove: (opportunityId: string) => void;
  onClear: () => void;
}

/**
 * The arbitrage cart: a hypothetical portfolio across several opportunities,
 * priced by the same core function the server uses, so the aggregate numbers
 * cannot drift from the per-card ones.
 */
export function Cart({ entries, opportunities, onSetUnits, onRemove, onClear }: Props) {
  const [summary, setSummary] = useState<CartSummary | null>(null);

  useEffect(() => {
    if (entries.length === 0) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    api
      .cartSummary(entries)
      .then((response) => {
        if (!cancelled) setSummary(response.summary);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const byId = new Map(opportunities.map((o) => [o.opportunity_id, o]));
  const allHedged = summary !== null && summary.speculative_entries === 0;

  return (
    <div className="cart-rail">
      <div className="section-title">
        <div className="row between">
          <span>Arbitrage cart</span>
          {entries.length > 0 && (
            <button className="ghost" style={{ padding: '0 6px' }} onClick={onClear}>
              clear
            </button>
          )}
        </div>
      </div>

      {entries.length === 0 && (
        <div className="empty" style={{ padding: '24px 14px' }}>
          <strong>Cart is empty</strong>
          Add opportunities to model a portfolio: aggregate capital, modeled profit and return on
          deployed capital.
        </div>
      )}

      {entries.map((entry) => {
        const opportunity = byId.get(entry.opportunity_id);
        if (!opportunity) {
          return (
            <div className="cart-entry" key={entry.opportunity_id}>
              <div className="t warn">Opportunity no longer live</div>
              <div className="dim">
                It was repriced or withdrawn since you added it, so it is excluded from the totals.
              </div>
              <button className="ghost" onClick={() => onRemove(entry.opportunity_id)}>
                remove
              </button>
            </div>
          );
        }
        return (
          <div className="cart-entry" key={entry.opportunity_id}>
            <div className="t">{opportunity.event_title}</div>
            <div className="row between" style={{ marginTop: 2 }}>
              <span className={`pill ${opportunity.type}`}>{typeLabel(opportunity.type)}</span>
              <span className={`num ${edgeClass(opportunity.net_edge)}`}>
                {formatEdge(opportunity.net_edge)}
              </span>
            </div>
            <div className="row" style={{ marginTop: 4, gap: 5 }}>
              <input
                type="number"
                min="0"
                step="1"
                max={opportunity.capacity}
                value={entry.units}
                onChange={(e) => onSetUnits(entry.opportunity_id, Number(e.target.value))}
                style={{ width: 78 }}
              />
              <span className="dim">/ {opportunity.capacity.toFixed(0)} units</span>
              <button
                className="ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => onRemove(entry.opportunity_id)}
              >
                ✕
              </button>
            </div>
            <div className="dim num">
              {formatMoney(opportunity.unit_cost * entry.units)} capital ·{' '}
              {formatMoney(opportunity.net_edge * entry.units)} modeled
            </div>
          </div>
        );
      })}

      {summary && (
        <>
          <div className="section-title">Portfolio</div>
          <div className="summary-line num">
            <span className="muted">Entries</span>
            <span>
              {summary.entries} ({summary.guaranteed_entries} hedged)
            </span>
          </div>
          <div className="summary-line num">
            <span className="muted">Capital required</span>
            <span>{formatMoney(summary.capital_required)}</span>
          </div>
          <div className="summary-line num">
            <span className="muted">Worst case</span>
            <span className={edgeClass(summary.worst_case_pl)}>
              {formatMoney(summary.worst_case_pl)}
            </span>
          </div>
          <div className="summary-line num">
            <span className="muted">Lowest match confidence</span>
            <span>{(summary.lowest_match_confidence * 100).toFixed(0)}%</span>
          </div>
          {/* Green "profit" is only honest when every entry is hedged. With a
              speculative entry in the cart the figure is a modeled outcome
              that can fully reverse, so it is neither labelled nor coloured
              as profit. */}
          <div className="summary-line big num">
            <span>{allHedged ? 'Modeled profit' : 'Modeled result'}</span>
            <span className={allHedged ? edgeClass(summary.modeled_profit) : 'muted'}>
              {formatMoney(summary.modeled_profit)}
            </span>
          </div>
          <div className="summary-line num">
            <span className="muted">
              {allHedged ? 'Return on deployed capital' : 'Modeled return, not guaranteed'}
            </span>
            <span className={allHedged ? edgeClass(summary.modeled_profit) : 'muted'}>
              {formatRoi(summary.return_on_deployed_capital)}
            </span>
          </div>

          {summary.warnings.length > 0 && (
            <div className="warnbox" style={{ margin: '8px 10px' }}>
              {summary.warnings.map((warning) => (
                <div key={warning}>⚠ {warning}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
