/**
 * A matchup projection, stated in the open.
 *
 * This produces a number, which means it is a model, which means the only
 * honest way to ship it is with every assumption on the surface. There is no
 * fitted machine here and no hidden weights: expected points are each
 * offence's scoring rate adjusted for what the opposing defence actually
 * allows, plus a home-field constant, and the win probability is that margin
 * pushed through a logistic whose scale is the well-known spread of NFL
 * results around the line.
 *
 * Two rules the caller must respect:
 *
 *   - The projection is computed *before* the market is consulted. A model
 *     that has seen the spread first is a slower way of reproducing the
 *     spread, and it will agree with the book precisely when agreement is
 *     least informative.
 *   - Confidence is about the inputs, not the output. A 61% win probability
 *     off two preseason games and a 61% off a full season are the same
 *     number and different claims.
 */

export interface TeamSeasonStats {
  team: string;
  games: number;
  points_for_per_game: number | null;
  points_against_per_game: number | null;
  yards_per_play: number | null;
  yards_per_play_allowed: number | null;
  third_down_pct: number | null;
  third_down_pct_allowed: number | null;
  red_zone_td_pct: number | null;
  red_zone_td_pct_allowed: number | null;
  turnover_margin_per_game: number | null;
  sacks_per_game: number | null;
  sacks_allowed_per_game: number | null;
  pass_yards_per_attempt: number | null;
  pass_yards_per_attempt_allowed: number | null;
  rush_yards_per_carry: number | null;
  rush_yards_per_carry_allowed: number | null;
  /** Most recent results, newest first, as point differentials. */
  recent_margins: number[];
}

export interface InjuryImpact {
  team: string;
  player: string;
  position: string;
  status: string;
  /** Estimated points of swing, by position and status. Always stated. */
  points: number;
  note: string;
}

export interface Conditions {
  /** Fahrenheit. */
  temperature: number | null;
  /** Miles per hour. */
  wind_mph: number | null;
  /** Inches in the hour of kickoff. */
  precipitation: number | null;
  indoors: boolean;
  /** Days since each team last played. */
  rest_days: [number | null, number | null];
  /** Miles the away team travelled. */
  travel_miles: number | null;
}

export interface ProjectionFactor {
  label: string;
  /** Points contributed to the home team's margin. Signed. */
  points: number;
  detail: string;
}

export interface Projection {
  home: string;
  away: string;
  home_points: number;
  away_points: number;
  /** Home margin. Positive means the home team is favoured. */
  margin: number;
  home_win_probability: number;
  confidence: 'LOW' | 'MODERATE' | 'GOOD';
  confidence_reasons: string[];
  /** Everything that moved the number, in order of size. */
  factors: ProjectionFactor[];
  why_home: string[];
  why_away: string[];
  uncertainties: string[];
  /** Statistics the data source does not publish, named rather than omitted. */
  not_modelled: string[];
}

/** League-average scoring, used as the opponent-adjustment baseline. */
export const LEAGUE_PPG = 22.5;

/**
 * Home advantage, in points.
 *
 * Around two and a half points is where the modern NFL sits — down from the
 * three that held for decades. It is a constant here rather than a per-team
 * figure because per-stadium home advantage is mostly noise over one season.
 */
export const HOME_FIELD_POINTS = 2.4;

/**
 * Standard deviation of actual margin around the expected margin.
 *
 * Roughly 13.5 points, which is the number that makes a 3-point favourite a
 * ~59% shot and a 7-point favourite a ~70% one. Getting this scale right
 * matters more than the point estimate: it is what stops a two-point edge
 * from being reported as a near-certainty.
 */
export const MARGIN_SIGMA = 13.5;

/** Logistic approximation to the normal, for margin -> win probability. */
export function marginToWinProbability(margin: number): number {
  return 1 / (1 + Math.exp((-margin * Math.PI) / (MARGIN_SIGMA * Math.sqrt(3))));
}

/**
 * Points a missing player is worth.
 *
 * A flat "injury count" treats a starting quarterback and a third safety as
 * the same event, which is the single biggest way an injury report misleads.
 * These are deliberately coarse, stated on screen, and easy to argue with —
 * which is the point. They are not fitted to anything.
 */
