/**
 * The comparisons a season average cannot make.
 *
 * Everything here exists because "they average 28 points" is a sentence with
 * a missing clause. Against whom, in what conditions, and how much of it was
 * luck. Each section states its own sample size, because most of them are
 * built on three or four games and a comparison that hides that is worse than
 * one that is not offered.
 */

export interface Result {
  date: string;
  opponent: string;
  home: boolean;
  points_for: number;
  points_against: number;
}

/* ------------------------------------------------------------------ *
 * Common opponents
 * ------------------------------------------------------------------ */

export interface CommonOpponent {
  opponent: string;
  home_margin: number;
  away_margin: number;
  /** Positive means the home team did better against this opponent. */
  difference: number;
}

export interface CommonOpponentRead {
  opponents: CommonOpponent[];
  /** Mean difference across shared opponents. */
  average_difference: number | null;
  /** The caveat, stated rather than implied. */
  caveat: string;
}

/**
 * How two teams fared against the same opposition.
 *
 * Intuitive and badly overrated. Two games against the same opponent can be
 * separated by three months, a quarterback change and a different weather
 * system, so this is reported with its sample size attached and given no
 * weight in the projection at all.
 */
export function commonOpponents(
  homeResults: Result[],
  awayResults: Result[],
): CommonOpponentRead {
  const byOpponent = (results: Result[]) => {
    const map = new Map<string, number[]>();
    for (const r of results) {
      const margins = map.get(r.opponent) ?? [];
      margins.push(r.points_for - r.points_against);
      map.set(r.opponent, margins);
    }
    return map;
  };

  const home = byOpponent(homeResults);
  const away = byOpponent(awayResults);
  const shared: CommonOpponent[] = [];

  for (const [opponent, homeMargins] of home) {
    const awayMargins = away.get(opponent);
    if (!awayMargins) continue;
    const h = homeMargins.reduce((s, x) => s + x, 0) / homeMargins.length;
    const a = awayMargins.reduce((s, x) => s + x, 0) / awayMargins.length;
    shared.push({
      opponent,
      home_margin: Math.round(h * 10) / 10,
      away_margin: Math.round(a * 10) / 10,
      difference: Math.round((h - a) * 10) / 10,
    });
  }

  shared.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  const average =
    shared.length > 0
      ? Math.round((shared.reduce((s, x) => s + x.difference, 0) / shared.length) * 10) / 10
      : null;

  return {
    opponents: shared,
    average_difference: average,
    caveat:
      shared.length === 0
        ? 'No shared opponents in this sample.'
        : `${shared.length} shared opponent${shared.length === 1 ? '' : 's'}. Two meetings with ` +
          `the same team can be months apart with different personnel, so this is shown for ` +
          `context and carries no weight in the projection.`,
  };
}

/* ------------------------------------------------------------------ *
 * Head to head
 * ------------------------------------------------------------------ */

export interface HeadToHead {
  meetings: Array<{ date: string; margin: number; home: boolean }>;
  home_wins: number;
  away_wins: number;
  note: string;
}

/**
 * Recent meetings, weighted at nothing.
 *
 * "Team X has beaten Team Y six straight times" is the most quoted and least
 * predictive statistic in sport. Unless the personnel and the coaching are
 * substantially the same — which across even two seasons they rarely are —
 * a head-to-head streak is a fact about teams that no longer exist. It is
 * shown because people look for it, and labelled because they should not
 * lean on it.
 */
export function headToHead(homeResults: Result[], opponent: string): HeadToHead {
  const meetings = homeResults
    .filter((r) => r.opponent === opponent)
    .map((r) => ({
      date: r.date,
      margin: r.points_for - r.points_against,
      home: r.home,
    }));

  return {
    meetings,
    home_wins: meetings.filter((m) => m.margin > 0).length,
    away_wins: meetings.filter((m) => m.margin < 0).length,
    note:
      meetings.length === 0
        ? 'These teams have not met in this sample.'
        : 'Shown because people look for it. It carries no weight here: unless the personnel ' +
          'and the scheme are substantially unchanged, a head-to-head record describes teams ' +
          'that no longer exist.',
  };
}

/* ------------------------------------------------------------------ *
 * Strength of schedule
 * ------------------------------------------------------------------ */

/**
 * How good the opposition has been, as their average margin in other games.
 *
 * The point of an adjustment: a team that has beaten nobody and a team that
 * has beaten everybody can carry the same record into the same week.
 */
export function strengthOfSchedule(
  results: Result[],
  marginsByTeam: Map<string, number>,
): number | null {
  const opponents = results.map((r) => marginsByTeam.get(r.opponent)).filter(
    (m): m is number => m !== undefined,
  );
  if (opponents.length === 0) return null;
  return Math.round((opponents.reduce((s, x) => s + x, 0) / opponents.length) * 10) / 10;
}

