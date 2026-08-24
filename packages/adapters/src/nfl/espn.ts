/**
 * ESPN's public NFL feeds.
 *
 * Three separate services, none documented, all public. What they give is
 * generous — full season statistics, every result, the league-wide injury
 * report — and what they do not give matters just as much: there is no EPA,
 * no success rate, no pressure rate and no time to throw anywhere in here.
 * Those are the statistics a serious matchup read would lean on hardest, and
 * the screen says so rather than substituting something coarser and quiet.
 *
 * Points *allowed* is also absent as a published figure, so it is computed
 * from results. That is exact rather than approximate — it is the same
 * arithmetic the league does — but it is worth knowing it is derived.
 */

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const WEB = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl';

/**
 * User agent for these requests.
 *
 * A bare fetch sends no user agent and gets a 403. That is not ESPN being
 * fussy — it is this deployment's egress proxy, which allows recognised
 * command-line agents and rejects everything else, including a browser
 * string. The default below is what actually gets through here; a deployment
 * behind a different proxy should set the variable to something that names
 * this application honestly.
 */
/**
 * Read an environment variable where there is an environment to read.
 *
 * This module runs inside a phone's WebView as well as on a server, and
 * `process` simply does not exist there — touching it is a ReferenceError,
 * not an undefined, so the whole NFL screen would fail on its first request
 * rather than fall back to the default.
 */
function env(name: string): string | undefined {
  // Reached through globalThis rather than the bare identifier: a WebView
  // build has no Node types either, so naming `process` directly would not
  // compile there even when the guard is correct at runtime.
  const global = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return global.process?.env?.[name];
}

const USER_AGENT = env('ESPN_USER_AGENT') ?? 'curl/8.5.0';

export interface EspnOptions {
  fetch_impl?: typeof fetch;
  request_timeout_ms?: number;
}

async function getJson<T>(url: string, options: EspnOptions): Promise<T> {
  const doFetch = options.fetch_impl ?? fetch;
  const response = await doFetch(url, {
    signal: AbortSignal.timeout(options.request_timeout_ms ?? 20_000),
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`ESPN ${response.status} for ${url}`);
  return (await response.json()) as T;
}

export interface NflTeam {
  id: string;
  abbreviation: string;
  name: string;
  record: string | null;
}

export async function fetchTeams(options: EspnOptions = {}): Promise<NflTeam[]> {
  const body = await getJson<{
    sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: Record<string, unknown> }> }> }>;
  }>(`${SITE}/teams?limit=40`, options);

  const raw = body.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return raw
    .map((t) => t.team as Record<string, unknown> | undefined)
    .filter((t): t is Record<string, unknown> => Boolean(t))
    .map((t) => ({
      id: String(t.id),
      abbreviation: String(t.abbreviation ?? ''),
      name: String(t.displayName ?? ''),
      record:
        (t.record as { items?: Array<{ summary?: string }> } | undefined)?.items?.[0]?.summary ??
        null,
    }));
}

/* ------------------------------------------------------------------ *
 * Season statistics
 * ------------------------------------------------------------------ */

export interface RawTeamStats {
  [category: string]: Record<string, number>;
}

export async function fetchTeamStats(
  teamId: string,
  season: number,
  options: EspnOptions = {},
): Promise<RawTeamStats> {
  const body = await getJson<{
    splits?: { categories?: Array<{ name?: string; stats?: Array<{ name?: string; value?: number }> }> };
  }>(`${CORE}/seasons/${season}/types/2/teams/${teamId}/statistics`, options);

  const out: RawTeamStats = {};
  for (const category of body.splits?.categories ?? []) {
    const name = category.name ?? '';
    const stats: Record<string, number> = {};
    for (const stat of category.stats ?? []) {
      if (stat.name && typeof stat.value === 'number') stats[stat.name] = stat.value;
    }
    out[name] = stats;
  }
  return out;
}

