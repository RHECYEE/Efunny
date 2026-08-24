/**
 * Career statistics from UFCStats.
 *
 * The site is behind a browser check, so this drives a real browser rather
 * than fetching. That makes it expensive — one page load per fighter — so it
 * is bounded to the fighters actually on an upcoming card and cached to disk
 * between runs. A fighter's career averages move once every few months.
 *
 * What matters here is not the headline percentages but the fight-by-fight
 * table underneath them, which lists takedowns, knockdowns and submission
 * attempts *for both fighters in every bout*. That table is what turns "85%
 * takedown defence" from a number into a claim with a denominator.
 */

export interface CareerStats {
  /** Significant strikes landed per minute. */
  slpm: number | null;
  strike_accuracy: number | null;
  /** Significant strikes absorbed per minute. */
  sapm: number | null;
  strike_defence: number | null;
  /** Takedowns landed per 15 minutes. */
  td_per15: number | null;
  td_accuracy: number | null;
  /** Share of opponent takedown attempts that did not land. */
  td_defence: number | null;
  /** Submission attempts per 15 minutes. */
  sub_per15: number | null;
  height_inches: number | null;
  reach_inches: number | null;
  stance: string | null;
  dob: string | null;
}

export interface FightRecord {
  result: 'WIN' | 'LOSS' | 'DRAW' | 'NC';
  opponent: string;
  /** Knockdowns landed by this fighter, and by the opponent. */
  knockdowns: [number, number];
  significant_strikes: [number, number];
  /** Takedowns landed by this fighter, and by the opponent. */
  takedowns: [number, number];
  submission_attempts: [number, number];
  method: string;
  round: number | null;
  event: string;
}

export interface FighterProfile {
  name: string;
  url: string;
  stats: CareerStats;
  fights: FightRecord[];
}

