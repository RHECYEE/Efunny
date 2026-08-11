import { ONE_DOLLAR, roundHalfAway, type DeciCents } from '../domain/money.js';

/**
 * Odds → probability conversion. Sportsbook feeds quote American or decimal
 * odds; event contracts quote a price that *is* a probability. Everything
 * downstream of this file works in contract-price space.
 */

export function americanToDecimal(american: number): number {
  if (american === 0 || !Number.isFinite(american)) {
    throw new RangeError(`invalid American odds: ${american}`);
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function decimalToAmerican(decimal: number): number {
  if (decimal <= 1) throw new RangeError(`invalid decimal odds: ${decimal}`);
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

/**
 * Raw implied probability, vig included. This is what the book charges, so it
 * is the correct number for cost comparisons — de-vigged numbers are for
 * *fair value* comparisons only and must never be used as a purchase price.
 */
export function decimalToImpliedProbability(decimal: number): number {
  if (decimal <= 1) throw new RangeError(`invalid decimal odds: ${decimal}`);
  return 1 / decimal;
}

export function americanToImpliedProbability(american: number): number {
  return decimalToImpliedProbability(americanToDecimal(american));
}

/**
 * A sportsbook price expressed as the cost of $1 of payout, so it lines up
 * with an event contract. Decimal 1.91 → 0.5236 → 524 dc.
 */
export function decimalToContractPrice(decimal: number): DeciCents {
  return roundHalfAway(decimalToImpliedProbability(decimal) * ONE_DOLLAR);
}

export function americanToContractPrice(american: number): DeciCents {
  return decimalToContractPrice(americanToDecimal(american));
}

/** Sum of implied probabilities across a market's outcomes, e.g. 1.045. */
export function overround(impliedProbabilities: number[]): number {
  return impliedProbabilities.reduce((sum, p) => sum + p, 0);
}

/** The book's margin as a fraction, e.g. 0.045 for a 4.5% hold. */
export function vig(impliedProbabilities: number[]): number {
  return overround(impliedProbabilities) - 1;
}

export type DevigMethod = 'MULTIPLICATIVE' | 'ADDITIVE' | 'POWER';

/**
 * Strip the book's margin to estimate a fair probability. Used only for
 * RELATIVE_VALUE comparisons and consensus probability display — never in a
 * guaranteed-arbitrage calculation, where the vigged price is the real cost.
 */
export function devig(
  impliedProbabilities: number[],
  method: DevigMethod = 'MULTIPLICATIVE',
): number[] {
  const total = overround(impliedProbabilities);
  if (total <= 0) return impliedProbabilities.map(() => 0);
  const n = impliedProbabilities.length;

  switch (method) {
    case 'ADDITIVE': {
      const excess = (total - 1) / n;
      return impliedProbabilities.map((p) => Math.max(0, p - excess));
    }
    case 'POWER': {
      // Solve for k such that sum(p_i^k) == 1, by bisection. Deterministic:
      // fixed iteration count, no early exit on floating-point equality.
      let lo = 0.5;
      let hi = 2.5;
      for (let i = 0; i < 80; i += 1) {
        const mid = (lo + hi) / 2;
        const s = impliedProbabilities.reduce((acc, p) => acc + Math.pow(p, mid), 0);
        if (s > 1) lo = mid;
        else hi = mid;
      }
      const k = (lo + hi) / 2;
      const powered = impliedProbabilities.map((p) => Math.pow(p, k));
      const scale = powered.reduce((a, b) => a + b, 0);
      return powered.map((p) => p / scale);
    }
    case 'MULTIPLICATIVE':
    default:
      return impliedProbabilities.map((p) => p / total);
  }
}

/**
 * Consensus probability across venues, weighted by each venue's inverse
 * spread — a tight two-sided market is more informative than a wide one.
 */
export function consensusProbability(
  observations: Array<{ probability: number; spread: number }>,
): number | null {
  const usable = observations.filter((o) => Number.isFinite(o.probability));
  if (usable.length === 0) return null;
  let weightSum = 0;
  let acc = 0;
  for (const o of usable) {
    // +1 keeps a zero-spread observation from taking infinite weight.
    const weight = 1 / (Math.max(0, o.spread) + 1);
    acc += o.probability * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? acc / weightSum : null;
}