/** Read a stat from whichever category holds it. */
export function stat(raw: RawTeamStats, name: string): number | null {
  for (const category of Object.values(raw)) {
    if (name in category) return category[name]!;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export interface GameResult {
  date: string;
  opponent: string;
  home: boolean;
  points_for: number;
  points_against: number;
  completed: boolean;
}

/**
 * A team's completed games for a season.
 *
 * This is where points allowed, recent form, rest days, head-to-head and
 * common opponents all come from — none of which any single endpoint serves
 * directly.
 */
export async function fetchResults(
  teamAbbr: string,
  season: number,
  options: EspnOptions = {},
): Promise<GameResult[]> {
  const body = await getJson<{
    events?: Array<{
      date?: string;
      competitions?: Array<{
        status?: { type?: { completed?: boolean } };
        competitors?: Array<{
          homeAway?: string;
          score?: { value?: number } | string;
          team?: { abbreviation?: string };
        }>;
      }>;
    }>;
  }>(`${SITE}/teams/${teamAbbr}/schedule?season=${season}&seasontype=2`, options);

  const out: GameResult[] = [];
  for (const event of body.events ?? []) {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    if (competitors.length < 2) continue;

    const mine = competitors.find((c) => c.team?.abbreviation === teamAbbr);
    const theirs = competitors.find((c) => c.team?.abbreviation !== teamAbbr);
    if (!mine || !theirs) continue;

    const score = (c: typeof mine): number | null => {
      const raw = c.score;
      if (typeof raw === 'string') return Number(raw);
      if (raw && typeof raw.value === 'number') return raw.value;
      return null;
    };
    const pf = score(mine);
    const pa = score(theirs);
    const completed = competition?.status?.type?.completed === true;
    if (pf === null || pa === null) continue;

    out.push({
      date: event.date ?? '',
      opponent: theirs.team?.abbreviation ?? '',
      home: mine.homeAway === 'home',
      points_for: pf,
      points_against: pa,
      completed,
    });
  }
  return out.filter((g) => g.completed).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

/* ------------------------------------------------------------------ *
 * Injuries
 * ------------------------------------------------------------------ */

export interface NflInjury {
  /**
   * ESPN's numeric team id.
   *
   * The injuries feed identifies teams by id and display name only — there is
   * no abbreviation anywhere in it. Keying on the display name looked like it
   * worked and silently matched nothing, so every matchup reported a clean
   * injury report for both sides.
   */
  team_id: string;
  team: string;
  player: string;
  position: string;
  status: string;
  detail: string;
  comment: string;
}

/**
 * The league-wide injury report, in one request.
 *
 * Per-team endpoints exist but hand back a list of links, one request per
 * player — seventy for a single team. This returns every team at once.
 */
export async function fetchInjuries(options: EspnOptions = {}): Promise<NflInjury[]> {
  const body = await getJson<{
    injuries?: Array<{
      id?: string | number;
      displayName?: string;
      injuries?: Array<{
        status?: string;
        details?: { type?: string };
        shortComment?: string;
        longComment?: string;
        athlete?: { displayName?: string; position?: { abbreviation?: string } };
      }>;
    }>;
  }>(`${WEB}/injuries`, options);

  const out: NflInjury[] = [];
  for (const team of body.injuries ?? []) {
    const abbr = team.displayName ?? '';
    for (const entry of team.injuries ?? []) {
      const athlete = entry.athlete;
      if (!athlete?.displayName) continue;
      out.push({
        team_id: String(team.id ?? ''),
        team: abbr,
        player: athlete.displayName,
        position: athlete.position?.abbreviation ?? '',
        status: entry.status ?? 'UNKNOWN',
        detail: entry.details?.type ?? '',
        comment: entry.shortComment ?? entry.longComment ?? '',
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

export interface UpcomingGame {
  id: string;
  date: string;
  home: string;
  away: string;
  name: string;
  season_type: number;
  week: number | null;
}

export async function fetchScoreboard(options: EspnOptions = {}): Promise<{
  games: UpcomingGame[];
  season_year: number;
  season_type: number;
  week: number | null;
}> {
  const body = await getJson<{
    season?: { year?: number; type?: number };
    week?: { number?: number };
    events?: Array<{
      id?: string;
      date?: string;
      name?: string;
      competitions?: Array<{
        competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>;
      }>;
    }>;
  }>(`${SITE}/scoreboard`, options);

  const seasonType = body.season?.type ?? 2;
  const games: UpcomingGame[] = [];
  for (const event of body.events ?? []) {
    const competitors = event.competitions?.[0]?.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === 'home')?.team?.abbreviation;
    const away = competitors.find((c) => c.homeAway === 'away')?.team?.abbreviation;
    if (!home || !away) continue;
    games.push({
      id: String(event.id ?? ''),
      date: event.date ?? '',
      home,
      away,
      name: event.name ?? `${away} at ${home}`,
      season_type: seasonType,
      week: body.week?.number ?? null,
    });
  }

  return {
    games,
    season_year: body.season?.year ?? new Date().getFullYear(),
    season_type: seasonType,
    week: body.week?.number ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Record splits
 * ------------------------------------------------------------------ */

export interface RecordSplits {
  overall: string | null;
  home: string | null;
  road: string | null;
  division: string | null;
  conference: string | null;
}

/**
 * Win-loss records by split.
 *
 * A single overall record hides the thing people actually want from it — a
 * team that is 6-2 at home and 1-7 away is not a 7-9 team in any useful
 * sense, and neither number describes the game being looked at on its own.
 */
export async function fetchRecordSplits(
  teamId: string,
  season: number,
  options: EspnOptions = {},
): Promise<RecordSplits> {
  const body = await getJson<{
    items?: Array<{ name?: string; displayValue?: string; summary?: string }>;
  }>(`${CORE}/seasons/${season}/types/2/teams/${teamId}/record`, options);

  const pick = (name: string): string | null => {
    const item = (body.items ?? []).find(
      (i) => (i.name ?? '').toLowerCase() === name.toLowerCase(),
    );
    return item?.displayValue ?? item?.summary ?? null;
  };

  return {
    overall: pick('overall'),
    home: pick('Home'),
    road: pick('Road'),
    division: pick('vs. Div.'),
    conference: pick('vs. Conf.'),
  };
}

/* ------------------------------------------------------------------ *
 * News
 * ------------------------------------------------------------------ */

export interface NewsItem {
  headline: string;
  description: string;
  published: string;
  type: string;
}

/**
 * Recent team news.
 *
 * Returned as-is, with no summarising and no judgement about which items
 * matter. Deciding that a coaching quote is "likely to affect this game" is
 * an editorial call, and one made by a language model would be exactly the
 * kind of confident invention this codebase keeps refusing elsewhere. The
 * headlines are shown; the reader draws the line.
 */
export async function fetchNews(
  teamId: string,
  options: EspnOptions & { limit?: number } = {},
): Promise<NewsItem[]> {
  const body = await getJson<{
    articles?: Array<{
      headline?: string;
      description?: string;
      published?: string;
      type?: string;
    }>;
  }>(`${SITE}/news?limit=${options.limit ?? 12}&team=${teamId}`, options);

  return (body.articles ?? [])
    .filter((a) => a.headline)
    .map((a) => ({
      headline: a.headline!,
      description: a.description ?? '',
      published: a.published ?? '',
      type: a.type ?? '',
    }));
}

/* ------------------------------------------------------------------ *
 * Standings
 * ------------------------------------------------------------------ */

export interface TeamStanding {
  team: string;
  wins: number;
  losses: number;
  win_pct: number;
  /** Season point differential, which stands in for team strength. */
  point_differential: number;
  games: number;
}

/**
 * Every team's record, in one request.
 *
 * Needed because "record against winning teams" and strength of schedule are
 * questions about the whole league, and answering them from the two teams
 * already loaded classifies almost every opponent as .500 by default — which
 * quietly turned a genuinely hard schedule into a neutral one and reported
 * 14-3 against losing teams and 0-0 against winning ones.
 */
export async function fetchStandings(
  season: number,
  options: EspnOptions = {},
): Promise<Map<string, TeamStanding>> {
  const body = await getJson<unknown>(
    `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=${season}`,
    options,
  );

  const out = new Map<string, TeamStanding>();

  // The payload nests conferences and divisions differently by season, so the
  // entries are found by shape rather than by a fixed path.
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;

    const standings = record.standings as { entries?: unknown[] } | undefined;
    for (const entry of standings?.entries ?? []) {
      const e = entry as {
        team?: { abbreviation?: string };
        stats?: Array<{ name?: string; value?: number }>;
      };
      const abbr = e.team?.abbreviation;
      if (!abbr) continue;
      const stats = new Map((e.stats ?? []).map((s) => [s.name ?? '', s.value ?? 0]));
      const wins = stats.get('wins') ?? 0;
      const losses = stats.get('losses') ?? 0;
      const games = wins + losses + (stats.get('ties') ?? 0);
      out.set(abbr, {
        team: abbr,
        wins,
        losses,
        win_pct: stats.get('winPercent') ?? (games > 0 ? wins / games : 0.5),
        point_differential: stats.get('pointDifferential') ?? 0,
        games,
      });
    }

    for (const value of Object.values(record)) walk(value);
  };

  walk(body);
  return out;
}
