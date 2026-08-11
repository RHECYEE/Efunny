import { ONE_DOLLAR, roundHalfAway, type DeciCents } from '../domain/money.js';
import type { DiffSeverity, SettlementDiff } from '../domain/types.js';

/**
 * Settlement-mismatch reserve.
 *
 * A "guaranteed" hedge is only guaranteed if both legs settle the same way on
 * the same facts. Where the rules differ — or where the match itself is only
 * probable — some of the displayed edge is really compensation for the risk
 * that both legs lose. That amount is withheld from the displayed edge rather
 * than being presented as profit.
 *
 * The reserve is a deterministic function of the settlement diff and the
 * match confidence. It is not a prediction; it is a haircut.
 */

/** Base reserve per $1 of payout, by worst settlement-field severity. */
const SEVERITY_RESERVE: Record<DiffSeverity, DeciCents> = {
  IDENTICAL: 0,
  COSMETIC: 2, // 0.2c
  MATERIAL: 15, // 1.5c
  DISQUALIFYING: ONE_DOLLAR, // the whole payout is at risk
};

/**
 * How much of the residual match uncertainty is charged against the edge.
 * At the 0.80 floor this is 0.20 * 1000 * 0.25 = 50 dc (5c per $1) — enough
 * that a review-tier match needs a genuinely wide spread to clear it.
 */
const CONFIDENCE_WEIGHT = 0.25;

export function settlementMismatchReserve(
  diff: SettlementDiff | null,
  matchConfidence: number,
): DeciCents {
  const base = diff ? SEVERITY_RESERVE[diff.worst_severity] : 0;
  const uncertainty = roundHalfAway(
    Math.max(0, 1 - matchConfidence) * ONE_DOLLAR * CONFIDENCE_WEIGHT,
  );
  return Math.min(ONE_DOLLAR, base + uncertainty);
}

export function describeReserve(
  diff: SettlementDiff | null,
  matchConfidence: number,
): string {
  const parts: string[] = [];
  if (diff && diff.worst_severity !== 'IDENTICAL') {
    parts.push(`${diff.worst_severity.toLowerCase()} settlement-wording gap`);
  }
  if (matchConfidence < 1) {
    parts.push(`${Math.round((1 - matchConfidence) * 100)}% residual match uncertainty`);
  }
  if (parts.length === 0) return 'Single rule set, exact match — no reserve withheld';
  return `Withheld for ${parts.join(' and ')}`;
}
