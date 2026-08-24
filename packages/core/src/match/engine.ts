import type {
  Market,
  MarketMatch,
  MatchCheck,
  MatchMethod,
  MatchProposal,
} from '../domain/types.js';
import { contentTokens, stringSimilarity, tokenSimilarity } from '../normalize/canonical.js';
import { clampConfidence, eligibleForArbitrage, tierFor } from './confidence.js';
import { assessSettlement, compareContracts, numbersEqual } from './assurance.js';

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

/**
 * Drop keys that are present but undefined, so defaults survive them.
 *
 * `{...DEFAULTS, ...options}` treats an explicit `undefined` as a value, so a
 * caller forwarding a setting it happens not to have — `min_confidence_to_report:
 * config.floor` where the config is silent — replaces the floor with undefined
 * rather than leaving it alone. Every comparison against it then reads false,
 * which does not throw: it quietly reports matches the floor exists to
 * suppress.
 */
function defined<T extends object>(options: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

function check(name: string, passed: boolean, detail: string, blocking: boolean): MatchCheck {
  return { name, passed, detail, blocking };
}

/** Deadlines within this window count as the same settlement moment. */
const DEADLINE_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True when both markets state the same comparison against the same number,
 * closing at the same time. A shared threshold alone is not enough — "above
 * $100k during 2026" and "above $100k during 2027" agree on everything except
 * the only thing that matters — so the deadline has to line up too.
 */
function structuralIdentity(left: Market, right: Market): boolean {
  if (left.comparison_operator === 'NONE' || left.threshold === null) return false;
  if (left.comparison_operator !== right.comparison_operator) return false;
  if (!numbersEqual(left.threshold, right.threshold)) return false;
  if (!numbersEqual(left.line, right.line)) return false;

  if (left.close_time === null || right.close_time === null) return false;
  const gap = Math.abs(Date.parse(left.close_time) - Date.parse(right.close_time));
  return Number.isFinite(gap) && gap <= DEADLINE_TOLERANCE_MS;
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
  const opts = { ...DEFAULTS, ...defined(options) };
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

  // With no threshold on either side, the outcome name is the whole
  // proposition and a mismatch is disqualifying rather than merely costly.
  // Two fighters on the same card share every structural attribute there is.
  const anyThreshold =
    left.threshold !== null ||
    left.line !== null ||
    right.threshold !== null ||
    right.line !== null;
  checks.push(
    check(
      'same_outcome_condition',
      outcomeIdsEqual || outcomeSim >= 0.75,
      outcomeIdsEqual
        ? `Both pay on ${left.outcome}.`
        : `Outcomes "${left.outcome_label}" vs "${right.outcome_label}" ` +
            `(${Math.round(outcomeSim * 100)}% similar)` +
            (anyThreshold ? '.' : ', and no threshold corroborates them.'),
      !anyThreshold,
    ),
  );

  // --- Settlement ------------------------------------------------------

  const contract = compareContracts(left, right);
  const settlementAssessment = assessSettlement(left, right);
  const settlementDiff = settlementAssessment.diff;
  checks.push(
    check(
      'settlement_not_contradictory',
      settlementAssessment.assurance !== 'CONFLICT',
      settlementAssessment.reason,
      // A settlement conflict bars *certification*, not the pairing itself.
      // The arb engine demotes on it; blocking here would delete the
      // information rather than report it.
      false,
    ),
  );

  checks.push(
    check(
      'settlement_basis_verified',
      settlementAssessment.assurance === 'CONFIRMED',
      settlementAssessment.reason,
      false,
    ),
  );

  // --- Currency / jurisdiction ----------------------------------------

  const sameCurrency = left.currency === right.currency;
  checks.push(
    check(
      'same_structural_trigger',
      structuralIdentity(left, right),
      structuralIdentity(left, right)
        ? `Both resolve on ${left.comparison_operator} ${String(left.threshold)} at the same ` +
            `deadline, so they trigger on the same fact.`
        : 'No shared threshold and deadline to corroborate the wording.',
      false,
    ),
  );

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
  //
  // Scoped to proposition identity alone. Settlement is a separate,
  // three-valued assessment: folding it in here is what made "same contract,
  // unknown index" indistinguishable from "same contract, wrong index".

  let confidence = contract.confidence;

  // Wording corroborates structure but cannot rescue it.
  if (contract.state === 'EQUIVALENT') {
    confidence = Math.min(1, confidence + 0.03 * Math.max(titleSim, outcomeSim));
  }

  if (!sameCurrency) confidence -= 0.05;
  if (left.jurisdiction !== right.jurisdiction) confidence -= 0.02;
  if (left.status !== 'OPEN' || right.status !== 'OPEN') confidence -= 0.1;

  // Provenance caps the result. A record repaired before ingestion was not
  // matched on the venue's own text, and a rule written for a whole product
  // is a weaker claim about one contract than a rule written for it.
  const ceiling = Math.min(
    left.provenance.confidence_ceiling,
    right.provenance.confidence_ceiling,
  );
  const capped = confidence > ceiling;
  confidence = Math.min(confidence, ceiling);

  const repairs = [...left.provenance.repairs, ...right.provenance.repairs];
  checks.push(
    check(
      'unmodified_venue_text',
      repairs.length === 0,
      repairs.length === 0
        ? 'Both records are the venues’ own text, unaltered.'
        : `Matched against repaired text (${repairs.join('; ')})` +
            `${capped ? `, so confidence is capped at ${(ceiling * 100).toFixed(0)}%` : ''}.`,
      false,
    ),
  );

  const blockingFailure =
    contract.state === 'MISMATCHED' || checks.some((c) => c.blocking && !c.passed);
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
    contract: { ...contract, confidence: finalConfidence },
    settlement: settlementAssessment,
    checks,
    // Unverifiable settlement does not bar an arbitrage claim — it qualifies
    // it. Only a demonstrated conflict, or a failed logical check, does.
    eligible_for_arbitrage:
      !blockingFailure &&
      eligibleForArbitrage(finalConfidence) &&
      settlementAssessment.assurance !== 'CONFLICT',
  };
}

/**
 * Candidate key for pairing.
 *
 * Bucketing on the canonical event id would be cheaper but useless across
 * venues: two books describe the same event in different words and land on
 * different ids, which is exactly the case cross-venue matching exists for.
 * Bucketing on the *structural* facts instead — tier, market type and the
 * threshold to four significant figures — puts "above $99,999.99" and
 * "crosses $100,000" in the same bucket while keeping a -3.5 spread away from
 * a -4.5 one.
 */
function candidateKey(market: Market): string {
  const threshold =
    market.threshold === null ? '-' : Number(market.threshold).toPrecision(4);
  const line = market.line === null ? '-' : Number(market.line).toPrecision(4);
  return `${market.tier}|${market.market_type}|${market.comparison_operator}|${threshold}|${line}`;
}

/**
 * Pair markets across venues, keeping every pairing that clears the reporting
 * threshold.
 *
 * The cost is |A| x |B| within a bucket rather than |markets|^2, and in
 * practice one side is an exchange with thousands of markets while the other
 * is a book with a handful, so the product stays small.
 */
export function matchMarkets(
  markets: Market[],
  options: MatchOptions = {},
): MarketMatch[] {
  const opts = { ...DEFAULTS, ...defined(options) };
  const byEvent = new Map<string, Market[]>();
  for (const market of markets) {
    const key = candidateKey(market);
    const bucket = byEvent.get(key);
    if (bucket) bucket.push(market);
    else byEvent.set(key, [market]);
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
