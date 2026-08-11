/**
 * All contract prices in this system are integers in *deci-cents* (dc):
 * 1 dollar = 1000 dc, 1 cent = 10 dc.
 *
 * Kalshi quotes some series on a deci-cent grid (`price_level_structure:
 * "deci_cent"`), so cents are not fine enough, and binary floats are not
 * exact enough — `0.1 + 0.2 !== 0.3` is not an acceptable property for code
 * that decides whether a basket costs less than a guaranteed dollar payout.
 * Every price, cost and edge is therefore an integer until the moment it is
 * formatted for display.
 */

/** Price of one contract, in deci-cents. A binary contract settles at 0 or ONE_DOLLAR. */
export type DeciCents = number;

export const ONE_DOLLAR: DeciCents = 1000;

/** Money amounts (stakes, P/L, bankroll) are also integers in deci-cents. */
export type Money = number;

export function dollarsToDeciCents(dollars: number): DeciCents {
  return Math.round(dollars * 1000);
}

/**
 * Kalshi's JSON returns prices as fixed-point *strings* ("0.8900"). Parsing
 * via `Number` then multiplying re-introduces the float error we are trying
 * to avoid, so scale the decimal digits directly.
 */
export function parseDecimalToDeciCents(value: string | number): DeciCents {
  if (typeof value === 'number') return dollarsToDeciCents(value);
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', frac = ''] = unsigned.split('.');
  const padded = (frac + '000').slice(0, 3);
  const rounded = frac.length > 3 && Number(frac[3]) >= 5 ? 1 : 0;
  const magnitude = Number(whole) * 1000 + Number(padded) + rounded;
  if (!Number.isFinite(magnitude)) return 0;
  return negative ? -magnitude : magnitude;
}

export function deciCentsToDollars(dc: DeciCents): number {
  return dc / 1000;
}

/** "$0.8900" — used for prices, where the extra digit carries information. */
export function formatPrice(dc: DeciCents): string {
  const sign = dc < 0 ? '-' : '';
  const abs = Math.abs(dc);
  return `${sign}$${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}0`;
}

/** "$12.34" — used for money amounts, where cents are enough. */
export function formatMoney(dc: Money): string {
  const sign = dc < 0 ? '-' : '';
  const cents = Math.round(Math.abs(dc) / 10);
  return `${sign}$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
}

/** Implied probability as a 0..1 fraction, derived from a deci-cent price. */
export function priceToProbability(dc: DeciCents): number {
  return dc / ONE_DOLLAR;
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Round half away from zero. `Math.round` rounds -0.5 to -0, which skews P/L. */
export function roundHalfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
