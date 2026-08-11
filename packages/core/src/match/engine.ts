import type {
  Market,
  MarketMatch,
  MatchCheck,
  MatchMethod,
  MatchProposal,
} from '../domain/types.js';
import { contentTokens, stringSimilarity, tokenSimilarity } from '../normalize/canonical.js';
import { clampConfidence, eligibleForArbitrage, tierFor } from './confidence.js';
import { diffSettlement } from './settlementDiff.js';

/**
 * The matching engine.
 *
 * Contract with the rest of the system:
 *  - It consumes normalized `Market` objects and knows nothing about any
 *    venue. Adding a venue means writing an adapter, not editing this file.
 *  - Non-deterministic sources (fuzzy scoring, or an LLM reading two
 *    differently-worded rule sets) may only *propose* a pairing. Confidence
 *    is re-derived here from deterministic checks, and a proposal that fails
 *    any blocking check is rejected regardless of how sure the proposer was.
 */

export interface MatchOptions {
  /** Pairings below this are not returned at all. Default: 0.5. */
  min_confidence_to_report?: number;
  /** Title similarity required before a fuzzy pairing is considered. Default: 0.45. */
  fuzzy_title_floor?: number;
}

const DEFAULTS: Required<MatchOptions> = {
  min_confidence_to_report: 0.5,
  fuzzy_title_floor: 0.45,
};

function check(name: string, passed: boolean, detail: string, blocking: boolean): MatchCheck {
  return { name, passed, detail, blocking };
}

function numbersEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // Lines are quoted to at most half-points; 1e-9 absorbs float representation.
  return Math.abs(a - b) < 1e-9;
}

/**
 * Deterministic verification of a candidate pairing. This is the only place
 * a `match_confidence` is ever produced.
 */
