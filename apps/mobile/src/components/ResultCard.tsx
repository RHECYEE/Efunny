import { useState } from 'react';
import { allocate, arbStatus, explainNoArbitrage, type Opportunity } from '@arbterminal/core';
import { formatMoney, formatPrice } from '../format.js';

/**
 * One result on a phone.
 *
 * Same three questions as the desktop card — is there an arbitrage, how much
 * goes in, what comes back — with even less room to hide anything else. The
 * cost stack, the settlement table and the warning list that used to fill this
 * card are all still computed; they simply are not what somebody standing in
 * front of a bet slip needs to read.
 */

interface Props {
  opportunity: Opportunity;
  /** Money the user is willing to deploy, in deci-cents. */
  bankroll: number;
}

export function ResultCard({ opportunity, bankroll }: Props) {
  const [open, setOpen] = useState(false);
  const status = arbStatus(opportunity);
  const allocation = allocate(opportunity, bankroll);

  if (status === 'NONE') {
    return (
      <article className="card none">
        <div className="verdict">✕ NO ARBITRAGE</div>
        <h3>{opportunity.event_title}</h3>
        <p className="plain">{explainNoArbitrage(opportunity)}</p>
      </article>
    );
  }

  const possible = status === 'POSSIBLE';

  return (
    <article className={`card ${possible ? 'possible' : 'found'}`}>
      <div className="verdict">{possible ? '⚠ POSSIBLE ARBITRAGE' : '✓ ARBITRAGE FOUND'}</div>
      <h3>{opportunity.event_title}</h3>

      {allocation.ok ? (
        <>
          <dl className="figures">
            <div>
              <dt>Put in</dt>
              <dd>{formatMoney(allocation.total_stake)}</dd>
            </div>
            {!possible && (
              <div>
                <dt>Guaranteed return</dt>
                <dd>{formatMoney(allocation.guaranteed_return)}</dd>
              </div>
            )}
            <div className="headline">
              <dt>{possible ? 'Possible profit' : 'Guaranteed profit'}</dt>
              <dd>{formatMoney(allocation.guaranteed_profit)}</dd>
            </div>
            <div>
              <dt>Return</dt>
              <dd>{(allocation.return_fraction * 100).toFixed(1)}%</dd>
            </div>
          </dl>

          {allocation.capped_by_liquidity && (
            <p className="plain">
              Limited to {formatMoney(allocation.total_stake)} — that is all the size available at
              these prices.
            </p>
          )}
        </>
      ) : (
        <p className="plain">{allocation.reason}</p>
      )}

      {possible && (
        <p className="caution">
          ⚠ We cannot guarantee this one because{' '}
          {opportunity.settlement?.unverified_venue ?? 'one venue'} doesn’t publish enough
          settlement information.
        </p>
      )}

      {allocation.ok && (
        <button className="wide" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show me how'}
        </button>
      )}

      {open && allocation.ok && (
        <div className="how">
          {allocation.legs.map((leg, index) => (
            <div className="position" key={index}>
              <div className="venue">{leg.venue}</div>
              <div className="what">
                {leg.action} · {leg.outcome_label}
              </div>
              <div className="amount">{formatMoney(leg.stake)}</div>
              <div className="fine">
                {leg.contracts.toLocaleString()} @ {formatPrice(leg.price)}
              </div>
            </div>
          ))}
          <div className="totals">
            <div>
              <span>Total</span>
              <span>{formatMoney(allocation.total_stake)}</span>
            </div>
            <div>
              <span>{possible ? 'Return if they agree' : 'Guaranteed return'}</span>
              <span>{formatMoney(allocation.guaranteed_return)}</span>
            </div>
            <div className="big">
              <span>{possible ? 'Possible profit' : 'Guaranteed profit'}</span>
              <span>{formatMoney(allocation.guaranteed_profit)}</span>
            </div>
          </div>

          {possible && (
            <p className="plain">
              {opportunity.settlement?.reason ??
                'One venue does not publish the source it settles against.'}{' '}
              If the two sources disagree when this settles, both positions can lose, and the
              whole {formatMoney(allocation.total_stake)} is at risk.
            </p>
          )}
        </div>
      )}
    </article>
  );
}
