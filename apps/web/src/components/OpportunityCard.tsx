import type { Opportunity } from '@arbterminal/core';
import {
  confidenceClass,
  gradeLabel,
  headlineEdgeClass,
  isHedged,
  settlementLabel,
  formatAge,
  formatCountdown,
  formatEdge,
  formatMoney,
  formatPrice,
  formatRoi,
  formatSize,
  typeLabel,
} from '../format.js';

interface Props {
  opportunity: Opportunity;
  selected: boolean;
  inCart: boolean;
  onSelect: () => void;
  onPaperTrade: () => void;
  onToggleCart: () => void;
}

/**
 * One opportunity, at list density.
 *
 * The executable edge is the only large number on the card. The raw edge sits
 * above it in muted text, so the difference between "the spread" and "what
 * you would actually keep" is visible without opening anything.
 */
export function OpportunityCard({
  opportunity,
  selected,
  inCart,
  onSelect,
  onPaperTrade,
  onToggleCart,
}: Props) {
  const review = opportunity.match_confidence < 0.95;
  const hedged = isHedged(opportunity.type);

  return (
    <div
      className={`card${selected ? ' selected' : ''}${review ? ' review' : ''}`}
      onClick={onSelect}
    >
      <div>
        <div className="card-title">{opportunity.event_title}</div>

        <div className="card-meta">
          <span className={`pill ${opportunity.type}`}>{typeLabel(opportunity.type)}</span>
          {/* The grade is what governs how far to trust this, so it leads.
              The confidence number now answers one question only — whether
              the two legs are the same proposition. */}
          <span className={`grade-pill grade-${opportunity.assurance}`}>
            {gradeLabel(opportunity.assurance)}
          </span>
          <span className={`conf ${confidenceClass(opportunity.match_confidence)}`}>
            contract {(opportunity.match_confidence * 100).toFixed(0)}%
          </span>
          {opportunity.settlement && (
            <span
              className={
                opportunity.settlement.assurance === 'CONFIRMED'
                  ? 'pos'
                  : opportunity.settlement.assurance === 'CONFLICT'
                    ? 'neg'
                    : 'warn'
              }
              style={{ fontSize: 10 }}
            >
              {settlementLabel(opportunity.settlement.assurance)}
            </span>
          )}
          <span className="dim">{opportunity.venues.join(' + ')}</span>
          <span className="dim">
            depth {formatSize(Math.min(...opportunity.legs.map((l) => l.depth_available)))}
          </span>
          <span className={opportunity.quote_age_ms > 60_000 ? 'warn' : 'dim'}>
            quote {formatAge(opportunity.quote_age_ms)}
          </span>
          <span className="dim">settles {formatCountdown(opportunity.time_to_settlement_ms)}</span>
        </div>

        <div className="legs">
          {opportunity.legs.map((leg, index) => (
            <div className="leg num" key={`${leg.market_id}-${leg.side}-${index}`}>
              <span className="venue">{leg.venue}</span>
              <span className="label">
                {leg.side === 'BUY_YES' ? 'YES' : 'NO'} · {leg.outcome_label}
              </span>
              <span className="r">{formatPrice(leg.price)}</span>
              <span className="dim">{(leg.price / 10).toFixed(1)}% impl</span>
              <span className="dim">
                ×{formatSize(leg.contracts)} / {formatSize(leg.depth_available)}
              </span>
            </div>
          ))}
        </div>

        {opportunity.warnings.length > 0 && (
          <div className="warn" style={{ marginTop: 4, fontSize: 10 }}>
            ⚠ {opportunity.warnings[0]}
            {opportunity.warnings.length > 1 && ` (+${opportunity.warnings.length - 1} more)`}
          </div>
        )}
      </div>

      <div className="edge-block num">
        <div className="raw">
          raw {formatEdge(opportunity.gross_edge)} · cost{' '}
          {formatPrice(opportunity.unit_cost)}
        </div>
        <div className={`executable ${headlineEdgeClass(opportunity.type, opportunity.net_edge)}`}>
          {formatEdge(opportunity.net_edge)}
        </div>
        <div className="sub">
          {hedged ? (
            <>executable edge / $1 · {formatRoi(opportunity.net_roi)} ROI</>
          ) : (
            'price divergence, no hedge available'
          )}
        </div>
        <div className="sub">
          max {opportunity.capacity.toFixed(0)} units ·{' '}
          {hedged ? (
            <>{formatMoney(opportunity.capacity_capital)} capital</>
          ) : (
            <>{formatMoney(opportunity.capacity_capital)} at risk</>
          )}
        </div>

        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="ghost" onClick={onToggleCart}>
            {inCart ? '− cart' : '+ cart'}
          </button>
          <button onClick={onSelect}>Analyze</button>
          <button className="primary" onClick={onPaperTrade}>
            Paper trade
          </button>
        </div>
      </div>
    </div>
  );
}
