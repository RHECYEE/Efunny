import { useState } from 'react';
import { allocate, arbStatus, explainNoArbitrage, type Opportunity } from '@arbterminal/core';
import { formatMoney, formatPrice } from '../format.js';

/**
 * One opportunity, answering three questions and nothing else.
 *
 *   1. Is there an arbitrage?
 *   2. How much can I put in?
 *   3. What is the guaranteed profit?
 *
 * The engine knows a great deal more — raw edge, match confidence, modelled
 * slippage, settlement assurance, the reserve — and every one of those earns
 * its keep inside the engine. None of them change what somebody does next, so
 * they live behind Details rather than on the card. Exposing them here was
 * showing the working instead of the answer.
 */

interface Props {
  opportunity: Opportunity;
  /** Money the user is willing to deploy, in deci-cents. */
  bankroll: number;
  onDetails: () => void;
}

export function ResultCard({ opportunity, bankroll, onDetails }: Props) {
  const [showHow, setShowHow] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const status = arbStatus(opportunity);
  const allocation = allocate(opportunity, bankroll);

  if (status === 'NONE') {
    return (
      <div className="result none">
        <h3>{opportunity.event_title}</h3>
        <div className="verdict">✕ NO ARBITRAGE</div>
        <p className="plain">{explainNoArbitrage(opportunity)}</p>
        <div className="actions">
          <button className="ghost" onClick={onDetails}>
            View details
          </button>
        </div>
      </div>
    );
  }

  const possible = status === 'POSSIBLE';

  return (
    <div className={`result ${possible ? 'possible' : 'found'}`}>
      <h3>{opportunity.event_title}</h3>
      <div className="verdict">
        {possible ? '⚠ POSSIBLE ARBITRAGE' : '✓ ARBITRAGE FOUND'}
      </div>

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
              Limited to {formatMoney(allocation.total_stake)} — that is all the size available
              at these prices.
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

      <div className="actions">
        {allocation.ok && (
          <button className="primary" onClick={() => setShowHow(!showHow)}>
            {showHow ? 'Hide' : 'Show me how'}
          </button>
        )}
        {possible && (
          <button className="ghost" onClick={() => setShowWhy(!showWhy)}>
            Why?
          </button>
        )}
        <button className="ghost" onClick={onDetails}>
          Details
        </button>
      </div>

      {showWhy && (
        <div className="why-box">
          <p>
            Both venues are offering what looks like the same bet, and the prices really do add
            up to less than the payout. What cannot be checked is whether they decide the
            outcome the same way.
          </p>
          <p>
            {opportunity.settlement?.reason ??
              'One venue does not publish the source it settles against.'}
          </p>
          <p>
            If the two sources ever disagree at the moment this settles, both of your positions
            can lose. That is why this is shown as possible rather than guaranteed — the profit
            is real if they agree, and the whole{' '}
            {formatMoney(allocation.total_stake)} is at risk if they do not.
          </p>
        </div>
      )}

      {showHow && allocation.ok && (
        <div className="how">
          <h4>Your {allocation.legs.length === 2 ? 'two positions' : 'positions'}</h4>
          {allocation.legs.map((leg, index) => (
            <div className="position" key={index}>
              <div className="venue">{leg.venue}</div>
              <div className="what">
                {leg.action}
                <span className="on"> · {leg.outcome_label}</span>
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
        </div>
      )}
    </div>
  );
}
