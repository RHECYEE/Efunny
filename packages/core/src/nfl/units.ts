/**
 * The units a projection does not price but a reader still wants.
 *
 * Special teams and situational football rarely move a projected margin by
 * more than a point, which is exactly why they belong here rather than in the
 * model: folding a half-point of kicking into a number already carrying
 * thirteen points of noise would be false precision. They decide individual
 * games, they are legible, and they are shown as facts rather than weights.
 */

export interface FieldGoalBand {
  label: string;
  made: number;
  attempted: number;
  pct: number | null;
}

export interface SpecialTeams {
  team: string;
  /** Reliability by distance, which is the only way a kicker reads honestly. */
  field_goals: FieldGoalBand[];
  field_goal_pct: number | null;
  long_made: number | null;
  /** Net punting, which already accounts for the return. */
  net_punt_avg: number | null;
  punts_inside_20_pct: number | null;
  yards_per_kick_return: number | null;
  yards_per_punt_return: number | null;
  return_touchdowns: number;
  /** Kickers, punters and returners on the injury report. */
  injuries: string[];
  notes: string[];
}

const BANDS: Array<[string, string, string]> = [
  ['20-29', 'fieldGoalsMade20_29', 'fieldGoalAttempts20_29'],
  ['30-39', 'fieldGoalsMade30_39', 'fieldGoalAttempts30_39'],
  ['40-49', 'fieldGoalsMade40_49', 'fieldGoalAttempts40_49'],
  ['50+', 'fieldGoalsMade50', 'fieldGoalAttempts50'],
];

export type StatLookup = (name: string) => number | null;

/**
 * Season totals that cannot legitimately be zero.
 *
 * ESPN carries these fields and leaves several of them at zero, which is not
 * a small number — it is an absent one. A team does not run zero drives or
 * allow zero points across seventeen games, and reading those as data turned
 * "yards per drive" into a division by nothing and reported a defence as
 * having conceded nothing all year.
 */
const IMPOSSIBLE_ZEROS = new Set([
  'totalDrives',
  'pointsAllowed',
  'yardsAllowed',
  'hurries',
  'possessionTimeSeconds',
]);

/** Wrap a lookup so an impossible zero reads as missing. */
export function guardZeros(stat: StatLookup): StatLookup {
  return (name: string) => {
    const value = stat(name);
    if (value === 0 && IMPOSSIBLE_ZEROS.has(name)) return null;
    return value;
  };
}

/**
 * A kicker, read by distance.
 *
 * An aggregate percentage is close to meaningless: 85% made up mostly of
 * chip shots and 85% including a dozen fifty-yarders describe different
 * kickers, and which one is on the field decides whether a drive stalling at
 * the thirty-five is worth three points.
 */
