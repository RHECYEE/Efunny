/**
 * The grappling mismatch.
 *
 * The thesis this scores is specific: a dangerous striker with questionable
 * anti-wrestling against someone who will keep shooting. It is *not* "a BJJ
 * fighter against a striker", and the difference matters more than anything
 * else in this file. A submission grappler who cannot reliably force the
 * fight to the floor is not the wrestler in that thesis — against a superior
 * striker he is on the wrong end of it — so the grappler is identified by
 * takedown pressure, which is behaviour, and never by a style label, which is
 * a description of a belt.
 *
 * Two further rules that follow from the same instinct:
 *
 *   - Takedown defence without a denominator is not evidence. 85% against
 *     seven career attempts and 85% against fifty are different claims, and
 *     the first is mostly an accident of who a fighter has faced.
 *   - Putting somebody on the floor is not the same as doing something there.
 *     Judging rewards effective grappling, so submission threat and ground
 *     offence carry weight of their own rather than being assumed from a
 *     takedown count.
 *
 * Nothing here knows a fighter's nationality, and nothing here should.
 */

export interface FighterStats {
  name: string;
  /** Takedowns landed per 15 minutes. */
  td_per15: number | null;
  td_accuracy: number | null;
  td_defence: number | null;
  sub_per15: number | null;
  slpm: number | null;
  sapm: number | null;
  strike_accuracy: number | null;
  strike_defence: number | null;
  reach_inches: number | null;
  height_inches: number | null;
  /** Derived from the fight history, not the career box. */
  fights_counted: number;
  takedowns_conceded: number;
  knockdowns_landed: number;
  knockdowns_absorbed: number;
  /** Wins by knockout or technical knockout. */
  ko_wins: number;
  submission_wins: number;
  wins: number;
}

export type GrappleRole = 'GRAPPLER' | 'STRIKER' | 'NEITHER';

export interface MismatchComponent {
  name: string;
  label: string;
  /** 0..1, already oriented so higher means a wider mismatch. */
  value: number | null;
  weight: number;
  detail: string;
}

export interface GrapplingMismatch {
  /** 0..100. Higher means a more lopsided grappling matchup. */
  score: number;
  /** Which fighter is the takedown threat, if either is. */
  grappler: string | null;
  striker: string | null;
  role_basis: string;
  components: MismatchComponent[];
  /** Plain statements of what could not be measured. */
  not_modelled: string[];
  /** True when neither fighter meaningfully forces the fight to the floor. */
  no_grappler: boolean;
}

/**
 * Below this, a fighter is not forcing anything.
 *
 * Roughly one takedown per fifteen minutes. A "grappler" under this number is
 * someone who grapples when the other man agrees to, which is exactly the
 * fighter this model must refuse to treat as the wrestler.
 */
const TD_PRESSURE_FLOOR = 1.0;

/** Clamp to 0..1. */
const unit = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Takedown attempts an opponent has faced, recovered from the two numbers
 * that are published.
 *
 * Defence is the share of attempts that did not land, and the fight history
 * gives how many did. So attempts = landed / (1 - defence). It is an estimate
 * over the bouts the table lists rather than a career total, but it converts
 * a bare percentage into something with a sample size behind it — which is
 * the difference between a defensible read and a number.
 */
export function estimateAttemptsFaced(stats: FighterStats): number | null {
  const def = stats.td_defence;
  if (def === null || def >= 1) return null;
  if (stats.fights_counted === 0) return null;
  return stats.takedowns_conceded / (1 - def);
}

/**
 * Whether a fighter's record is worth reading at all.
 *
 * A profile with no bouts behind it has no takedown defence to report — it
 * has an absence — and every component that quietly reads zero from it turns
 * that absence into an assertion.
 */
export function hasUsableRecord(stats: FighterStats): boolean {
  return stats.fights_counted > 0 && stats.td_per15 !== null;
}