const POSITION_POINTS: Record<string, number> = {
  QB: 5.5,
  LT: 1.4,
  OT: 1.1,
  T: 1.1,
  C: 0.9,
  OG: 0.8,
  G: 0.8,
  OL: 1.0,
  WR: 1.0,
  RB: 0.7,
  TE: 0.6,
  EDGE: 1.2,
  DE: 1.1,
  DT: 0.9,
  CB: 1.0,
  S: 0.7,
  LB: 0.6,
  K: 0.5,
  P: 0.2,
};

/** How much of the impact lands, given the reported status. */
const STATUS_WEIGHT: Record<string, number> = {
  OUT: 1,
  'INJURED RESERVE': 1,
  IR: 1,
  PUP: 1,
  SUSPENSION: 1,
  DOUBTFUL: 0.75,
  QUESTIONABLE: 0.35,
  PROBABLE: 0.1,
  ACTIVE: 0,
  DAY_TO_DAY: 0.2,
};

export function injuryPoints(position: string, status: string): number {
  const pos = POSITION_POINTS[position.toUpperCase()] ?? 0.5;
  const weight = STATUS_WEIGHT[status.toUpperCase().replace(/[\s-]+/g, '_')] ?? 0.3;
  return pos * weight;
}

/**
 * Wind, which deserves more weight than weather generally.
 *
 * Temperature and rain barely move NFL scoring. Wind above about fifteen
 * miles an hour does, because it takes the deep passing game and the kicking
 * game away at once, and it does so symmetrically — so it comes off the total
 * rather than off one side.
 */
