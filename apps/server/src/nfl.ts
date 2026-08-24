import {
  STADIUMS,
  distanceMiles,
  fetchForecast,
  fetchInjuries,
  fetchNews,
  fetchRecordSplits,
  fetchResults,
  fetchScoreboard,
  fetchStandings,
  fetchTeamStats,
  stat,
  type NewsItem,
  type TeamStanding,
  type RecordSplits,
  type GameResult,
  type NflInjury,
  type UpcomingGame,
} from '@arbterminal/adapters';
import { KalshiAdapter } from '@arbterminal/adapters';
import {
  compareToMarket,
  diffSnapshots,
  injuryPoints,
  project,
  snapshotOf,
  commonOpponents,
  efficiency,
  headToHead,
  recordDepth,
  situational,
  specialTeams,
  trenchRead,
  turnoverRead,
  type Change,
  type CommonOpponentRead,
  type HeadToHead,
  type Efficiency,
  type MarketComparison,
  type RecordDepth,
  type Situational,
  type SpecialTeams,
  type TrenchRead,
  type TurnoverRead,
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

export interface TeamContext {
  team: string;
  record: RecordSplits;
  depth: RecordDepth;
  special_teams: SpecialTeams;
  situational: Situational;
  efficiency: Efficiency;
  /** Last five margins, newest first. */
  recent: number[];
  /** Season-long average margin, for comparison against the recent run. */
  season_margin: number | null;
  news: NewsItem[];
  turnovers: TurnoverRead;
}

export interface MatchupView {
  game: UpcomingGame;
  projection: Projection;
  injuries: InjuryImpact[];
  conditions: Conditions;
  stadium: string;
  home_context: TeamContext;
  away_context: TeamContext;
  common_opponents: CommonOpponentRead;
  head_to_head: HeadToHead;
  /** Trench read for each side's protection against the other's rush. */
  trenches: { home: TrenchRead; away: TrenchRead };
  /**
   * The market, read only after the projection was computed.
   *
   * Null when no venue prices this game, which is the honest state rather
   * than a reason to leave the row out.
   */
  market: MarketComparison | null;
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
  record: RecordSplits;
  news: NewsItem[];
  fumbles_forced: number | null;
  fumbles_recovered: number | null;
  /** Raw statistics, kept so the unit reads can be built without refetching. */
  raw: (name: string) => number | null;
}

export class NflService {
  private teams = new Map<string, TeamBundle>();
  private teamsAt = 0;
  private injuries: NflInjury[] = [];
  private injuriesAt = 0;
  private snapshots = new Map<string, MatchupSnapshot>();
  private gameMarkets: Array<{ ticker: string; team: string; ask: number }> = [];
  private gameMarketsAt = 0;
  private standings = new Map<string, TeamStanding>();
  private standingsAt = 0;
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
      const [raw, results, record, news] = await Promise.all([
        fetchTeamStats(id, season),
        fetchResults(abbr, season),
        fetchRecordSplits(id, season).catch(() => ({
          overall: null, home: null, road: null, division: null, conference: null,
        })),
        fetchNews(id, { limit: 8 }).catch(() => []),
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
        record,
        news,
        // Own fumbles and own fumbles lost — the pair that forms a real rate.
        fumbles_forced: stat(raw, 'fumbles'),
        fumbles_recovered: stat(raw, 'fumblesLost'),
        raw: () => null,
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
      bundle.raw = (name: string) => stat(raw, name);
      this.teams.set(abbr, bundle);
      this.teamsAt = Date.now();
      return bundle;
    } catch {
      return null;
    }
  }

  /**
   * Every team's record for the season being read.
   *
   * One request, cached alongside the team statistics. Without it, "record
   * against winning teams" classifies almost every opponent as .500 by
   * default and reports a genuinely brutal schedule as neutral.
   */
  private async ensureStandings(season: number): Promise<Map<string, TeamStanding>> {
    if (Date.now() - this.standingsAt < STATS_TTL_MS && this.standings.size > 0) {
      return this.standings;
    }
    try {
      this.standings = await fetchStandings(season);
      this.standingsAt = Date.now();
    } catch {
      // An empty map means the splits report as unknown rather than as even.
    }
    return this.standings;
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

  /**
   * Kalshi's per-game winner markets.
   *
   * Fetched as one series sweep and cached, because the alternative is a
   * lookup per matchup for a list that is the same list every time.
   */
  private async ensureGameMarkets(): Promise<typeof this.gameMarkets> {
    if (Date.now() - this.gameMarketsAt < LIVE_TTL_MS && this.gameMarkets.length > 0) {
      return this.gameMarkets;
    }
    try {
      const adapter = new KalshiAdapter({ series_tickers: ['KXNFLGAME'], market_limit: 200 });
      const snaps = await adapter.fetchSnapshots();
      this.gameMarkets = snaps
        .flatMap((s) => s.markets)
        .map((m) => ({
          ticker: m.market.venue_market_id,
          // The ticker ends in the team the contract pays on.
          team: (m.market.venue_market_id.split('-').pop() ?? '').toUpperCase(),
          ask: m.quote.book.yes_asks[0]?.price ?? 0,
        }))
        .filter((m) => m.ask > 0);
      this.gameMarketsAt = Date.now();
    } catch {
      // No market is a missing comparison, not a failed matchup.
    }
    return this.gameMarkets;
  }

  /**
   * Both sides of one game, if a venue prices it.
   *
   * Matched on the ticker carrying both team codes, so a market for a
   * different week between one of the same teams and somebody else cannot be
   * picked up by accident.
   */
  private async marketFor(homeAbbr: string, awayAbbr: string) {
    const markets = await this.ensureGameMarkets();
    const codes = (t: string) => t.toUpperCase();
    const pair = markets.filter(
      (m) =>
        m.ticker.toUpperCase().includes(codes(homeAbbr)) &&
        m.ticker.toUpperCase().includes(codes(awayAbbr)),
    );
    const home = pair.find((m) => m.team === codes(homeAbbr));
    const away = pair.find((m) => m.team === codes(awayAbbr));
    if (!home || !away) return null;
    return { venue: 'kalshi', home_price: home.ask, away_price: away.ask };
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

    const [home, away, injuryFeed, standings] = await Promise.all([
      this.ensureTeam(homeAbbr, season),
      this.ensureTeam(awayAbbr, season),
      this.ensureInjuries(),
      this.ensureStandings(season),
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
      is_exhibition: game.season_type === 1,
    });

    // Only now — after the projection exists — is a price consulted.
    const quote = await this.marketFor(homeAbbr, awayAbbr);
    const market = quote ? compareToMarket(projection.home_win_probability, quote) : null;

    const previous = this.snapshots.get(game.id) ?? null;
    const current = snapshotOf(
      projection,
      injuries,
      conditions.wind_mph,
      market?.fair_home_probability ?? null,
    );
    const changes = previous ? diffSnapshots(previous, current) : [];
    this.snapshots.set(game.id, current);

    // League-wide, from the standings rather than from the two teams loaded.
    const winPct = new Map<string, number>();
    const margins = new Map<string, number>();
    for (const [abbr, standing] of standings) {
      winPct.set(abbr, standing.win_pct);
      if (standing.games > 0) margins.set(abbr, standing.point_differential / standing.games);
    }

    const specialistPositions = /^(K|P|LS|PK)$/i;
    const contextFor = (bundle: TeamBundle): TeamContext => ({
      team: bundle.stats.team,
      record: bundle.record,
      depth: recordDepth(bundle.stats.team, bundle.results, winPct, margins),
      special_teams: specialTeams(
        bundle.stats.team,
        bundle.raw,
        injuries
          .filter((i) => i.team === bundle.stats.team && specialistPositions.test(i.position))
          .map((i) => `${i.position} ${i.player} (${i.status})`),
      ),
      situational: situational(bundle.stats.team, bundle.raw, bundle.results.length),
      efficiency: efficiency(
        bundle.stats.team,
        bundle.raw,
        bundle.results.length,
        bundle.stats.points_against_per_game,
      ),
      recent: bundle.stats.recent_margins,
      season_margin:
        bundle.results.length > 0
          ? Math.round(
              (bundle.results.reduce((s, g) => s + (g.points_for - g.points_against), 0) /
                bundle.results.length) *
                10,
            ) / 10
          : null,
      news: bundle.news,
      turnovers: turnoverRead(
        bundle.stats.turnover_margin_per_game,
        bundle.fumbles_forced,
        bundle.fumbles_recovered,
      ),
    });

    // Offensive-line injuries drive the trench read, so they are picked out
    // by position rather than counted with everyone else.
    const linePositions = /^(LT|RT|OT|T|C|OG|G|OL)$/i;
    const lineInjuries = (team: string) =>
      injuries
        .filter((i) => i.team === team && linePositions.test(i.position))
        .map((i) => `${i.position} ${i.player} (${i.status})`);

    return {
      game,
      projection,
      injuries,
      conditions,
      stadium: stadium?.name ?? 'Unknown venue',
      home_context: contextFor(home),
      away_context: contextFor(away),
      common_opponents: commonOpponents(home.results, away.results),
      head_to_head: headToHead(home.results, awayAbbr),
      market,
      trenches: {
        home: trenchRead(
          home.stats.sacks_allowed_per_game,
          away.stats.sacks_per_game,
          lineInjuries(homeAbbr),
        ),
        away: trenchRead(
          away.stats.sacks_allowed_per_game,
          home.stats.sacks_per_game,
          lineInjuries(awayAbbr),
        ),
      },
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
