/**
 * Stable, content-derived identifiers.
 *
 * An opportunity keeps the same id across polling cycles as long as its legs
 * are the same, so the UI can track one card through repricing instead of
 * seeing it vanish and reappear. That means ids must be a pure function of
 * content — never of time or insertion order.
 */

/** FNV-1a, 32-bit. Not cryptographic; only needs to be stable and cheap. */
export function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

export function opportunityId(type: string, legKeys: string[]): string {
  return `opp_${type.toLowerCase()}_${hash32([type, ...legKeys.slice().sort()].join('|'))}`;
}

export function marketId(venue: string, venueMarketId: string): string {
  return `${venue}:${venueMarketId}`;
}

export function quoteId(marketId: string, timestamp: string): string {
  return `q_${hash32(`${marketId}@${timestamp}`)}`;
}

let tradeCounter = 0;

/** Paper trades are user actions, so a monotonic id is correct here. */
export function tradeId(now: Date = new Date()): string {
  tradeCounter += 1;
  return `pt_${now.getTime().toString(36)}_${tradeCounter.toString(36)}`;
}
