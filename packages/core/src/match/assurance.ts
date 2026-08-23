import type {
  ContractComparison,
  ContractDimension,
  Market,
  SettlementAssessment,
  SettlementAssurance,
  SettlementDiff,
} from '../domain/types.js';
import { contentTokens, stringSimilarity, tokenSimilarity } from '../normalize/canonical.js';
import { diffSettlement } from './settlementDiff.js';

/**
 * Splitting one confidence score into the questions it was hiding.
 *
 * A single 0..1 number cannot answer two different questions at once, and
 * this system was asking it to. "These are the same contract but I cannot see
 * how one of them settles" and "these settle off different indices" both came
 * out around 0.6, so both were rejected — even though the first is an unknown
 * worth showing with a warning and the second is a demonstrated problem.
 *
 * The two are now assessed separately:
 *
 *   - Contract match is *logical*. Above $100,000 is not above $105,000, at
 *     any price, and no corroboration elsewhere rescues it.
 *   - Settlement assurance is *epistemic*, and three-valued. Confirmed,
 *     conflicting, or unverifiable — and unverifiable is not a rejection.
 */

/* ------------------------------------------------------------------ *
 * Contract comparison
 * ------------------------------------------------------------------ */

/** Deadlines within this window are the same settlement moment. */
const DEADLINE_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Contests get a wider window, because the deadline is not what identifies
 * them.
 *
 * For a threshold market the deadline is load-bearing — "above $100k by
 * December" and "by January" are different contracts, and a tolerance wide
 * enough to merge them would be a serious error. For a named contest it is
 * not: what identifies a bout is who is in it, and that is now checked
 * absolutely. Venues buffer the administrative expiry differently and always
 * will — Kalshi expires a 29 August fight on 12 September, while Polymarket
 * dates it to the event — so a tight comparison here rejects genuine pairs
 * over a difference in bookkeeping rather than in the contract.
 */
const CONTEST_DEADLINE_TOLERANCE_MS = 30 * 24 * 60 * 60 * 1000;

const CONTEST_TIERS = new Set(['GAME', 'TEAM_PROP', 'PLAYER_PROP']);

function deadlineToleranceFor(left: Market, right: Market): number {
  return CONTEST_TIERS.has(left.tier) && CONTEST_TIERS.has(right.tier)
    ? CONTEST_DEADLINE_TOLERANCE_MS
    : DEADLINE_TOLERANCE_MS;
}

/**
 * Thresholds compare within a *relative* epsilon: "$99,999.99" and "$100,000"
 * are one strike a cent apart. Relative, never absolute — a tolerance wide
 * enough for a six-figure crypto strike would equate a -3.5 spread with -4.5.
 */
export function numbersEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-6 * scale;
}

