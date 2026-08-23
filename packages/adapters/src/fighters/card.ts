import type { Market, Quote } from '@arbterminal/core';
import { ONE_DOLLAR, devig, overround, type GrapplingMismatch } from '@arbterminal/core';
import { type Fighter, isBrazilian, lookup, nameKey } from './dossier.js';

/**
 * A fight, as both venues price it and as the dossier describes it.
 *
 * This is not an arbitrage type and deliberately does not reuse the
 * arbitrage vocabulary. Nothing here is a guaranteed profit; it is a way of
 * looking at a card. The three-status language on the other tabs means
 * something precise, and borrowing it for "these two prices differ" would
 * make it mean nothing.
 */

export interface VenuePrice {
  venue: string;
  /** Cost of backing this fighter, in deci-cents. */
  price: number;
  /** Depth available at the quoted price. */
  size: number;
}

export interface FightSide {
  name: string;
  fighter: Fighter | null;
  prices: VenuePrice[];
  /** Cheapest venue for backing this fighter. */
  best: VenuePrice | null;
}

export interface FightCard {
  fight_id: string;
  title: string;
  /** ISO date of the contest, best available. */
  when: string | null;
  sides: [FightSide, FightSide];
  /**
   * Difference between the two venues' prices for the same fighter, in
   * deci-cents, taken over whichever side has quotes from both. Null when
   * only one venue prices the fight.
   */
  divergence: number | null;
  /**
   * The grappling read, when both fighters have career statistics.
   *
   * This replaces the old style-label comparison entirely. A belt is not a
   * behaviour, and the previous flag treated a submission specialist who
   * never shoots as the wrestler in a striker-versus-grappler matchup — the
   * one reading that inverts the whole thesis.
   */
  mismatch: GrapplingMismatch | null;
  /**
   * Nationality flag, carried for scouting and given no predictive weight
   * anywhere. Brazil produces outstanding grapplers; being Brazilian is not
   * evidence that this particular fighter is one.
   */
  brazilian: boolean;
  venues: string[];
  /**
   * What the market thinks, de-vigged, per side.
   *
   * Kept beside the grappling read rather than combined with it. A fighter
   * being likely to win does not make his price a good one, and a screen that
   * multiplied a style score by a probability would be asserting an edge that
   * nothing here has established. The two numbers are shown; the reader
   * decides whether they disagree in an interesting way.
   */
  market: FightMarketRead | null;
}

export interface FightMarketRead {
  /** Implied probability for each side after the margin is removed. */
  fair: [number, number];
  /** Total implied probability before de-vigging. Above 1 is the margin. */
  overround: number;
  venue: string;
  /** Present when the grappling read and the market point different ways. */
  tension: string | null;
}

interface Priced {
  market: Market;
  quote: Quote;
}

/** Backing a fighter costs the YES ask on their own market. */
function askFor(entry: Priced): VenuePrice | null {
  const level = entry.quote.book.yes_asks[0];
  if (!level) return null;
  return { venue: entry.market.venue, price: level.price, size: level.size };
}

/** Backing the *other* fighter on a two-named market costs the NO ask. */
function complementAskFor(entry: Priced): VenuePrice | null {
  const level = entry.quote.book.no_asks[0];
  if (!level) return null;
  return { venue: entry.market.venue, price: level.price, size: level.size };
}

function bestOf(prices: VenuePrice[]): VenuePrice | null {
  let best: VenuePrice | null = null;
  for (const p of prices) if (!best || p.price < best.price) best = p;
  return best;
}

/**
 * Group GAME-tier markets into fights.
 *
 * The two venues describe a bout differently — Kalshi lists each fighter as
 * their own market, Polymarket lists one market with both names on it — so
 * the grouping key is the unordered pair of fighter names rather than
 * anything either venue calls the event.
 */
