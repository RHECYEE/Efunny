import { formatMoney, formatPercent, formatPrice, type DeciCents } from '@arbterminal/core';

export { formatMoney, formatPrice, formatPercent };

/** Edges are quoted in cents per $1 of payout — the unit traders think in. */
export function formatEdge(deciCents: DeciCents): string {
  const sign = deciCents > 0 ? '+' : '';
  return `${sign}${(deciCents / 10).toFixed(2)}¢`;
}

export function edgeClass(deciCents: number): string {
  if (deciCents > 0) return 'pos';
  if (deciCents < 0) return 'neg';
  return 'muted';
}

export function formatRoi(fraction: number): string {
  return `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(2)}%`;
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function formatCountdown(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 0) return 'closed';
  const days = Math.floor(ms / 86_400_000);
  if (days > 365) return `${(days / 365).toFixed(1)}y`;
  if (days > 0) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

export function formatSize(contracts: number): string {
  if (contracts >= 100_000) return `${(contracts / 1000).toFixed(0)}k`;
  if (contracts >= 1000) return `${(contracts / 1000).toFixed(1)}k`;
  return contracts.toFixed(contracts < 10 ? 2 : 0);
}

export function confidenceClass(confidence: number): string {
  if (confidence >= 1) return 'exact';
  if (confidence >= 0.95) return 'high';
  return 'review';
}

/** Only these two types describe a position with a guaranteed payoff. */
export function isHedged(type: string): boolean {
  return type === 'GUARANTEED_ARB' || type === 'CROSS_VENUE_ARB';
}

/**
 * Colour for the headline edge. Profit green is reserved for positions that
 * actually have a guaranteed payoff — an unhedged divergence rendered in the
 * same green reads as money that is not there.
 */
export function headlineEdgeClass(type: string, deciCents: number): string {
  if (!isHedged(type)) return `pill-tone ${type}`;
  return edgeClass(deciCents);
}

/** What the bottom line of the cost stack actually measures. */
export function edgeLabel(type: string): string {
  switch (type) {
    case 'NEAR_ARB':
      return 'Executable edge (negative — costs exceed the spread)';
    case 'RELATIVE_VALUE':
      return 'Divergence after costs';
    default:
      return 'Executable edge';
  }
}

export function typeLabel(type: string): string {
  switch (type) {
    case 'GUARANTEED_ARB':
      return 'GUARANTEED';
    case 'CROSS_VENUE_ARB':
      return 'CROSS-VENUE';
    case 'NEAR_ARB':
      return 'NEAR ARB';
    case 'RELATIVE_VALUE':
      return 'REL VALUE';
    default:
      return type;
  }
}

/** Dollar input from the user, converted to the engine's deci-cents. */
export function dollarsToDeciCents(dollars: number): number {
  return Math.round(dollars * 1000);
}
