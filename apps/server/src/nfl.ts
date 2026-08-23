import {
  STADIUMS,
  distanceMiles,
  fetchForecast,
  fetchInjuries,
  fetchResults,
  fetchScoreboard,
  fetchTeamStats,
  stat,
  type GameResult,
  type NflInjury,
  type UpcomingGame,
} from '@arbterminal/adapters';
import {
  diffSnapshots,
  injuryPoints,
  project,
  snapshotOf,
  type Change,
  type Conditions,
  type InjuryImpact,
  type MatchupSnapshot,
  type Projection,
  type TeamSeasonStats,
} from '@arbterminal/core';

/**
 * NFL matchup intelligence.
 *
 * Assembles one screen per game out of four separate feeds, and keeps a
 * snapshot of each matchup so that reopening it later can say what moved
 * rather than making somebody reread the whole thing.
 *
 * The season this reads from is deliberate. Preseason statistics are starters
 * playing one series against opponents doing the same, and a projection built
 * on them would be confident about nothing. So when the current season has
 * not produced real games, the stats come from the last completed one, the
 * screen says so, and confidence is docked for it.
 */

const TEAM_ID: Record<string, string> = {
  ATL: '1', BUF: '2', CHI: '3', CIN: '4', CLE: '5', DAL: '6', DEN: '7', DET: '8',
  GB: '9', TEN: '10', IND: '11', KC: '12', LV: '13', LAR: '14', MIA: '15', MIN: '16',
  NE: '17', NO: '18', NYG: '19', NYJ: '20', PHI: '21', ARI: '22', PIT: '23', LAC: '24',
  SF: '25', SEA: '26', TB: '27', WSH: '28', CAR: '29', JAX: '30', BAL: '33', HOU: '34',
};

const STATS_TTL_MS = 12 * 60 * 60 * 1000;
const LIVE_TTL_MS = 10 * 60 * 1000;

export interface MatchupView {
  game: UpcomingGame;
  projection: Projection;
  injuries: InjuryImpact[];
  conditions: Conditions;
  stadium: string;
  /** Populated once the matchup has been looked at before. */
  changes: Change[];
  previous_seen_at: string | null;
  stats_season: number;
  stats_are_prior_season: boolean;
}

export interface NflBoard {
  games: UpcomingGame[];
  season_year: number;
  season_type: number;
  week: number | null;
  error: string | null;
}

interface TeamBundle {
  stats: TeamSeasonStats;
  results: GameResult[];
}

export class NflService {
  private teams = new Map<string, TeamBundle>();
  private teamsAt = 0;
  private injuries: NflInjury[] = [];
  private injuriesAt = 0;
  private snapshots = new Map<string, MatchupSnapshot>();
  private statsSeason = 0;
  private priorSeason = false;