export function windPenalty(mph: number | null, indoors: boolean): number {
  if (indoors || mph === null) return 0;
  if (mph < 12) return 0;
  // Roughly a point of total scoring per 3 mph above 12, capped.
  return Math.min((mph - 12) / 3, 7);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Expected points for one offence against one defence.
 *
 * The adjustment is the point of it: "they average 28" is worthless without
 * knowing who they played. An offence scoring 28 against defences that
 * normally concede 26 has done a little better than nothing; the same 28
 * against defences conceding 17 is a different team.
 */
function expectedPoints(offence: TeamSeasonStats, defence: TeamSeasonStats): number | null {
  const off = offence.points_for_per_game;
  const def = defence.points_against_per_game;
  if (off === null && def === null) return null;
  if (off === null) return def;
  if (def === null) return off;
  /**
   * The mean of two views of the same matchup, and nothing further.
   *
   * An earlier version averaged these and *then* added a defence adjustment
   * on top, which counted the defence twice: the opponent's points-allowed is
   * already half the average. It pushed a bad team against a good one out to
   * a fifteen-point projected margin — wider than any line a book would post
   * — and the screen reported the resulting 89% next to a LOW confidence
   * badge, which is a contradiction a reader should never have to resolve.
   */
  return (off + def) / 2;
}

/**
 * Shrink an extreme margin toward a coin flip.
 *
 * Two teams' season averages differenced will always spread wider than real
 * results do, because team quality regresses and these inputs are historical.
 * The effect is strongest exactly where the inputs are weakest, so the
 * shrinkage is tied to the same thing confidence is: a projection built on
 * last season's roster gets pulled harder than one built on this season's
 * games.
 */
export function regressionFactor(priorSeason: boolean, games: number): number {
  if (priorSeason) return 0.62;
  if (games < 4) return 0.55;
  if (games < 8) return 0.75;
  return 0.9;
}

export interface ProjectionInput {
  home: TeamSeasonStats;
  away: TeamSeasonStats;
  injuries: InjuryImpact[];
  conditions: Conditions;
  /** True when the statistics come from a completed prior season. */
  stats_are_prior_season: boolean;
  /**
   * True when the game itself is an exhibition.
   *
   * Different from the statistics being stale, and more damaging. Starters
   * play a series or two, the result turns on fourth-string quarterbacks, and
   * regular-season team quality barely transfers. A projection here is not
   * merely uncertain — it is measuring something the game is not about.
   */
  is_exhibition?: boolean;
}

export function project(input: ProjectionInput): Projection {
  const { home, away, injuries, conditions } = input;
  const factors: ProjectionFactor[] = [];

  const rawHome = expectedPoints(home, away) ?? LEAGUE_PPG;
  const rawAway = expectedPoints(away, home) ?? LEAGUE_PPG;

  /**
   * Shrink the estimated quality gap, and only that.
   *
   * Home field, injuries and wind are separately sourced quantities with
   * their own justification — regressing them would be shrinking a constant.
   * What needs shrinking is the difference of two season averages, which is
   * the part that is an estimate of team strength and the part that spreads
   * wider than reality.
   */
  const shrink = regressionFactor(input.stats_are_prior_season, Math.min(home.games, away.games));
  const midpoint = (rawHome + rawAway) / 2;
  let homePoints = midpoint + ((rawHome - rawAway) / 2) * shrink;
  let awayPoints = midpoint - ((rawHome - rawAway) / 2) * shrink;

  factors.push({
    label: 'Opponent-adjusted scoring',
    points: homePoints - awayPoints,
    detail:
      `${home.team} ${homePoints.toFixed(1)} against ${away.team} ${awayPoints.toFixed(1)}. ` +
      `Each side's scoring rate averaged with what the other defence allows, then the gap ` +
      `shrunk ${Math.round((1 - shrink) * 100)}% — differenced season averages always spread ` +
      `wider than real results.`,
  });

  homePoints += HOME_FIELD_POINTS / 2;
  awayPoints -= HOME_FIELD_POINTS / 2;
  factors.push({
    label: 'Home field',
    points: HOME_FIELD_POINTS,
    detail: `${HOME_FIELD_POINTS} points, the modern league-wide figure.`,
  });

  // Recent form, as a deviation from the season-long picture.
  const homeForm = mean(home.recent_margins.slice(0, 3));
  const awayForm = mean(away.recent_margins.slice(0, 3));
  const formSwing = (homeForm - awayForm) * 0.15;
  if (home.recent_margins.length >= 2 && away.recent_margins.length >= 2) {
    homePoints += formSwing / 2;
    awayPoints -= formSwing / 2;
    factors.push({
      label: 'Recent form',
      points: formSwing,
      detail:
        `Last three margins average ${homeForm.toFixed(1)} against ${awayForm.toFixed(1)}. ` +
        `Weighted lightly — three games is a small sample and season-long numbers already ` +
        `contain them.`,
    });
  }

  // Injuries, per side, by position and status.
  const homeInjury = injuries
    .filter((i) => i.team === home.team)
    .reduce((s, i) => s + i.points, 0);
  const awayInjury = injuries
    .filter((i) => i.team === away.team)
    .reduce((s, i) => s + i.points, 0);
  homePoints -= homeInjury;
  awayPoints -= awayInjury;
  if (homeInjury > 0 || awayInjury > 0) {
    factors.push({
      label: 'Injuries',
      points: awayInjury - homeInjury,
      detail:
        `${home.team} down ${homeInjury.toFixed(1)} points of availability, ${away.team} ` +
        `down ${awayInjury.toFixed(1)}. Weighted by position and status, not counted.`,
    });
  }

  // Wind comes off both sides.
  const wind = windPenalty(conditions.wind_mph, conditions.indoors);
  if (wind > 0) {
    homePoints -= wind / 2;
    awayPoints -= wind / 2;
    factors.push({
      label: 'Wind',
      points: 0,
      detail:
        `${conditions.wind_mph} mph takes about ${wind.toFixed(1)} points off the total. It ` +
        `does not favour either side, but it shortens the game.`,
    });
  }

  // Rest, which mostly matters when it is lopsided.
  const [homeRest, awayRest] = conditions.rest_days;
  if (homeRest !== null && awayRest !== null && Math.abs(homeRest - awayRest) >= 3) {
    const restSwing = Math.sign(homeRest - awayRest) * 1.2;
    homePoints += restSwing / 2;
    awayPoints -= restSwing / 2;
    factors.push({
      label: 'Rest',
      points: restSwing,
      detail: `${homeRest} days against ${awayRest}.`,
    });
  }

  const margin = homePoints - awayPoints;
  const winProbability = marginToWinProbability(margin);

  /* --- confidence, which is about the inputs ------------------------ */
  const reasons: string[] = [];
  let penalty = 0;
  if (input.stats_are_prior_season) {
    // On its own this is enough for LOW. A full seventeen-game sample from
    // last season is a large sample of a team that no longer exists in the
    // same form — free agency, the draft and a coaching change all sit
    // between those numbers and this game. Sample size is not the problem
    // here, and letting a big stale sample score as MODERATE would put the
    // reassuring word on the least reliable screen of the year.
    penalty += 3;
    reasons.push(
      'Statistics are from the last completed season — the current one has not produced ' +
        'meaningful data yet, and rosters have changed since.',
    );
  }
  if (input.is_exhibition) {
    penalty += 3;
    reasons.push(
      'This is a preseason game. Starters play a series or two and the outcome turns on ' +
        'players who will not be on the roster — regular-season quality, which is what this ' +
        'projection measures, barely transfers. Treat the number as close to meaningless.',
    );
  }
  const games = Math.min(home.games, away.games);
  if (games < 4) {
    penalty += 2;
    reasons.push(`Only ${games} games behind these averages.`);
  } else if (games < 8) {
    penalty += 1;
    reasons.push(`${games} games behind these averages.`);
  }
  const questionable = injuries.filter((i) => /QUESTION/i.test(i.status));
  if (questionable.length > 0) {
    penalty += 1;
    reasons.push(
      `${questionable.length} listed as questionable, which is the status that resolves ` +
        `latest and moves the number most.`,
    );
  }
  if (Math.abs(margin) < 2) {
    reasons.push('The projected margin is inside the noise; this is close to a coin flip.');
  }

  const confidence = penalty >= 3 ? 'LOW' : penalty >= 1 ? 'MODERATE' : 'GOOD';

  /* --- narrative ---------------------------------------------------- */
  const advantages = describeAdvantages(home, away);
  const uncertainties = questionable.map(
    (i) => `${i.player} (${i.position}, ${i.team}) is questionable — ${i.note}`,
  );
  if (wind > 0) {
    uncertainties.push(
      `Wind forecast at ${conditions.wind_mph} mph. Forecasts this far out move, and this one ` +
        `is worth about ${wind.toFixed(1)} points of total.`,
    );
  }

  return {
    home: home.team,
    away: away.team,
    home_points: Math.round(homePoints * 10) / 10,
    away_points: Math.round(awayPoints * 10) / 10,
    margin: Math.round(margin * 10) / 10,
    home_win_probability: winProbability,
    confidence,
    confidence_reasons: reasons,
    factors: factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    why_home: advantages.home,
    why_away: advantages.away,
    uncertainties,
    not_modelled: [
      'EPA per play, success rate, pressure rate and time to throw — the public feed behind this screen does not publish them, and they are the statistics most worth having.',
      'Scheme and coaching tendencies: blitz rate, man versus zone, fourth-down aggressiveness.',
      'Offensive-line quality beyond sacks allowed, which is a crude proxy for pass protection.',
      'Depth-chart position, so a backup listed out is weighted the same as a starter at that position.',
    ],
  };
}

/** Where each side is measurably better, worst-to-best differences dropped. */
function describeAdvantages(
  home: TeamSeasonStats,
  away: TeamSeasonStats,
): { home: string[]; away: string[] } {
  const out = { home: [] as string[], away: [] as string[] };

  const compare = (
    label: string,
    h: number | null,
    a: number | null,
    threshold: number,
    unit = '',
  ) => {
    if (h === null || a === null) return;
    const gap = h - a;
    if (Math.abs(gap) < threshold) return;
    const line = `${label}: ${h.toFixed(1)}${unit} vs ${a.toFixed(1)}${unit}`;
    if (gap > 0) out.home.push(line);
    else out.away.push(line);
  };

  compare('Yards per play', home.yards_per_play, away.yards_per_play, 0.3);
  compare('Third-down rate', home.third_down_pct, away.third_down_pct, 3, '%');
  compare('Red-zone touchdown rate', home.red_zone_td_pct, away.red_zone_td_pct, 5, '%');
  compare('Yards per pass attempt', home.pass_yards_per_attempt, away.pass_yards_per_attempt, 0.4);
  compare('Yards per carry', home.rush_yards_per_carry, away.rush_yards_per_carry, 0.3);
  compare('Turnover margin', home.turnover_margin_per_game, away.turnover_margin_per_game, 0.4);
  compare('Sacks generated', home.sacks_per_game, away.sacks_per_game, 0.5);
  // Fewer sacks allowed is better, so this one is inverted.
  compare(
    'Pass protection (sacks allowed, lower is better)',
    away.sacks_allowed_per_game,
    home.sacks_allowed_per_game,
    0.5,
  );

  return out;
}