function show(value: unknown): string {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function dimension(
  name: string,
  label: string,
  agreed: boolean,
  disqualifying: boolean,
  left: unknown,
  right: unknown,
  detail: string,
): ContractDimension {
  return { name, label, agreed, disqualifying, left: show(left), right: show(right), detail };
}

/**
 * Compare the propositions. Every dimension marked `disqualifying` is a hard
 * gate: failing one means the two contracts are simply about different
 * things, and the pairing dies there regardless of how the rest scores.
 */
export function compareContracts(left: Market, right: Market): ContractComparison {
  const dimensions: ContractDimension[] = [];

  dimensions.push(
    dimension(
      'venues',
      'Distinct venues',
      left.venue !== right.venue,
      true,
      left.venue,
      right.venue,
      left.venue === right.venue
        ? 'A cross-venue match requires two venues.'
        : 'Two different venues.',
    ),
  );

  dimensions.push(
    dimension(
      'tier',
      'Market tier',
      left.tier === right.tier,
      true,
      left.tier,
      right.tier,
      left.tier === right.tier
        ? `Both are ${left.tier} markets.`
        : 'Markets in different tiers are never equivalent, however correlated.',
    ),
  );

  dimensions.push(
    dimension(
      'market_type',
      'Market type',
      left.market_type === right.market_type,
      true,
      left.market_type,
      right.market_type,
      left.market_type === right.market_type
        ? `Both are ${left.market_type}.`
        : 'Different market types state different propositions.',
    ),
  );

  const directionAgrees = left.comparison_operator === right.comparison_operator;
  dimensions.push(
    dimension(
      'direction',
      'Direction',
      directionAgrees,
      true,
      left.comparison_operator,
      right.comparison_operator,
      directionAgrees ? 'Same comparison.' : 'Opposite or unrelated comparisons.',
    ),
  );

  const thresholdAgrees =
    numbersEqual(left.threshold, right.threshold) && numbersEqual(left.line, right.line);
  dimensions.push(
    dimension(
      'threshold',
      'Threshold',
      thresholdAgrees,
      true,
      left.threshold ?? left.line,
      right.threshold ?? right.line,
      thresholdAgrees
        ? left.threshold === null && left.line === null
          ? 'Neither contract carries a threshold.'
          : 'Same strike, within quoting tolerance.'
        : 'Different strikes. These are different propositions at any price.',
    ),
  );

  /**
   * When nothing else identifies the proposition, the name is the
   * proposition.
   *
   * A threshold market can be worded two entirely different ways and still be
   * checkable — "above $100,000" and "reaches 100k" agree on the number, and
   * the number is the contract. A named two-way contest has no such anchor.
   * Strip the names from "Sean Woodson wins" and "Dan Hooker wins" and what
   * remains is identical: same tier, same type, no threshold, no operator,
   * a deadline the same week. Structure cannot tell those apart, so with no
   * threshold present a name that does not correspond is not weak evidence
   * of a mismatch — it is the mismatch.
   */
  const anyThreshold =
    left.threshold !== null ||
    left.line !== null ||
    right.threshold !== null ||
    right.line !== null;
  const outcomeSimilarity = Math.max(
    stringSimilarity(left.outcome_label, right.outcome_label),
    tokenSimilarity(contentTokens(left.outcome_label), contentTokens(right.outcome_label)),
  );
  const outcomeAgrees = left.outcome === right.outcome || outcomeSimilarity >= 0.75;
  dimensions.push(
    dimension(
      'outcome',
      'Outcome',
      outcomeAgrees,
      // Disqualifying only where there is no threshold to corroborate the
      // wording. Where there is one, differing wording is handled by
      // confidence, as before.
      !anyThreshold,
      left.outcome_label,
      right.outcome_label,
      outcomeAgrees
        ? 'Both pay on the same outcome.'
        : anyThreshold
          ? 'Outcome wording differs; the shared threshold is what corroborates the match.'
          : 'Different outcomes, and no threshold to corroborate them. These are ' +
            'different propositions at any price.',
    ),
  );

  const deadlineGap =
    left.close_time && right.close_time
      ? Math.abs(Date.parse(left.close_time) - Date.parse(right.close_time))
      : null;
  const deadlineAgrees =
    deadlineGap !== null &&
    Number.isFinite(deadlineGap) &&
    deadlineGap <= deadlineToleranceFor(left, right);
  dimensions.push(
    dimension(
      'deadline',
      'Deadline',
      deadlineAgrees,
      // Only disqualifying when both sides state a deadline and they differ.
      // A missing deadline is an unknown, handled by confidence, not a proof.
      left.close_time !== null && right.close_time !== null,
      left.close_time,
      right.close_time,
      deadlineAgrees
        ? 'Same settlement moment.'
        : deadlineGap === null
          ? 'At least one contract states no deadline.'
          : `Deadlines differ by ${(deadlineGap / 86_400_000).toFixed(1)} days.`,
    ),
  );

  const blocked = dimensions.some((d) => d.disqualifying && !d.agreed);
  if (blocked) {
    return { state: 'MISMATCHED', dimensions, confidence: 0 };
  }

  const identical = left.event_id === right.event_id && left.outcome === right.outcome;
  if (identical) {
    return { state: 'IDENTICAL', dimensions, confidence: 1 };
  }

  // Structure agreeing on every dimension is substantive evidence, not merely
  // an absent objection — two venues can word one contract with almost no
  // shared vocabulary. It is capped below certainty because agreeing on the
  // trigger is not the same as agreeing on how the trigger is measured, which
  // is the settlement question and is assessed separately.
  // The outcome name is an identity check, not a structural one, and it is
  // deliberately left out of this score. Where a threshold exists the two
  // venues are *expected* to word the same contract differently — "Above
  // $99,999.99" against "crosses $100k" — and counting that disagreement as
  // structural disagreement would penalise the very case the threshold is
  // there to corroborate. Where no threshold exists it has already blocked
  // above, so it never needs to be scored at all.
  const structural = dimensions.every((d) => d.name === 'outcome' || d.agreed);
  const hasThreshold = left.threshold !== null || left.line !== null;
  const confidence = structural && hasThreshold ? 0.95 : structural ? 0.85 : 0.7;

  return { state: 'EQUIVALENT', dimensions, confidence };
}

/* ------------------------------------------------------------------ *
 * Settlement assurance
 * ------------------------------------------------------------------ */

function describeSource(market: Market): string {
  const source = market.settlement.settlement_source.trim();
  if (source !== '') return source;
  return market.provenance.source === 'MANUAL_IMPORT'
    ? 'Not exposed by the venue'
    : 'Not published';
}

/**
 * Grade the settlement comparison into one of three states.
 *
 * The important line is between CONFLICT and UNVERIFIABLE. A venue that does
 * not expose its settlement index has not demonstrated incompatibility — it
 * has left basis risk unresolved. Treating that as equivalent to a proven
 * mismatch is what silently discards every comparison against a book that
 * publishes nothing.
 */
export function assessSettlement(left: Market, right: Market): SettlementAssessment {
  const diff: SettlementDiff = diffSettlement(left.settlement, right.settlement);
  const leftSource = describeSource(left);
  const rightSource = describeSource(right);

  const leftHasSource = left.settlement.settlement_source.trim() !== '';
  const rightHasSource = right.settlement.settlement_source.trim() !== '';
  const identity = {
    left_venue: left.venue,
    right_venue: right.venue,
  };

  // A directly contradicted rule — overtime included versus excluded, a
  // reversed threshold direction — is a conflict whatever the sources say.
  if (diff.worst_severity === 'DISQUALIFYING') {
    return {
      assurance: 'CONFLICT',
      left_source: leftSource,
      right_source: rightSource,
      ...identity,
      unverified_venue: null,
      diff,
      reason: 'The two rule sets directly contradict each other.',
    };
  }

  if (leftHasSource && rightHasSource) {
    const sourceField = diff.fields.find((f) => f.field === 'settlement_source');
    if (sourceField && sourceField.conflict && sourceField.severity === 'MATERIAL') {
      return {
        assurance: 'CONFLICT',
        left_source: leftSource,
        right_source: rightSource,
        ...identity,
        unverified_venue: null,
        diff,
        reason:
          `Both venues name a settlement basis and they differ ` +
          `("${leftSource}" vs "${rightSource}"). Two references can straddle the ` +
          `threshold, and then both legs of the hedge lose.`,
      };
    }
    return {
      assurance: 'CONFIRMED',
      left_source: leftSource,
      right_source: rightSource,
      ...identity,
      unverified_venue: null,
      diff,
      reason: `Both venues settle on ${leftSource}.`,
    };
  }

  const missing = !leftHasSource ? left.venue : right.venue;
  return {
    assurance: 'UNVERIFIABLE',
    left_source: leftSource,
    right_source: rightSource,
    ...identity,
    unverified_venue: missing,
    diff,
    reason:
      `${missing} does not expose a settlement basis for this market, so equivalence ` +
      `cannot be checked. This is unresolved basis risk, not a demonstrated mismatch.`,
  };
}

export function assuranceLabel(assurance: SettlementAssurance): string {
  switch (assurance) {
    case 'CONFIRMED':
      return 'Confirmed';
    case 'UNVERIFIABLE':
      return 'Unverifiable';
    case 'CONFLICT':
      return 'Conflict';
  }
}