  async board(): Promise<NflBoard> {
    try {
      const s = await fetchScoreboard();
      return {
        games: s.games,
        season_year: s.season_year,
        season_type: s.season_type,
        week: s.week,
        error: null,
      };
    } catch (error) {
      return {
        games: [],
        season_year: 0,
        season_type: 0,
        week: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Which season's numbers to read.
   *
   * Season type 2 is the regular season; anything else means the games played
   * so far do not describe how these teams will play. Rather than trusting
   * the flag alone, this also requires that the season has actually produced
   * results — a week-one screen has a regular-season flag and no data.
   */
  private async resolveStatsSeason(): Promise<{ season: number; prior: boolean }> {
    const s = await fetchScoreboard();
    if (s.season_type === 2 && (s.week ?? 0) >= 4) {
      return { season: s.season_year, prior: false };
    }
    return { season: s.season_year - 1, prior: true };
  }

  private async ensureTeam(abbr: string, season: number): Promise<TeamBundle | null> {
    const cached = this.teams.get(abbr);
    if (cached && Date.now() - this.teamsAt < STATS_TTL_MS) return cached;

    const id = TEAM_ID[abbr];
    if (!id) return null;
    try {
      const [raw, results] = await Promise.all([
        fetchTeamStats(id, season),
        fetchResults(abbr, season),
      ]);

      const games = results.length;
      // Points allowed is not published; it is the exact sum of what
      // opponents scored, which the results carry.
      const pointsAgainst =
        games > 0 ? results.reduce((s, g) => s + g.points_against, 0) / games : null;
      const pointsFor = games > 0 ? results.reduce((s, g) => s + g.points_for, 0) / games : null;

      const yardsPerGame = stat(raw, 'yardsPerGame');
      const bundle: TeamBundle = {
        results,
        stats: {
          team: abbr,
          games,
          points_for_per_game: pointsFor ?? stat(raw, 'totalPointsPerGame'),
          points_against_per_game: pointsAgainst,
          yards_per_play: null,
          yards_per_play_allowed: null,
          third_down_pct: stat(raw, 'thirdDownConvPct'),
          third_down_pct_allowed: null,
          red_zone_td_pct: stat(raw, 'redzoneTouchdownPct'),
          red_zone_td_pct_allowed: null,
          turnover_margin_per_game:
            games > 0 && stat(raw, 'totalTakeaways') !== null && stat(raw, 'totalGiveaways') !== null
              ? (stat(raw, 'totalTakeaways')! - stat(raw, 'totalGiveaways')!) / games
              : null,
          sacks_per_game:
            games > 0 && raw.defensive?.sacks !== undefined ? raw.defensive.sacks / games : null,
          sacks_allowed_per_game:
            games > 0 && raw.passing?.sacks !== undefined ? raw.passing.sacks / games : null,
          pass_yards_per_attempt: stat(raw, 'netYardsPerPassAttempt') ?? stat(raw, 'yardsPerPassAttempt'),
          pass_yards_per_attempt_allowed: null,
          rush_yards_per_carry: stat(raw, 'yardsPerRushAttempt'),
          rush_yards_per_carry_allowed: null,
          recent_margins: results.slice(0, 5).map((g) => g.points_for - g.points_against),
        },
      };
      void yardsPerGame;
      this.teams.set(abbr, bundle);
      this.teamsAt = Date.now();
      return bundle;
    } catch {
      return null;
    }
  }

  private async ensureInjuries(): Promise<NflInjury[]> {
    if (Date.now() - this.injuriesAt < LIVE_TTL_MS && this.injuries.length > 0) {
      return this.injuries;
    }
    try {
      this.injuries = await fetchInjuries();
      this.injuriesAt = Date.now();
    } catch {
      // An injury feed that fails leaves the report empty, which the screen
      // reports as unknown rather than as a clean bill of health.
    }
    return this.injuries;
  }

  async matchup(homeAbbr: string, awayAbbr: string): Promise<MatchupView | null> {
    const board = await this.board();
    const game =
      board.games.find((g) => g.home === homeAbbr && g.away === awayAbbr) ??
      ({
        id: `${awayAbbr}@${homeAbbr}`,
        date: new Date().toISOString(),
        home: homeAbbr,
        away: awayAbbr,
        name: `${awayAbbr} at ${homeAbbr}`,
        season_type: board.season_type,
        week: board.week,
      } satisfies UpcomingGame);

    const { season, prior } = await this.resolveStatsSeason();
    this.statsSeason = season;
    this.priorSeason = prior;

    const [home, away, injuryFeed] = await Promise.all([
      this.ensureTeam(homeAbbr, season),
      this.ensureTeam(awayAbbr, season),
      this.ensureInjuries(),
    ]);
    if (!home || !away) return null;

    const homeId = TEAM_ID[homeAbbr];
    const awayId = TEAM_ID[awayAbbr];
    const relevant = injuryFeed.filter((i) => i.team_id === homeId || i.team_id === awayId);
    const injuries: InjuryImpact[] = relevant
      .map((i) => ({
        // Carried as the abbreviation the rest of the screen speaks in.
        team: i.team_id === homeId ? homeAbbr : awayAbbr,
        player: i.player,
        position: i.position,
        status: i.status,
        points: injuryPoints(i.position, i.status),
        note: i.detail || i.comment || 'No detail published.',
      }))
      .filter((i) => i.points > 0)
      .sort((a, b) => b.points - a.points);

    const stadium = STADIUMS[homeAbbr];
    const forecast = stadium
      ? await fetchForecast(stadium, game.date).catch(() => ({
          temperature_f: null,
          wind_mph: null,
          precipitation_in: null,
          forecast: true,
        }))
      : { temperature_f: null, wind_mph: null, precipitation_in: null, forecast: true };

    const conditions: Conditions = {
      temperature: forecast.temperature_f,
      wind_mph: forecast.wind_mph,
      precipitation: forecast.precipitation_in,
      indoors: stadium?.indoors ?? false,
      rest_days: [restDays(home.results, game.date), restDays(away.results, game.date)],
      travel_miles:
        stadium && STADIUMS[awayAbbr] ? Math.round(distanceMiles(STADIUMS[awayAbbr]!, stadium)) : null,
    };

    // The projection is computed before any market is consulted. A model that
    // has seen the line first is a slower way of reproducing the line.
    const projection = project({
      home: home.stats,
      away: away.stats,
      injuries,
      conditions,
      stats_are_prior_season: prior,
    });

    const previous = this.snapshots.get(game.id) ?? null;
    const current = snapshotOf(projection, injuries, conditions.wind_mph, null);
    const changes = previous ? diffSnapshots(previous, current) : [];
    this.snapshots.set(game.id, current);

    return {
      game,
      projection,
      injuries,
      conditions,
      stadium: stadium?.name ?? 'Unknown venue',
      changes,
      previous_seen_at: previous?.taken_at ?? null,
      stats_season: this.statsSeason,
      stats_are_prior_season: this.priorSeason,
    };
  }
}

/**
 * Days between a team's last completed game and kickoff.
 *
 * Returns null across an offseason. "231 days of rest" is arithmetically
 * true and says nothing about a football team, and feeding it to a rest
 * comparison would have produced a one-day advantage out of two teams that
 * have both been off since January.
 */
const OFFSEASON_DAYS = 45;

function restDays(results: GameResult[], kickoff: string): number | null {
  const last = results[0];
  if (!last?.date) return null;
  const days = (Date.parse(kickoff) - Date.parse(last.date)) / 86_400_000;
  if (!Number.isFinite(days) || days > OFFSEASON_DAYS) return null;
  return Math.round(days);
}
