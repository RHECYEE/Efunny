import type { Opportunity } from '@arbterminal/core';
import { formatEdge, formatMoney, formatPrice } from '../format.js';

/**
 * The assurance panel.
 *
 * Three questions, answered separately, because a single confidence score
 * could not hold them at once. "Same contract, unknown settlement index" and
 * "same contract, different settlement index" used to produce nearly the same
 * number and the same outcome — rejection — even though the first is worth
 * showing with a warning and the second is a demonstrated problem.
 */

const GRADE_TEXT: Record<string, { title: string; body: string; tone: string }> = {
  CERTIFIED: {
    title: 'CERTIFIED ARBITRAGE',
    body:
      'The contracts state the same proposition, settle off the same facts, and are ' +
      'fillable at the prices shown.',
    tone: 'grade-certified',
  },
  QUALIFIED_CANDIDATE: {
    title: '⚠ QUALIFIED ARBITRAGE CANDIDATE',
    body:
      'The observable contracts appear complementary and imply an arbitrage. NOT CERTIFIED — ' +
      'settlement equivalence could not be verified, and a settlement mismatch could break ' +
      'the hedge.',
    tone: 'grade-qualified',
  },
  NOT_PROFITABLE: {
    title: 'NOT PROFITABLE',
    body: 'A spread exists, but fees and slippage consume it.',
    tone: 'grade-near',
  },
  DISQUALIFIED: {
    title: '✕ DISQUALIFIED — SETTLEMENT CONFLICT',
    body:
      'The venues name different settlement bases. The prices look complementary but this ' +
      'cannot be a hedge: the two references can land on opposite sides of the trigger.',
    tone: 'grade-disqualified',
  },
  INFORMATIONAL: {
    title: 'INFORMATIONAL',
    body: 'No hedge is claimed. This is a price divergence, and the position can lose.',
    tone: 'grade-info',
  },
};

const SETTLEMENT_TEXT: Record<string, { label: string; tone: string }> = {
  CONFIRMED: { label: '✓ CONFIRMED', tone: 'pos' },
  UNVERIFIABLE: { label: '? UNVERIFIABLE', tone: 'warn' },
  CONFLICT: { label: '✕ CONFLICT', tone: 'neg' },
};

const EXECUTION_TEXT: Record<string, { label: string; tone: string }> = {
  OBSERVED: { label: '✓ Observed depth', tone: 'pos' },
  ASSUMED_DEPTH: { label: '? Assumed stake limit', tone: 'warn' },
  STALE: { label: '! Quotes stale', tone: 'warn' },
};

export function AssurancePanel({ opportunity }: { opportunity: Opportunity }) {
  const grade = GRADE_TEXT[opportunity.assurance] ?? GRADE_TEXT.INFORMATIONAL!;
  const settlement = opportunity.settlement;
  const settlementState = settlement?.assurance ?? 'CONFIRMED';
  const settlementText = SETTLEMENT_TEXT[settlementState]!;
  const execution = EXECUTION_TEXT[opportunity.execution_quality]!;

  return (
    <div className="panel">
      <h3>Assurance</h3>

      <div className={`grade ${grade.tone}`}>
        <div className="grade-title">{grade.title}</div>
        <div className="grade-body">{grade.body}</div>
      </div>

      {/* ---- contract match ---- */}
      <h3 style={{ marginTop: 12 }}>Contract match</h3>
      {opportunity.contract ? (
        <table className="num">
          <tbody>
            {opportunity.contract.dimensions.map((d) => (
              <tr key={d.name}>
                <td className={d.agreed ? 'pos' : d.disqualifying ? 'neg' : 'warn'}>
                  {d.agreed ? '✓' : d.disqualifying ? '✕' : '?'}
                </td>
                <td>{d.label}</td>
                <td className="r dim trunc" title={`${d.left}  vs  ${d.right}`}>
                  {d.agreed ? d.left : `${d.left} vs ${d.right}`}
                </td>
              </tr>
            ))}
            <tr>
              <td />
              <td className="muted">Proposition identity</td>
              <td className="r">{(opportunity.contract.confidence * 100).toFixed(0)}%</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <div className="muted">
          Single venue, one rule set — there is no second contract to compare against.
        </div>
      )}

      {/* ---- settlement ---- */}
      <h3 style={{ marginTop: 12 }}>Settlement</h3>
      {settlement ? (
        <table className="num">
          <tbody>
            <tr>
              <td className="muted">{opportunity.venues[0]} basis</td>
              <td className="r trunc" title={settlement.left_source}>
                {settlement.left_source}
              </td>
            </tr>
            <tr>
              <td className="muted">{opportunity.venues[1]} basis</td>
              <td className="r trunc" title={settlement.right_source}>
                {settlement.right_source}
              </td>
            </tr>
            <tr>
              <td className="muted">Equivalence</td>
              <td className={`r ${settlementText.tone}`}>{settlementText.label}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <div className="muted">All legs settle under one venue rule set.</div>
      )}
      {settlement && <div className="why" style={{ marginTop: 5 }}>{settlement.reason}</div>}

      {/* ---- execution ---- */}
      <h3 style={{ marginTop: 12 }}>Execution</h3>
      <div className="row between">
        <span className="muted">Depth and freshness</span>
        <span className={execution.tone}>{execution.label}</span>
      </div>

      {/* ---- scenarios ---- */}
      {settlementState !== 'CONFIRMED' && opportunity.venues.length > 1 && (
        <>
          <h3 style={{ marginTop: 12 }}>If settlement differs</h3>
          <table className="num">
            <tbody>
              <tr>
                <td className="muted">Edge if the bases are equivalent</td>
                <td className="r pos">
                  {formatEdge(opportunity.edge_if_settlement_equivalent)}
                </td>
              </tr>
              <tr>
                <td className="muted">Worst case if they are not</td>
                <td className="r neg">
                  {formatMoney(opportunity.worst_case_if_settlement_differs)}
                </td>
              </tr>
              <tr>
                <td className="muted">Cost per $1 of payout</td>
                <td className="r">{formatPrice(opportunity.unit_cost)}</td>
              </tr>
            </tbody>
          </table>
          <div className="why" style={{ marginTop: 5 }}>
            Both legs can lose together: if the venues’ references straddle the trigger, the YES
            leg and the NO leg both resolve against you. The downside is the whole outlay, which
            is why it is shown as a scenario rather than folded into the edge as a reserve.
          </div>
        </>
      )}
    </div>
  );
}