export function specialTeams(
  team: string,
  stat: StatLookup,
  injuries: string[],
): SpecialTeams {
  stat = guardZeros(stat);
  const bands: FieldGoalBand[] = BANDS.map(([label, madeKey, attKey]) => {
    const made = stat(madeKey) ?? 0;
    const attempted = stat(attKey) ?? 0;
    return { label, made, attempted, pct: attempted > 0 ? made / attempted : null };
  });

  const notes: string[] = [];
  const long = bands.find((b) => b.label === '50+');
  if (long && long.attempted >= 3 && long.pct !== null) {
    notes.push(
      long.pct >= 0.7
        ? `Reliable from 50+: ${long.made} of ${long.attempted}.`
        : `Shaky from 50+: ${long.made} of ${long.attempted}. Drives stalling near midfield are ` +
          `worth less than the aggregate percentage suggests.`,
    );
  }

  const netPunt = stat('netAvgPuntYards');
  const inside20 = stat('puntsInside20Pct');
  if (netPunt !== null && netPunt < 38) {
    notes.push(`Net punting ${netPunt.toFixed(1)} yards, which is short of league standard.`);
  }
  if (inside20 !== null && inside20 >= 45) {
    notes.push(`${inside20.toFixed(0)}% of punts pinned inside the 20.`);
  }
  if (injuries.length > 0) {
    notes.push(`Specialists on the report: ${injuries.join(', ')}.`);
  }

  return {
    team,
    field_goals: bands,
    field_goal_pct: stat('fieldGoalPct') === null ? null : stat('fieldGoalPct')! / 100,
    long_made: stat('longFieldGoalMade'),
    net_punt_avg: netPunt,
    punts_inside_20_pct: inside20,
    yards_per_kick_return: stat('yardsPerKickReturn'),
    yards_per_punt_return: stat('yardsPerPuntReturn'),
    return_touchdowns: (stat('kickReturnTouchdowns') ?? 0) + (stat('puntReturnTouchdowns') ?? 0),
    injuries,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Situational
 * ------------------------------------------------------------------ */

export interface Situational {
  team: string;
  third_down_pct: number | null;
  third_down_attempts: number | null;
  fourth_down_pct: number | null;
  fourth_down_attempts: number | null;
  /** Trips inside the twenty that produced seven rather than three. */
  red_zone_td_pct: number | null;
  red_zone_fg_pct: number | null;
  red_zone_scoring_pct: number | null;
  /** Drives per game, which sets how many chances everything else gets. */
  drives_per_game: number | null;
  possession_minutes: number | null;
  penalties_per_game: number | null;
  penalty_yards_per_game: number | null;
  notes: string[];
}

export function situational(team: string, stat: StatLookup, games: number): Situational {
  stat = guardZeros(stat);
  const pct = (name: string) => {
    const v = stat(name);
    return v === null ? null : v / 100;
  };
  const perGame = (name: string) => {
    const v = stat(name);
    return v === null || games <= 0 ? null : v / games;
  };

  const rzTd = pct('redzoneTouchdownPct');
  const rzFg = pct('redzoneFieldGoalPct');
  const fourth = pct('fourthDownConvPct');
  const fourthAtt = stat('fourthDownAttempts');

  const notes: string[] = [];
  if (rzTd !== null && rzFg !== null) {
    notes.push(
      rzTd >= 0.6
        ? `Finishes drives: ${Math.round(rzTd * 100)}% of red-zone trips end in a touchdown.`
        : `Settles for three: only ${Math.round(rzTd * 100)}% of red-zone trips reach the end ` +
          `zone, ${Math.round(rzFg * 100)}% end in a field goal.`,
    );
  }
  if (fourthAtt !== null && fourthAtt >= 15) {
    notes.push(
      `Aggressive on fourth down — ${fourthAtt} attempts` +
        (fourth !== null ? ` at ${Math.round(fourth * 100)}%.` : '.') +
        ' Fourth-down policy is the closest thing here to a read on coaching, and it is a ' +
        'weak one: it reflects last season\'s staff and situations, not a stated philosophy.',
    );
  }

  const penalties = perGame('totalPenalties');
  if (penalties !== null && penalties >= 7) {
    notes.push(`${penalties.toFixed(1)} penalties a game.`);
  }

  return {
    team,
    third_down_pct: pct('thirdDownConvPct'),
    third_down_attempts: stat('thirdDownAttempts'),
    fourth_down_pct: fourth,
    fourth_down_attempts: fourthAtt,
    red_zone_td_pct: rzTd,
    red_zone_fg_pct: rzFg,
    red_zone_scoring_pct: pct('redzoneScoringPct'),
    drives_per_game: perGame('totalDrives'),
    possession_minutes:
      stat('possessionTimeSeconds') === null || games <= 0
        ? null
        : stat('possessionTimeSeconds')! / games / 60,
    penalties_per_game: penalties,
    penalty_yards_per_game: perGame('totalPenaltyYards'),
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Efficiency
 * ------------------------------------------------------------------ */

export interface Efficiency {
  team: string;
  yards_per_game: number | null;
  points_per_game: number | null;
  /**
   * Yards and points per possession, when the venue publishes drive counts.
   *
   * It frequently does not — the field is present and zero, which is an
   * absence rather than a number — so these are null far more often than the
   * per-game figures beside them.
   */
  yards_per_drive: number | null;
  points_per_drive: number | null;
  yards_allowed_per_game: number | null;
  /** Derived from results when the feed does not publish it, which is usual. */
  points_allowed_per_game: number | null;
  points_allowed_is_derived: boolean;
  /** Longest gain, the only explosive-play proxy this feed carries. */
  long_pass: number | null;
  long_rush: number | null;
  /** Pressure generated, which is a better read than sacks alone. */
  hurries: number | null;
  sacks: number | null;
  /** Runs stopped at or behind the line. */
  stuffs: number | null;
  notes: string[];
}

/**
 * Per-drive rather than per-play.
 *
 * Total offensive plays is not published, so yards per play cannot be
 * computed honestly. Drives are, and a per-drive rate answers much the same
 * question — how much a team does with a possession — without inventing a
 * denominator.
 */
export function efficiency(
  team: string,
  stat: StatLookup,
  games: number,
  /** Computed from results, which is exact where the feed is silent. */
  derivedPointsAllowedPerGame: number | null = null,
): Efficiency {
  stat = guardZeros(stat);
  const drives = stat('totalDrives');
  const yards = stat('netTotalYards') ?? stat('yardsPerGame');
  const totalYards =
    stat('netTotalYards') !== null
      ? stat('netTotalYards')!
      : yards !== null && games > 0
        ? yards * games
        : null;
  const points = stat('totalPoints');

  const hurries = stat('hurries');
  const sacks = stat('sacks');
  const notes: string[] = [];
  if (sacks !== null && games > 0) {
    notes.push(
      hurries !== null
        ? `${(hurries / games).toFixed(1)} hurries and ${(sacks / games).toFixed(1)} sacks a ` +
          `game. Hurries are the closer stand-in for pressure rate.`
        : `${(sacks / games).toFixed(1)} sacks a game. Hurries are carried by the feed but left ` +
          `empty for this team, so pressure has only sacks standing in for it.`,
    );
  }
  if (drives === null) {
    notes.push('Drive counts are not published for this team, so per-possession rates are absent.');
  }
  const stuffs = stat('stuffs');
  if (stuffs !== null && games > 0 && stuffs / games >= 4) {
    notes.push(`${(stuffs / games).toFixed(1)} runs stopped at or behind the line per game.`);
  }

  const publishedPointsAllowed =
    stat('pointsAllowed') !== null && games > 0 ? stat('pointsAllowed')! / games : null;

  return {
    team,
    yards_per_game: stat('yardsPerGame'),
    points_per_game: stat('totalPointsPerGame'),
    yards_per_drive: totalYards !== null && drives ? totalYards / drives : null,
    points_per_drive: points !== null && drives ? points / drives : null,
    yards_allowed_per_game:
      stat('yardsAllowed') !== null && games > 0 ? stat('yardsAllowed')! / games : null,
    points_allowed_per_game: publishedPointsAllowed ?? derivedPointsAllowedPerGame,
    points_allowed_is_derived: publishedPointsAllowed === null && derivedPointsAllowedPerGame !== null,
    long_pass: stat('longPassing'),
    long_rush: stat('longRushing'),
    hurries,
    sacks,
    stuffs,
    notes,
  };
}