export function verifyMatch(
  left: Market,
  right: Market,
  method: MatchMethod = 'FUZZY',
  options: MatchOptions = {},
): MarketMatch {
  const opts = { ...DEFAULTS, ...options };
  const checks: MatchCheck[] = [];

  // --- Blocking structural checks -------------------------------------

  checks.push(
    check(
      'distinct_venues',
      left.venue !== right.venue,
      left.venue === right.venue
        ? `Both legs are on ${left.venue}; a cross-venue match requires two venues.`
        : `${left.venue} vs ${right.venue}.`,
      true,
    ),
  );

  checks.push(
    check(
      'same_market_tier',
      left.tier === right.tier,
      left.tier === right.tier
        ? `Both are ${left.tier} markets.`
        : `${left.tier} vs ${right.tier}. Markets in different tiers are never equivalent, ` +
            `however correlated they look.`,
      true,
    ),
  );

  checks.push(
    check(
      'same_market_type',
      left.market_type === right.market_type,
      left.market_type === right.market_type
        ? `Both are ${left.market_type}.`
        : `${left.market_type} vs ${right.market_type}.`,
      true,
    ),
  );

  const linesMatch =
    numbersEqual(left.line, right.line) &&
    numbersEqual(left.threshold, right.threshold) &&
    left.comparison_operator === right.comparison_operator;
  checks.push(
    check(
      'same_line_and_operator',
      linesMatch,
      linesMatch
        ? left.line === null && left.threshold === null
          ? 'Neither market carries a line or threshold.'
          : `Line ${String(left.line)} / threshold ${String(left.threshold)} ` +
            `with ${left.comparison_operator} on both sides.`
        : `Line ${String(left.line)}/${String(right.line)}, ` +
            `threshold ${String(left.threshold)}/${String(right.threshold)}, ` +
            `operator ${left.comparison_operator}/${right.comparison_operator}.`,
      true,
    ),
  );

  // --- Event and outcome identity -------------------------------------

  const eventIdsEqual = left.event_id === right.event_id;
  const titleSim = tokenSimilarity(contentTokens(left.title), contentTokens(right.title));
  const outcomeIdsEqual = left.outcome === right.outcome;
  const outcomeSim = Math.max(
    stringSimilarity(left.outcome_label, right.outcome_label),
    tokenSimilarity(contentTokens(left.outcome_label), contentTokens(right.outcome_label)),
  );

  checks.push(
    check(
      'same_underlying_event',
      eventIdsEqual || titleSim >= opts.fuzzy_title_floor,
      eventIdsEqual
        ? `Both resolve to canonical event ${left.event_id}.`
        : `Canonical events differ (${left.event_id} vs ${right.event_id}); ` +
            `titles overlap ${Math.round(titleSim * 100)}%.`,
      false,
    ),
  );

  checks.push(
    check(
      'same_outcome_condition',
      outcomeIdsEqual || outcomeSim >= 0.75,
      outcomeIdsEqual
        ? `Both pay on ${left.outcome}.`
        : `Outcomes "${left.outcome_label}" vs "${right.outcome_label}" ` +
            `(${Math.round(outcomeSim * 100)}% similar).`,
      false,
    ),
  );

  // --- Settlement ------------------------------------------------------

  const settlementDiff = diffSettlement(left.settlement, right.settlement);
  checks.push(
    check(
      'settlement_not_contradictory',
      settlementDiff.worst_severity !== 'DISQUALIFYING',
      settlementDiff.summary,
      true,
    ),
  );

  checks.push(
    check(
      'same_settlement_source',
      settlementDiff.fields.find((f) => f.field === 'settlement_source')?.severity === 'IDENTICAL',
      settlementDiff.fields.find((f) => f.field === 'settlement_source')?.explanation ??
        'No settlement source recorded on either side.',
      false,
    ),
  );

  // --- Currency / jurisdiction ----------------------------------------

  const sameCurrency = left.currency === right.currency;
  checks.push(
    check(
      'same_currency',
      sameCurrency,
      sameCurrency
        ? `Both denominated in ${left.currency}.`
        : `${left.currency} vs ${right.currency}; FX moves between fill and settlement ` +
            `are unhedged and not modelled.`,
      false,
    ),
  );

  // --- Confidence ------------------------------------------------------

  // Start from how the event/outcome identity was established, then subtract
  // for everything that weakens it.
  let confidence: number;
  if (eventIdsEqual && outcomeIdsEqual) {
    confidence = 1;
  } else {
    // Fuzzy identity is capped below the "almost certain" band unless the
    // canonical IDs actually agree.
    const identity = 0.5 * titleSim + 0.5 * outcomeSim;
    confidence = Math.min(0.94, identity);
    if (eventIdsEqual) confidence = Math.min(0.94, Math.max(confidence, 0.8 + 0.14 * outcomeSim));
  }

  confidence -= settlementDiff.confidence_penalty;
  if (!sameCurrency) confidence -= 0.05;
  if (left.jurisdiction !== right.jurisdiction) confidence -= 0.02;

  // A market that is not open cannot be verified against live rules.
  if (left.status !== 'OPEN' || right.status !== 'OPEN') confidence -= 0.1;

  const blockingFailure = checks.some((c) => c.blocking && !c.passed);
  if (blockingFailure) confidence = 0;

  const finalConfidence = clampConfidence(confidence);

  return {
    match_id: `${left.market_id}::${right.market_id}`,
    left_market_id: left.market_id,
    right_market_id: right.market_id,
    event_id: eventIdsEqual ? left.event_id : `${left.event_id}~${right.event_id}`,
    confidence: finalConfidence,
    tier: tierFor(finalConfidence),
    method: eventIdsEqual && outcomeIdsEqual && method !== 'SEMANTIC_PROPOSED' ? 'EXACT' : method,
    settlement_diff: settlementDiff,
    checks,
    eligible_for_arbitrage: !blockingFailure && eligibleForArbitrage(finalConfidence),
  };
}

/**
 * Match every market in `left` against every market in `right`, keeping the
 * best pairing per market. Quadratic, but bucketed by canonical event so the
 * comparison count stays proportional to markets-per-event, not markets.
 */
export function matchMarkets(
  markets: Market[],
  options: MatchOptions = {},
): MarketMatch[] {
  const opts = { ...DEFAULTS, ...options };
  const byEvent = new Map<string, Market[]>();
  for (const market of markets) {
    const bucket = byEvent.get(market.event_id);
    if (bucket) bucket.push(market);
    else byEvent.set(market.event_id, [market]);
  }

  const matches: MarketMatch[] = [];
  for (const bucket of byEvent.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i]!;
        const right = bucket[j]!;
        if (left.venue === right.venue) continue;
        const match = verifyMatch(left, right, 'EXACT', opts);
        if (match.confidence >= opts.min_confidence_to_report) matches.push(match);
      }
    }
  }
  return matches.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Validate externally-proposed pairings — including anything an LLM
 * suggested. The proposal supplies only *which two markets to look at*; the
 * verdict comes from `verifyMatch`.
 */
export function validateProposals(
  proposals: MatchProposal[],
  markets: Market[],
  options: MatchOptions = {},
): MarketMatch[] {
  const byId = new Map(markets.map((m) => [m.market_id, m]));
  const out: MarketMatch[] = [];
  for (const proposal of proposals) {
    const left = byId.get(proposal.left_market_id);
    const right = byId.get(proposal.right_market_id);
    if (!left || !right) continue;
    const method: MatchMethod = proposal.source === 'LLM' ? 'SEMANTIC_PROPOSED' : 'FUZZY';
    out.push(verifyMatch(left, right, method, options));
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