/**
 * How much to believe a takedown-defence figure.
 *
 * Full weight at roughly forty attempts faced, negligible below ten. Without
 * this, a fighter who has simply never been shot on reads as impossible to
 * take down.
 */
export function defenceConfidence(attempts: number | null): number {
  if (attempts === null) return 0.25;
  return unit((attempts - 5) / 35);
}

/** Takedown pressure, as a 0..1 reading. Two per fifteen is already high. */
function pressure(stats: FighterStats): number {
  return unit((stats.td_per15 ?? 0) / 3);
}

/** Which fighter, if either, is the one imposing grappling. */
export function assignRoles(
  a: FighterStats,
  b: FighterStats,
): { grappler: FighterStats | null; striker: FighterStats | null; basis: string } {
  const pa = a.td_per15 ?? 0;
  const pb = b.td_per15 ?? 0;

  if (pa < TD_PRESSURE_FLOOR && pb < TD_PRESSURE_FLOOR) {
    return {
      grappler: null,
      striker: null,
      basis:
        `Neither fighter averages a takedown per 15 minutes (${pa.toFixed(2)} and ` +
        `${pb.toFixed(2)}), so nobody here is forcing the fight to the floor. A grappling ` +
        `mismatch needs someone willing to shoot.`,
    };
  }

  const [grappler, striker] = pa >= pb ? [a, b] : [b, a];
  return {
    grappler,
    striker,
    basis:
      `${grappler.name} lands ${(grappler.td_per15 ?? 0).toFixed(2)} takedowns per 15 ` +
      `minutes against ${(striker.td_per15 ?? 0).toFixed(2)} — the takedown pressure, not a ` +
      `style label, is what makes him the grappler here.`,
  };
}

