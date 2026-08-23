import { ONE_DOLLAR, type DeciCents } from '../domain/money.js';
import type { Market, Quote } from '../domain/types.js';
import { verifyMatch } from '../match/engine.js';

/**
 * The same proposition, priced differently in two places.
 *
 * This is the scanner's twentieth signal and its most demanding, because a
 * "disagreement" between two contracts that are not actually the same
 * contract is worse than no signal at all. It therefore runs through the same
 * verification the arbitrage engine uses — the one that refuses to pair two
 * different fighters on one card, and refuses a threshold market against a
 * different strike — rather than matching on titles.
 *
 * What it reports is a *gap*, not an edge. Whether the gap is takeable is the
 * arbitrage engine's question, and it answers it with fees, depth and
 * settlement assurance that this screen deliberately does not repeat.
 */

export interface CrossMarketGap {
  left_market_id: string;
  right_market_id: string;
  left_venue: string;
  right_venue: string;
  title: string;
  left_price: DeciCents;
  right_price: DeciCents;
  /** Absolute difference in the implied probability, in deci-cents. */
  gap: DeciCents;
  /** Confidence that these are the same proposition, 0..1. */
  match_confidence: number;
  /** Which venue is cheaper to back the YES side on. */
  cheaper_venue: string;
}

export interface PricedMarket {
  market: Market;
  quote: Quote;
}

/** Below this the pairing is not trustworthy enough to call a disagreement. */
const MIN_CONFIDENCE = 0.8;

/** Below this the gap is inside the noise of two venues' tick sizes. */
const MIN_GAP = 20;

export function findCrossMarketGaps(markets: PricedMarket[]): CrossMarketGap[] {
  const out: CrossMarketGap[] = [];

  // Bucket by tier and type before pairing, which is what keeps this from
  // being quadratic across the whole exchange.
  const buckets = new Map<string, PricedMarket[]>();
  for (const entry of markets) {
    const key = `${entry.market.tier}|${entry.market.market_type}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i]!;
        const right = bucket[j]!;
        if (left.market.venue === right.market.venue) continue;

        const match = verifyMatch(left.market, right.market);
        if (match.confidence < MIN_CONFIDENCE) continue;
        if (match.contract.state === 'MISMATCHED') continue;

        const leftPrice = midOf(left.quote);
        const rightPrice = midOf(right.quote);
        if (leftPrice === null || rightPrice === null) continue;

        const gap = Math.abs(leftPrice - rightPrice);
        if (gap < MIN_GAP) continue;

        out.push({
          left_market_id: left.market.market_id,
          right_market_id: right.market.market_id,
          left_venue: left.market.venue,
          right_venue: right.market.venue,
          title: left.market.title,
          left_price: leftPrice,
          right_price: rightPrice,
          gap,
          match_confidence: match.confidence,
          cheaper_venue: leftPrice <= rightPrice ? left.market.venue : right.market.venue,
        });
      }
    }
  }

  return out.sort((a, b) => b.gap - a.gap);
}

/**
 * Mid price, so two venues are compared on the same footing.
 *
 * Comparing one venue's ask against another's mid manufactures a gap the
 * width of a spread, which on an illiquid contract is most of the "signal".
 */
function midOf(quote: Quote): DeciCents | null {
  const ask = quote.book.yes_asks[0]?.price ?? quote.ask;
  const bid = quote.book.yes_bids[0]?.price ?? quote.bid;
  if (ask !== null && bid !== null) return Math.round((ask + bid) / 2);
  if (ask !== null) return ask;
  if (bid !== null) return bid;
  // A one-sided sportsbook quote: the NO ask implies the YES price.
  const noAsk = quote.book.no_asks[0]?.price ?? quote.no_ask;
  return noAsk !== null ? ONE_DOLLAR - noAsk : null;
}