function num(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace('%', '').trim();
  if (cleaned === '' || cleaned === '--') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** `5' 10"` -> 70. */
export function parseHeight(text: string): number | null {
  const m = text.match(/(\d+)'\s*(\d+)?/);
  if (!m) return null;
  return Number(m[1]) * 12 + Number(m[2] ?? 0);
}

/**
 * Parse the career box and fight table out of a rendered page's text.
 *
 * Kept separate from the browser so it can be tested against a captured
 * page without a network or a browser anywhere in sight.
 */
export function parseCareerStats(bodyText: string): CareerStats {
  const field = (label: string): string | undefined => {
    const m = bodyText.match(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*([^\\n]+)`));
    return m?.[1]?.trim();
  };
  const pct = (label: string): number | null => {
    const raw = field(label);
    const v = num(raw?.split(/\s/)[0]);
    return v === null ? null : v / 100;
  };

  // Labels are given plainly. `field` escapes them for the regex exactly
  // once — passing pre-escaped labels here escaped the backslashes as well,
  // so every statistic whose name contains a full stop silently read null
  // while the handful without one parsed fine. The result looked like a
  // fighter with no takedown record rather than like a broken parser.
  return {
    slpm: num(field('SLpM')?.split(/\s/)[0]),
    strike_accuracy: pct('Str. Acc.'),
    sapm: num(field('SApM')?.split(/\s/)[0]),
    strike_defence: pct('Str. Def'),
    td_per15: num(field('TD Avg.')?.split(/\s/)[0]),
    td_accuracy: pct('TD Acc.'),
    td_defence: pct('TD Def.'),
    sub_per15: num(field('Sub. Avg.')?.split(/\s/)[0]),
    height_inches: field('HEIGHT') ? parseHeight(field('HEIGHT')!) : null,
    reach_inches: num(field('REACH')?.replace('"', '')),
    stance: field('STANCE') ?? null,
    dob: field('DOB') ?? null,
  };
}

/**
 * One row of the fight table into a record.
 *
 * Each statistical cell holds two numbers — this fighter's, then the
 * opponent's — which is the whole reason this table is worth parsing.
 */
export function parseFightRow(cells: string[], fighterName: string): FightRecord | null {
  if (cells.length < 10) return null;
  const pair = (text: string): [number, number] => {
    const parts = text.split(/\s+/).map((x) => Number(x));
    return [Number.isFinite(parts[0]!) ? parts[0]! : 0, Number.isFinite(parts[1]!) ? parts[1]! : 0];
  };

  const names = cells[1] ?? '';
  const opponent = names.replace(fighterName, '').trim();
  const result = (cells[0] ?? '').toUpperCase();

  return {
    result: result.startsWith('WIN')
      ? 'WIN'
      : result.startsWith('LOSS')
        ? 'LOSS'
        : result.startsWith('DRAW')
          ? 'DRAW'
          : 'NC',
    opponent,
    knockdowns: pair(cells[2] ?? ''),
    significant_strikes: pair(cells[3] ?? ''),
    takedowns: pair(cells[4] ?? ''),
    submission_attempts: pair(cells[5] ?? ''),
    method: (cells[7] ?? '').trim(),
    round: num(cells[8] ?? ''),
    event: (cells[6] ?? '').trim(),
  };
}

/* ------------------------------------------------------------------ *
 * Browser-driven fetch
 * ------------------------------------------------------------------ */

export interface UfcStatsOptions {
  /** Injected so the core package never depends on a browser. */
  launch: () => Promise<UfcStatsBrowser>;
  /** Per-page budget. */
  timeout_ms?: number;
}

/** The narrow slice of a browser this needs, so Playwright stays optional. */
export interface UfcStatsBrowser {
  /** Load a URL and return the rendered body text plus table rows. */
  read(url: string): Promise<{ text: string; rows: string[][]; links: Array<{ href: string; text: string }> }>;
  close(): Promise<void>;
}

const SEARCH = 'http://ufcstats.com/statistics/fighters/search?query=';

/**
 * Find a fighter's page by surname, then confirm by full name.
 *
 * Searching the surname and filtering afterwards is deliberate: the site's
 * search splits a fighter's name across several links to the same page, so
 * matching on the link text alone picks up fragments like "de Oliveira" and
 * nicknames. The page URL is the identity; the text is only a hint.
 */
export async function findFighter(
  browser: UfcStatsBrowser,
  name: string,
): Promise<string | null> {
  const parts = name.trim().split(/\s+/);
  const surname = parts[parts.length - 1] ?? name;
  const { links } = await browser.read(SEARCH + encodeURIComponent(surname));

  const wanted = name.toLowerCase().replace(/[^a-z ]/g, '');
  // Group the fragments back onto their pages, then look for one whose
  // combined text contains every part of the name we were given.
  const byHref = new Map<string, string>();
  for (const link of links) {
    if (!/fighter-details/.test(link.href)) continue;
    byHref.set(link.href, `${byHref.get(link.href) ?? ''} ${link.text}`.toLowerCase());
  }
  for (const [href, text] of byHref) {
    const clean = text.replace(/[^a-z ]/g, '');
    if (parts.every((p) => clean.includes(p.toLowerCase().replace(/[^a-z]/g, '')))) return href;
  }
  // Fall back to a surname-only hit, which is right far more often than not
  // on a card where only one fighter carries that name.
  for (const [href, text] of byHref) {
    if (text.includes(surname.toLowerCase())) return href;
  }
  void wanted;
  return null;
}

export async function fetchProfile(
  browser: UfcStatsBrowser,
  name: string,
): Promise<FighterProfile | null> {
  const url = await findFighter(browser, name);
  if (!url) return null;
  const { text, rows } = await browser.read(url);

  const fights: FightRecord[] = [];
  for (const row of rows) {
    const record = parseFightRow(row, name);
    if (record) fights.push(record);
  }

  const stats = parseCareerStats(text);

  /**
   * A page that yielded nothing is not a fighter who does nothing.
   *
   * When the load fails or the browser check has not cleared, every field
   * comes back null and every derived count comes back zero — and zero then
   * gets *stated*, as "0% of takedowns stopped across 0 fights". That is a
   * confident claim manufactured out of a failed request, and it is the third
   * time this shape of bug has appeared in this codebase. An empty profile is
   * reported as absent so the screen can say it has no data.
   */
  const anyStat = [stats.slpm, stats.td_per15, stats.td_defence, stats.strike_accuracy].some(
    (v) => v !== null,
  );
  if (!anyStat && fights.length === 0) return null;

  return { name, url, stats, fights };
}

/* ------------------------------------------------------------------ *
 * Fight detail
 * ------------------------------------------------------------------ */

/**
 * One fighter's line from a single bout, round by round.
 *
 * This is where the statistics the career page cannot summarise live:
 * takedowns *attempted* rather than only landed, control time, reversals,
 * and the round splits that show whether output held up. One page load per
 * fight, which is why it is fetched on demand rather than for a whole card.
 */
export interface RoundLine {
  round: number;
  knockdowns: number;
  significant_strikes_landed: number;
  significant_strikes_attempted: number;
  takedowns_landed: number;
  takedowns_attempted: number;
  submission_attempts: number;
  reversals: number;
  /** Seconds of control. */
  control_seconds: number;
}

export interface FightDetail {
  url: string;
  /** Index 0 is the fighter whose page this was reached from. */
  fighters: [string, string];
  /** Their pages, which is the only identity on this site that is unambiguous. */
  fighter_urls: [string, string];
  /** Per-fighter, per-round lines. */
  rounds: [RoundLine[], RoundLine[]];
}

/** `2 of 7` -> [2, 7]. */
export function parseOfPair(text: string): [number, number] {
  const m = text.match(/(\d+)\s+of\s+(\d+)/);
  if (!m) return [0, 0];
  return [Number(m[1]), Number(m[2])];
}

/** `2:49` -> 169. Returns 0 for `--`. */
export function parseClock(text: string): number {
  const m = text.trim().match(/^(\d+):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Split a cell holding both fighters' values.
 *
 * Every statistical cell on this page contains two entries — the first
 * fighter's then the second's — which is what makes the table worth parsing
 * and also what makes it easy to attribute a number to the wrong man.
 */
function splitPair(cell: string): [string, string] {
  // Values are separated by whitespace, but each may itself contain spaces
  // ("2 of 7"), so split on the "of" pattern where present.
  const ofMatches = [...cell.matchAll(/\d+\s+of\s+\d+/g)].map((m) => m[0]);
  if (ofMatches.length >= 2) return [ofMatches[0]!, ofMatches[1]!];
  const clocks = [...cell.matchAll(/\d+:\d{2}/g)].map((m) => m[0]);
  if (clocks.length >= 2) return [clocks[0]!, clocks[1]!];
  const parts = cell.trim().split(/\s+/);
  if (parts.length >= 2) return [parts[0]!, parts[1]!];
  return [cell.trim(), cell.trim()];
}

/**
 * Round lines for both fighters in one bout.
 *
 * The page repeats its table: a totals block, then a per-round block, then
 * the same again for strike location. Only the per-round totals block is
 * read, identified by having a control-time column and more than one row.
 */
export function parseFightDetail(
  url: string,
  rows: string[][],
  /** Fighter-page links from the same document, in column order. */
  persons: Array<{ href: string; text: string }>,
): FightDetail | null {
  // Rows with ten cells are the totals/round lines; the first is the bout
  // total and the rest are individual rounds. A bout that has not happened
  // yet has neither — the page shows a pre-fight comparison of three-cell
  // rows instead, and falls out here.
  const lines = rows.filter((r) => r.length >= 10 && /\d+:\d{2}/.test(r[9] ?? ''));
  if (lines.length < 2) return null;

  // Identity comes from the two fighter links, never from splitting the name
  // cell: "Dan Hooker Benoit Saint Denis" has no separator, and any rule for
  // cutting it in half attributes every number in the bout to the wrong man
  // as soon as one surname has an extra word.
  const seen: Array<{ href: string; text: string }> = [];
  for (const link of persons) {
    if (!/fighter-details/.test(link.href)) continue;
    if (!seen.some((s) => s.href === link.href)) seen.push(link);
  }
  if (seen.length < 2) return null;

  const perRound = lines.slice(1);

  const build = (index: 0 | 1): RoundLine[] =>
    perRound.map((cells, i) => {
      const sig = parseOfPair(splitPair(cells[2] ?? '')[index]);
      // Column 4 is total strikes and column 5 is takedowns. They look alike
      // — both are "n of m" pairs — and reading the wrong one turns fifty
      // punches into fifty takedown attempts.
      const td = parseOfPair(splitPair(cells[5] ?? '')[index]);
      return {
        round: i + 1,
        knockdowns: Number(splitPair(cells[1] ?? '')[index]) || 0,
        significant_strikes_landed: sig[0],
        significant_strikes_attempted: sig[1],
        takedowns_landed: td[0],
        takedowns_attempted: td[1],
        submission_attempts: Number(splitPair(cells[7] ?? '')[index]) || 0,
        reversals: Number(splitPair(cells[8] ?? '')[index]) || 0,
        control_seconds: parseClock(splitPair(cells[9] ?? '')[index]),
      };
    });

  return {
    url,
    fighters: [seen[0]!.text, seen[1]!.text],
    fighter_urls: [seen[0]!.href, seen[1]!.href],
    rounds: [build(0), build(1)],
  };
}

/** Put the fighter whose page we came from in slot zero. */
function orient(detail: FightDetail, fighterUrl: string): FightDetail | null {
  const id = fighterUrl.split('/').pop();
  const index = detail.fighter_urls.findIndex((u) => u.split('/').pop() === id);
  if (index < 0) return null;
  if (index === 0) return detail;
  return {
    ...detail,
    fighters: [detail.fighters[1], detail.fighters[0]],
    fighter_urls: [detail.fighter_urls[1], detail.fighter_urls[0]],
    rounds: [detail.rounds[1], detail.rounds[0]],
  };
}

export async function fetchFightDetails(
  browser: UfcStatsBrowser,
  fighterUrl: string,
  limit = 5,
): Promise<FightDetail[]> {
  const { links } = await browser.read(fighterUrl);
  const fightLinks = [...new Set(links.map((l) => l.href).filter((h) => /fight-details/.test(h)))];

  const out: FightDetail[] = [];
  // The most recent link may be a booked fight with no statistics yet, so a
  // couple of spare page loads are allowed rather than returning a short
  // sample. Still bounded: this costs seconds per page.
  for (const link of fightLinks.slice(0, limit + 3)) {
    if (out.length >= limit) break;
    try {
      const { rows, links: pageLinks } = await browser.read(link);
      const detail = parseFightDetail(link, rows, pageLinks);
      if (!detail) continue;
      const oriented = orient(detail, fighterUrl);
      if (oriented) out.push(oriented);
    } catch {
      // One unreadable bout is a smaller sample, not a failure.
    }
  }
  return out;
}
