import { ONE_DOLLAR, type DeciCents } from '../domain/money.js';
import { devig, overround } from '../normalize/odds.js';

/**
 * The market, read *after* the model has spoken.
 *
 * The ordering is the whole point and is enforced by keeping this in its own
 * file with its own input: the projection is computed from statistics alone,
 * and only then is the price fetched and compared. A model that sees the line
 * first will agree with it, and will agree hardest in exactly the cases where
 * agreement carries no information.
 *
 * The comparison also refuses to report an "edge". Disagreeing with a market
 * is not the same as being right, and a screen that turns a four-point
 * difference into an expected-value figure is claiming the model is better
 * than the price — which nothing here has established.
 */

export interface MarketQuote {
  venue: string;
  /** Cost of backing the home team, in deci-cents. */
  home_price: DeciCents;
  /** Cost of backing the away team, in deci-cents. */
  away_price: DeciCents;
}

export interface MarketComparison {
  venue: string;
  /** Raw implied probability before the overround is removed. */
  raw_home_probability: number;
  /** After removing the bookmaker's margin. */
  fair_home_probability: number;
  /** Total implied probability across both sides. Above 1 is the margin. */
  overround: number;
  /** Model probability minus the market's, in percentage points. */
  disagreement_points: number;
  /** Which side the model is higher on. */
  model_leans: 'HOME' | 'AWAY' | 'ALIGNED';
  note: string;
}

/**
 * Strip the margin so the two numbers are comparable.
 *
 * A book's two prices sum to more than a dollar, and comparing a model
 * probability against an un-devigged one manufactures a disagreement the
 * width of the margin on every single game. This reuses the package's
 * existing de-vigging rather than adding a second one, so the whole codebase
 * removes a margin exactly one way.
 */
export function fairHomeProbability(
  homePrice: DeciCents,
  awayPrice: DeciCents,
): { fair_home: number; overround: number } {
  const implied = [homePrice / ONE_DOLLAR, awayPrice / ONE_DOLLAR];
  const total = overround(implied);
  if (total <= 0) return { fair_home: 0.5, overround: 1 };
  return { fair_home: devig(implied)[0]!, overround: total };
}

export function compareToMarket(
  modelHomeProbability: number,
  quote: MarketQuote,
): MarketComparison {
  const { fair_home, overround: total } = fairHomeProbability(quote.home_price, quote.away_price);
  const points = Math.round((modelHomeProbability - fair_home) * 1000) / 10;

  const leans: MarketComparison['model_leans'] =
    Math.abs(points) < 2 ? 'ALIGNED' : points > 0 ? 'HOME' : 'AWAY';

  const note =
    leans === 'ALIGNED'
      ? 'The model and the market agree, which is the usual and least interesting outcome.'
      : `The model is ${Math.abs(points).toFixed(1)} points ${points > 0 ? 'higher' : 'lower'} ` +
        `on the home side than the de-vigged price. That is a disagreement, not an edge — the ` +
        `market prices these for a living and this model is four statistics and a home-field ` +
        `constant.`;

  return {
    venue: quote.venue,
    raw_home_probability: quote.home_price / ONE_DOLLAR,
    fair_home_probability: fair_home,
    overround: total,
    disagreement_points: points,
    model_leans: leans,
    note,
  };
}