/* ------------------------------------------------------------------ *
 * Turnovers
 * ------------------------------------------------------------------ */

export interface TurnoverRead {
  margin_per_game: number | null;
  /** Fumbles are close to a coin flip once they hit the ground. */
  fumble_recovery_rate: number | null;
  /** How much of the margin looks like recovery luck rather than takeaway skill. */
  luck_note: string;
}

/**
 * Turnover margin, with the part that does not repeat marked as such.
 *
 * Forcing fumbles is a skill and recovering them is very close to a coin
 * flip, so a team sitting well away from a even recovery rate has been lucky
 * or unlucky rather than good or bad at it, and that portion of a turnover
 * margin should not be expected to continue. Interceptions repeat somewhat
 * better, which is why they are not lumped in.
 */
export function turnoverRead(
  marginPerGame: number | null,
  ownFumbles: number | null,
  ownFumblesLost: number | null,
): TurnoverRead {
  /**
   * Own fumbles kept, which is the cleanly defined coin flip.
   *
   * An earlier version divided total recoveries by forced fumbles and
   * produced "114%", because recoveries include a team's own fumbles while
   * the denominator counted only the ones it forced. Two different
   * populations, one ratio, an impossible number. Fumbles a team dropped and
   * kept is a rate that is actually a rate.
   */
  const rate =
    ownFumbles !== null && ownFumbles > 0 && ownFumblesLost !== null
      ? (ownFumbles - ownFumblesLost) / ownFumbles
      : null;

  let note =
    'Turnover margin is a mix of a repeatable skill and a coin flip. Forcing fumbles repeats; ' +
    'recovering them barely does.';
  if (rate !== null) {
    const swing = Math.abs(rate - 0.5);
    if (swing >= 0.12) {
      note =
        `Kept ${Math.round(rate * 100)}% of its own fumbles against a coin-flip baseline near ` +
        `50%. That gap is luck rather than skill, and the part of this team's turnover margin ` +
        `resting on it should not be expected to continue.`;
    } else {
      note =
        `Kept ${Math.round(rate * 100)}% of its own fumbles, close to the coin-flip baseline, ` +
        `so this turnover margin looks earned rather than lucky.`;
    }
  }

  return { margin_per_game: marginPerGame, fumble_recovery_rate: rate, luck_note: note };
}

/* ------------------------------------------------------------------ *
 * Trenches
 * ------------------------------------------------------------------ */

export interface TrenchRead {
  /** Positive favours the team doing the protecting. */
  differential: number | null;
  severity: 'NONE' | 'NOTABLE' | 'SEVERE';
  detail: string;
  /** Line injuries, which is where a mismatch usually comes from. */
  line_injuries: string[];
}

/**
 * Pass protection against pass rush, given its own reading.
 *
 * Singled out because a line mismatch changes a game in a way the other
 * statistics do not reflect: two otherwise similar teams can produce a
 * one-sided result when one side cannot block the other, and every offensive
 * number is downstream of it.
 *
 * What is available here is sacks, which is a crude proxy. Pressure rate and
 * time to throw are the figures that would actually answer this, and the feed
 * publishes neither, so the reading is deliberately coarse and says so.
 */
export function trenchRead(
  sacksAllowedPerGame: number | null,
  opposingSacksPerGame: number | null,
  lineInjuries: string[],
): TrenchRead {
  if (sacksAllowedPerGame === null || opposingSacksPerGame === null) {
    return {
      differential: null,
      severity: 'NONE',
      detail: 'Sack figures unavailable for one side.',
      line_injuries: lineInjuries,
    };
  }

  const differential = Math.round((opposingSacksPerGame - sacksAllowedPerGame) * 10) / 10;
  const injuryWeight = lineInjuries.length;
  const severity: TrenchRead['severity'] =
    differential >= 1.2 || (differential >= 0.7 && injuryWeight >= 2)
      ? 'SEVERE'
      : differential >= 0.6 || injuryWeight >= 2
        ? 'NOTABLE'
        : 'NONE';

  return {
    differential,
    severity,
    detail:
      `Pass rush generates ${opposingSacksPerGame.toFixed(1)} sacks a game against a line ` +
      `allowing ${sacksAllowedPerGame.toFixed(1)}` +
      (injuryWeight > 0
        ? `, with ${injuryWeight} offensive linemen on the injury report.`
        : '.') +
      ' Sacks are a crude stand-in for pressure rate, which is the figure that would ' +
      'actually settle this and is not published here.',
    line_injuries: lineInjuries,
  };
}