export function buildFightCards(
  entries: Priced[],
  dossier: Map<string, Fighter>,
): FightCard[] {
  const byPair = new Map<string, { names: [string, string]; entries: Priced[]; when: string | null }>();

  for (const entry of entries) {
    if (entry.market.tier !== 'GAME') continue;
    const a = entry.market.outcome_label.trim();
    const b = (entry.market.complement_label ?? '').trim();
    if (a === '') continue;

    // Only a market naming both sides establishes who is fighting whom. A
    // one-sided listing joins a pair that a two-sided listing has defined.
    if (b === '') continue;
    const key = [nameKey(a), nameKey(b)].sort().join('|');
    const existing = byPair.get(key);
    if (existing) existing.entries.push(entry);
    else byPair.set(key, { names: [a, b], entries: [entry], when: entry.market.close_time });
  }

  // Second pass: attach one-sided listings to a pair already established.
  const keyByFighter = new Map<string, string>();
  for (const [key, group] of byPair) {
    for (const name of group.names) keyByFighter.set(nameKey(name), key);
  }
  for (const entry of entries) {
    if (entry.market.tier !== 'GAME') continue;
    if ((entry.market.complement_label ?? '').trim() !== '') continue;
    const key = keyByFighter.get(nameKey(entry.market.outcome_label));
    if (key) byPair.get(key)!.entries.push(entry);
  }

  const cards: FightCard[] = [];
  for (const [key, group] of byPair) {
    const [nameA, nameB] = group.names;
    const pricesA: VenuePrice[] = [];
    const pricesB: VenuePrice[] = [];

    for (const entry of group.entries) {
      const label = nameKey(entry.market.outcome_label);
      const yes = askFor(entry);
      const no = complementAskFor(entry);
      const hasComplement = (entry.market.complement_label ?? '').trim() !== '';

      if (label === nameKey(nameA)) {
        if (yes) pricesA.push(yes);
        if (no && hasComplement) pricesB.push(no);
      } else if (label === nameKey(nameB)) {
        if (yes) pricesB.push(yes);
        if (no && hasComplement) pricesA.push(no);
      }
    }

    const fighterA = lookup(dossier, nameA);
    const fighterB = lookup(dossier, nameB);

    const sides: [FightSide, FightSide] = [
      { name: nameA, fighter: fighterA, prices: pricesA, best: bestOf(pricesA) },
      { name: nameB, fighter: fighterB, prices: pricesB, best: bestOf(pricesB) },
    ];

    const venues = [...new Set(group.entries.map((e) => e.market.venue))].sort();

    cards.push({
      fight_id: key,
      title: `${nameA} vs. ${nameB}`,
      when: group.when,
      sides,
      divergence: divergenceOf(sides),
      mismatch: null,
      market: marketRead(sides),
      brazilian: (fighterA ? isBrazilian(fighterA) : false) || (fighterB ? isBrazilian(fighterB) : false),
      venues,
    });
  }

  return cards.sort((a, b) => (b.divergence ?? -1) - (a.divergence ?? -1));
}

/**
 * How far apart the venues are on the same fighter.
 *
 * Taken per side and maxed, because a disagreement shows up on whichever
 * fighter both venues happen to quote. This is a spread, not an edge — it
 * says nothing about whether the two prices can be traded against each other,
 * which is the arbitrage engine's question and is answered elsewhere.
 */
function divergenceOf(sides: [FightSide, FightSide]): number | null {
  let widest: number | null = null;
  for (const side of sides) {
    const byVenue = new Map<string, number>();
    for (const p of side.prices) {
      const current = byVenue.get(p.venue);
      if (current === undefined || p.price < current) byVenue.set(p.venue, p.price);
    }
    if (byVenue.size < 2) continue;
    const values = [...byVenue.values()];
    const gap = Math.max(...values) - Math.min(...values);
    if (widest === null || gap > widest) widest = gap;
  }
  return widest;
}

/**
 * A grappler against a striker.
 *
 * Both sides have to be classified. One known and one unknown is not a
 * clash — it is a fighter whose bio says "MMA", which is roughly half of
 * them, and calling that a stylistic matchup would be inventing the very
 * read the tab is supposed to surface.
 */
export function isStyleClash(a: Fighter | null, b: Fighter | null): boolean {
  if (!a || !b) return false;
  if (a.style_class === 'UNKNOWN' || b.style_class === 'UNKNOWN') return false;
  return a.style_class !== b.style_class;
}

/**
 * De-vig both sides of a fight, using the best price available for each.
 *
 * Uses the same de-vigging as the rest of the package. Returns null unless
 * both sides are priced, because half a book is not a probability.
 */
function marketRead(sides: [FightSide, FightSide]): FightMarketRead | null {
  const a = sides[0].best;
  const b = sides[1].best;
  if (!a || !b) return null;

  const implied = [a.price / ONE_DOLLAR, b.price / ONE_DOLLAR];
  const total = overround(implied);
  if (!(total > 0)) return null;
  const fair = devig(implied);

  return {
    fair: [fair[0]!, fair[1]!],
    overround: total,
    venue: a.venue === b.venue ? a.venue : `${a.venue} / ${b.venue}`,
    tension: null,
  };
}

/**
 * Note when the grappling read and the price point in different directions.
 *
 * Attached after the mismatch is computed, since the card is built before the
 * career statistics arrive. Says only that the two disagree — whether that is
 * an opportunity or a sign the model is missing something the market can see
 * is exactly the question this app does not answer for anybody.
 */
export function attachMarketTension(card: FightCard): void {
  const m = card.mismatch;
  const market = card.market;
  if (!m || !market || m.no_grappler || !m.grappler) return;

  const grapplerIndex = card.sides[0].name === m.grappler ? 0 : 1;
  const grapplerProbability = market.fair[grapplerIndex]!;

  if (m.score >= 60 && grapplerProbability < 0.45) {
    market.tension =
      `The grappling read is lopsided toward ${m.grappler} at ${m.score}/100, and the market ` +
      `has him at ${Math.round(grapplerProbability * 100)}%. Worth understanding why before ` +
      `assuming either is wrong.`;
  } else if (m.score <= 30 && grapplerProbability > 0.7) {
    market.tension =
      `The market strongly favours ${m.grappler} at ${Math.round(grapplerProbability * 100)}% ` +
      `while the grappling read finds little asymmetry — the case for him is likely something ` +
      `this model does not measure.`;
  }
}
