import type { MatchTier } from '../domain/types.js';

/**
 * Confidence tiers. These bounds are the product's central safety rule:
 * nothing below ARBITRAGE_FLOOR is ever labelled arbitrage, no matter how
 * attractive the price looks.
 */
export const CONFIDENCE = {
  /** Mechanically identical contracts. */
  MECHANICALLY_IDENTICAL: 1.0,
  /** Almost certainly identical. */
  ALMOST_CERTAIN_MIN: 0.95,
  /** Shown, but visually distinct and flagged for manual review. */
  REVIEW_MIN: 0.8,
  /** Below this a match is never surfaced as arbitrage. */
  ARBITRAGE_FLOOR: 0.8,
} as const;

export function tierFor(confidence: number): MatchTier {
  if (confidence >= CONFIDENCE.MECHANICALLY_IDENTICAL) return 'MECHANICALLY_IDENTICAL';
  if (confidence >= CONFIDENCE.ALMOST_CERTAIN_MIN) return 'ALMOST_CERTAIN';
  if (confidence >= CONFIDENCE.REVIEW_MIN) return 'REVIEW_REQUIRED';
  return 'REJECTED';
}

export function tierLabel(tier: MatchTier): string {
  switch (tier) {
    case 'MECHANICALLY_IDENTICAL':
      return 'Mechanically identical';
    case 'ALMOST_CERTAIN':
      return 'Almost certainly identical';
    case 'REVIEW_REQUIRED':
      return 'Manual review required';
    case 'REJECTED':
      return 'Rejected';
  }
}

/** Whether a match at this confidence may be presented as arbitrage at all. */
export function eligibleForArbitrage(confidence: number): boolean {
  return confidence >= CONFIDENCE.ARBITRAGE_FLOOR;
}

/** Matches in this band are shown but must be rendered visually distinct. */
export function requiresManualReview(confidence: number): boolean {
  return confidence >= CONFIDENCE.REVIEW_MIN && confidence < CONFIDENCE.ALMOST_CERTAIN_MIN;
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // Keep three decimals so a 0.9499999 never renders as 95%.
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