export function computeMismatch(a: FighterStats, b: FighterStats): GrapplingMismatch {
  const notModelled = [
    'Get-up ability and time spent controlled on the floor — UFCStats publishes control time per bout but not as a career figure, and it is not summarised here.',
    'Whether the grappler re-shoots after a stuffed attempt, which is the difference between pressure and a single look.',
    'Entry vulnerability: whether the grappler gets hit or rocked while closing distance.',
    'Cardio, short-notice replacement, weight-cut trouble, camp changes and layoffs.',
  ];

  // No record, no read. Scoring a blank profile produces sentences like
  // "0% of takedowns stopped across 0 fights", which is a failed page load
  // wearing the clothes of a scouting report.
  if (!hasUsableRecord(a) || !hasUsableRecord(b)) {
    return {
      score: 0,
      grappler: null,
      striker: null,
      role_basis:
        'No usable career record for at least one of these fighters, so there is nothing ' +
        'here to read. Nothing is assumed in its place.',
      components: [],
      not_modelled: notModelled,
      no_grappler: true,
    };
  }

  const { grappler, striker, basis } = assignRoles(a, b);

  if (!grappler || !striker) {
    return {
      score: 0,
      grappler: null,
      striker: null,
      role_basis: basis,
      components: [],
      not_modelled: notModelled,
      no_grappler: true,
    };
  }

  const attempts = estimateAttemptsFaced(striker);
  const confidence = defenceConfidence(attempts);
  const components: MismatchComponent[] = [];

  components.push({
    name: 'td_pressure',
    label: 'Grappler takedown pressure',
    value: pressure(grappler),
    weight: 0.28,
    detail: `${(grappler.td_per15 ?? 0).toFixed(2)} takedowns per 15 minutes.`,
  });

  components.push({
    name: 'td_accuracy',
    label: 'Entry efficiency',
    value: grappler.td_accuracy,
    weight: 0.1,
    detail:
      grappler.td_accuracy === null
        ? 'Not published.'
        : `${Math.round(grappler.td_accuracy * 100)}% of his attempts land.`,
  });

  /**
   * The striker's takedown defence, weighted by how much of it has been
   * tested. A high percentage over few attempts is pulled back toward
   * neutral rather than believed.
   */
  const rawDefenceGap = striker.td_defence === null ? null : 1 - striker.td_defence;
  components.push({
    name: 'td_defence',
    label: 'Striker takedown defence',
    value:
      rawDefenceGap === null ? null : unit(0.5 + (rawDefenceGap - 0.5) * confidence),
    weight: 0.26,
    detail:
      striker.td_defence === null
        ? 'Not published.'
        : `${Math.round(striker.td_defence * 100)}% stopped, off roughly ` +
          `${attempts === null ? 'an unknown number of' : Math.round(attempts)} attempts faced ` +
          `across ${striker.fights_counted} listed fights` +
          (confidence < 0.5
            ? ' — too few to lean on, so this is discounted toward neutral.'
            : '.'),
  });

  const concededPerFight =
    striker.fights_counted > 0 ? striker.takedowns_conceded / striker.fights_counted : null;
  components.push({
    name: 'conceded',
    label: 'Takedowns conceded per fight',
    value: concededPerFight === null ? null : unit(concededPerFight / 3),
    weight: 0.14,
    detail:
      concededPerFight === null
        ? 'No fight history to count.'
        : `${concededPerFight.toFixed(1)} per fight across ${striker.fights_counted} bouts — ` +
          `what actually happened, rather than a percentage.`,
  });

  components.push({
    name: 'submission_threat',
    label: 'Grappler submission threat',
    value: unit((grappler.sub_per15 ?? 0) / 2),
    weight: 0.1,
    detail:
      `${(grappler.sub_per15 ?? 0).toFixed(1)} submission attempts per 15 minutes` +
      (grappler.submission_wins > 0 ? `, ${grappler.submission_wins} wins by submission.` : '.'),
  });

  /**
   * The striker's power, which cuts the other way.
   *
   * The wrestler has to get through him to do any of the above, so a heavy
   * puncher narrows the mismatch no matter how one-sided the grappling looks
   * on paper. Oriented negatively: high danger reduces the score.
   */
  const koRate = striker.wins > 0 ? striker.ko_wins / striker.wins : null;
  const knockdownRate =
    striker.fights_counted > 0 ? striker.knockdowns_landed / striker.fights_counted : null;
  const danger =
    koRate === null && knockdownRate === null
      ? null
      : unit(((koRate ?? 0) * 0.6 + unit((knockdownRate ?? 0) / 0.8) * 0.4));
  components.push({
    name: 'standing_danger',
    label: 'Standing danger to the grappler',
    value: danger === null ? null : 1 - danger,
    weight: 0.12,
    detail:
      danger === null
        ? 'Not enough history to judge.'
        : `${striker.ko_wins} of ${striker.wins} wins by knockout, ` +
          `${(knockdownRate ?? 0).toFixed(2)} knockdowns per fight. He has to be got through ` +
          `first, and that narrows the mismatch.`,
  });

  return {
    score: Math.round(weightedScore(components) * 100),
    grappler: grappler.name,
    striker: striker.name,
    role_basis: basis,
    components,
    not_modelled: notModelled,
    no_grappler: false,
  };
}

/**
 * Weighted mean over the components that have a value.
 *
 * Missing components are dropped and the weights renormalised rather than
 * being scored as zero — an unpublished statistic is not evidence of a weak
 * matchup, and treating it as one would systematically bury every fight
 * involving a fighter the site has thin data on.
 */
function weightedScore(components: MismatchComponent[]): number {
  let total = 0;
  let weight = 0;
  for (const c of components) {
    if (c.value === null) continue;
    total += c.value * c.weight;
    weight += c.weight;
  }
  return weight === 0 ? 0 : total / weight;
}

/** How lopsided, in words. */
export function mismatchLabel(score: number): string {
  if (score >= 75) return 'Severe';
  if (score >= 60) return 'Large';
  if (score >= 45) return 'Moderate';
  if (score >= 30) return 'Slight';
  return 'Minimal';
}
