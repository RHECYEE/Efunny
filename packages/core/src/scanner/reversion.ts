import type { MarketMetrics } from './metrics.js';
import { DAY, type MarketHistory, mean, window } from './series.js';

/**
 * Mean reversion, as a score rather than a badge.
 *
 * The shape being looked for is specific: a market that moved violently, whose
 * volume has since dried up, whose resting size now leans back against the
 * move, and which sits well away from where it has spent the last month. Any
 * one of those alone is nothing. A price seven points below its thirty-day
 * average is not "due" — it may simply have repriced on news, permanently,
 * and the average is the stale number.
 *
 * That caveat is why this is scored and shown rather than acted on. It says a
 * market has the *shape* of an overreaction, which is a reason to go and look
 * at why it moved, and never on its own a reason to fade it.
 */

export interface ReversionRead {
  /** 0..100. Higher means more of the reversion shape is present. */
  score: number;
  /** Deci-cents away from the 30-day average. Signed. */
  distance_from_average: number | null;
  /** The 30-day average price, in deci-cents. */
  average_price: number | null;
  components: Array<{ label: string; present: boolean; detail: string }>;
}

export function computeReversion(
  metrics: MarketMetrics,
  history: MarketHistory,
): ReversionRead {
  const points = window(history, 30 * DAY);
  const average = points.length >= 12 ? mean(points.map((p) => p.price)) : null;
  const price = metrics.price;
  const distance = average !== null && price !== null ? price - average : null;

  const move = metrics.move_24h?.change ?? 0;
  const imbalance = metrics.book.imbalance;

  const components = [
    {
      label: 'Moved sharply',
      present: metrics.percentiles.move_24h >= 0.8 && Math.abs(move) > 0,
      detail:
        `24h move sits in the ${Math.round(metrics.percentiles.move_24h * 100)}th percentile ` +
        `of this market's own daily moves.`,
    },
    {
      label: 'Volume has subsided',
      present: metrics.has_volume_data && (metrics.volume_acceleration ?? 1) < 1.2,
      detail: metrics.has_volume_data
        ? `Volume back to ${(metrics.volume_acceleration ?? 1).toFixed(1)}x normal — the spike ` +
          `that carried the move is over.`
        : 'This venue publishes no volume, so the spike cannot be checked.',
    },
    {
      label: 'Book leans against the move',
      present:
        imbalance !== null && Math.abs(imbalance) >= 0.2 && Math.sign(imbalance) !== Math.sign(move),
      detail:
        imbalance === null
          ? 'No book imbalance available.'
          : `Resting size leans ${imbalance > 0 ? 'toward the bid' : 'toward the ask'}, ` +
            `${Math.sign(imbalance) !== Math.sign(move) ? 'against' : 'with'} the recent move.`,
    },
    {
      label: 'Away from its own average',
      present: distance !== null && Math.abs(distance) >= 30,
      detail:
        distance === null
          ? 'Not enough history for a 30-day average.'
          : `${(Math.abs(distance) / 10).toFixed(1)} points ${distance > 0 ? 'above' : 'below'} ` +
            `the 30-day average. Being far from an average is not by itself a reason to expect ` +
            `a return to it.`,
    },
  ];

  const present = components.filter((c) => c.present).length;
  // All four is the shape; three is suggestive; fewer is noise.
  const score = Math.round((present / components.length) * 100);

  return {
    score,
    distance_from_average: distance === null ? null : Math.round(distance),
    average_price: average === null ? null : Math.round(average),
    components,
  };
}
