import type { DeciCents, Money } from '../domain/money.js';
import type {
  AssuranceGrade,
  Opportunity,
  OpportunityType,
  SettlementAssurance,
} from '../domain/types.js';
import { CONFIDENCE } from '../match/confidence.js';

/**
 * Opportunity filtering. Lives in core rather than in the UI so the same
 * predicate is testable and cannot drift between the list view, the alerting
 * path and the backtester.
 */

export type Section = 'PREDICTION' | 'SPORTS' | 'ALL';

export interface OpportunityFilter {
  /** Minimum executable edge, in deci-cents per $1 of payout. */
  min_net_edge?: DeciCents;
  /** Minimum contracts available at the best ask on the thinnest leg. */
  min_liquidity?: number;
  /** Minimum match confidence, 0..1. Never allowed below the arbitrage floor. */
  min_match_confidence?: number;
  /** Maximum quote age in milliseconds. */
  max_quote_age_ms?: number;
  section?: Section;
  /** Only opportunities whose venue set is exactly one of these combinations. */
  venues?: string[];
  /** Maximum capital required to take the full position, in deci-cents. */
  max_capital?: Money;
  /** Only opportunities settling within this many milliseconds. */
  max_time_to_settlement_ms?: number;
  min_time_to_settlement_ms?: number;
  /**
   * Certified only: contract, settlement and execution all verified. This is
   * strictly narrower than "guaranteed type", which describes structure and
   * says nothing about whether settlement equivalence was ever established.
   */
  certified_only?: boolean;
  /** Which assurance grades to include. Defaults to everything but disqualified. */
  assurance?: AssuranceGrade[];
  /** Which settlement states to include. */
  settlement_assurance?: SettlementAssurance[];
  /** Guaranteed types only, versus including relative value. */
  guaranteed_only?: boolean;
  types?: OpportunityType[];
  search?: string;
}

const GUARANTEED_TYPES: OpportunityType[] = ['GUARANTEED_ARB', 'CROSS_VENUE_ARB'];

export function isGuaranteed(opportunity: Opportunity): boolean {
  return GUARANTEED_TYPES.includes(opportunity.type);
}

/**
 * The hard safety rule, applied before any user filter.
 *
 * The floor governs *contract identity* — whether the two legs are the same
 * proposition — and nothing below it is ever presented as arbitrage. It
 * deliberately does not govern settlement assurance: an unverifiable
 * settlement basis is disclosed on the card as a qualified candidate rather
 * than withheld, because a venue declining to publish its index is not
 * evidence that the contracts differ.
 */
export function passesSafetyFloor(opportunity: Opportunity): boolean {
  if (isGuaranteed(opportunity) || opportunity.type === 'NEAR_ARB') {
    return opportunity.match_confidence >= CONFIDENCE.ARBITRAGE_FLOOR;
  }
  return true;
}

function sectionOf(opportunity: Opportunity): Section {
  return opportunity.category === 'SPORTS' ? 'SPORTS' : 'PREDICTION';
}

export function filterOpportunities(
  opportunities: Opportunity[],
  filter: OpportunityFilter = {},
): Opportunity[] {
  const minConfidence = Math.max(
    filter.min_match_confidence ?? 0,
    // A user cannot dial the floor below the product's own rule.
    0,
  );

  return opportunities.filter((opportunity) => {
    if (!passesSafetyFloor(opportunity)) return false;
    if (opportunity.net_edge < (filter.min_net_edge ?? Number.NEGATIVE_INFINITY)) return false;
    if (opportunity.match_confidence < minConfidence) return false;

    if (filter.min_liquidity !== undefined) {
      const thinnest = opportunity.legs.reduce(
        (min, leg) => Math.min(min, leg.depth_available),
        Infinity,
      );
      if (!Number.isFinite(thinnest) || thinnest < filter.min_liquidity) return false;
    }

    if (filter.max_quote_age_ms !== undefined && opportunity.quote_age_ms > filter.max_quote_age_ms) {
      return false;
    }

    if (filter.section && filter.section !== 'ALL' && sectionOf(opportunity) !== filter.section) {
      return false;
    }

    if (filter.venues && filter.venues.length > 0) {
      const wanted = new Set(filter.venues);
      if (!opportunity.venues.every((v) => wanted.has(v))) return false;
    }

    if (filter.max_capital !== undefined && opportunity.capacity_capital > filter.max_capital) {
      return false;
    }

    const ttl = opportunity.time_to_settlement_ms;
    if (filter.max_time_to_settlement_ms !== undefined) {
      if (ttl === null || ttl > filter.max_time_to_settlement_ms) return false;
    }
    if (filter.min_time_to_settlement_ms !== undefined) {
      if (ttl === null || ttl < filter.min_time_to_settlement_ms) return false;
    }

    if (filter.certified_only && opportunity.assurance !== 'CERTIFIED') return false;
    if (filter.guaranteed_only && !isGuaranteed(opportunity)) return false;
    if (filter.assurance && filter.assurance.length > 0) {
      if (!filter.assurance.includes(opportunity.assurance)) return false;
    }
    if (filter.settlement_assurance && filter.settlement_assurance.length > 0) {
      const state = opportunity.settlement?.assurance ?? 'CONFIRMED';
      if (!filter.settlement_assurance.includes(state)) return false;
    }
    if (filter.types && filter.types.length > 0 && !filter.types.includes(opportunity.type)) {
      return false;
    }

    if (filter.search && filter.search.trim().length > 0) {
      const needle = filter.search.trim().toLowerCase();
      const haystack = `${opportunity.event_title} ${opportunity.legs
        .map((l) => l.outcome_label)
        .join(' ')}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    return true;
  });
}

export interface OpportunityCounts {
  total: number;
  by_type: Record<OpportunityType, number>;
  by_assurance: Record<AssuranceGrade, number>;
  guaranteed: number;
  venues: string[];
  best_net_edge: DeciCents | null;
}

export function countOpportunities(opportunities: Opportunity[]): OpportunityCounts {
  const byType: Record<OpportunityType, number> = {
    GUARANTEED_ARB: 0,
    CROSS_VENUE_ARB: 0,
    NEAR_ARB: 0,
    RELATIVE_VALUE: 0,
  };
  const byAssurance: Record<AssuranceGrade, number> = {
    CERTIFIED: 0,
    QUALIFIED_CANDIDATE: 0,
    NOT_PROFITABLE: 0,
    DISQUALIFIED: 0,
    INFORMATIONAL: 0,
  };
  const venues = new Set<string>();
  let best: number | null = null;

  for (const opportunity of opportunities) {
    byType[opportunity.type] += 1;
    byAssurance[opportunity.assurance] += 1;
    for (const venue of opportunity.venues) venues.add(venue);
    if (best === null || opportunity.net_edge > best) best = opportunity.net_edge;
  }

  return {
    total: opportunities.length,
    by_type: byType,
    by_assurance: byAssurance,
    guaranteed: byType.GUARANTEED_ARB + byType.CROSS_VENUE_ARB,
    venues: [...venues].sort(),
    best_net_edge: best,
  };
}
