export { formatMoney, formatPrice } from '@arbterminal/core';

/** Edges read in cents per $1 of payout — the unit traders think in. */
export function formatEdge(deciCents: number): string {
  return `${deciCents > 0 ? '+' : ''}${(deciCents / 10).toFixed(2)}¢`;
}
