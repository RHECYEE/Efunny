import type { InjuryImpact, Projection } from './projection.js';

/**
 * What changed since last time.
 *
 * The difference between a stats page and a research assistant. Reopening a
 * matchup six hours later should not mean rereading it — it should say that a
 * cornerback is out, the wind forecast doubled, the line moved a point and
 * the model moved three, and let the reader decide whether any of that
 * matters.
 *
 * Only material changes are reported. A wind forecast that moved by one mile
 * an hour and a win probability that moved by a tenth of a point are noise,
 * and a diff that reports them trains people to stop reading it.
 */

export interface MatchupSnapshot {
  taken_at: string;
  home: string;
  away: string;
  home_win_probability: number;
  home_points: number;
  away_points: number;
  injuries: Array<{ player: string; team: string; position: string; status: string }>;
  wind_mph: number | null;
  /** Market view at snapshot time, when a venue priced it. */
  market_home_probability: number | null;
}

export interface Change {
  kind: 'INJURY' | 'WEATHER' | 'MARKET' | 'MODEL';
  text: string;
  /** Signed effect on the home side where one applies. */
  direction: 'HOME' | 'AWAY' | 'NEUTRAL';
}

/** Below these, a change is not worth a line. */
const THRESHOLDS = {
  /** Win probability, in percentage points. */
  model: 1.5,
  market: 1.5,
  wind_mph: 4,
};

export function snapshotOf(
  projection: Projection,
  injuries: InjuryImpact[],
  windMph: number | null,
  marketHomeProbability: number | null,
): MatchupSnapshot {
  return {
    taken_at: new Date().toISOString(),
    home: projection.home,
    away: projection.away,
    home_win_probability: projection.home_win_probability,
    home_points: projection.home_points,
    away_points: projection.away_points,
    injuries: injuries.map((i) => ({
      player: i.player,
      team: i.team,
      position: i.position,
      status: i.status,
    })),
    wind_mph: windMph,
    market_home_probability: marketHomeProbability,
  };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function diffSnapshots(before: MatchupSnapshot, after: MatchupSnapshot): Change[] {
  const changes: Change[] = [];

  /* --- injuries: new, resolved, and re-graded ----------------------- */
  const key = (i: MatchupSnapshot['injuries'][number]) => `${i.team}|${i.player}`;
  const beforeByKey = new Map(before.injuries.map((i) => [key(i), i]));
  const afterByKey = new Map(after.injuries.map((i) => [key(i), i]));

  for (const [k, now] of afterByKey) {
    const then = beforeByKey.get(k);
    if (!then) {
      changes.push({
        kind: 'INJURY',
        text: `${now.team} ${now.position} ${now.player} added to the report as ${now.status.toLowerCase()}`,
        direction: now.team === after.home ? 'AWAY' : 'HOME',
      });
    } else if (then.status !== now.status) {
      // A status moving toward OUT hurts that team; toward ACTIVE helps.
      const worse = severity(now.status) > severity(then.status);
      changes.push({
        kind: 'INJURY',
        text:
          `${now.team} ${now.position} ${now.player} ${then.status.toLowerCase()} → ` +
          `${now.status.toLowerCase()}`,
        direction: worse
          ? now.team === after.home
            ? 'AWAY'
            : 'HOME'
          : now.team === after.home
            ? 'HOME'
            : 'AWAY',
      });
    }
  }
  for (const [k, then] of beforeByKey) {
    if (!afterByKey.has(k)) {
      changes.push({
        kind: 'INJURY',
        text: `${then.team} ${then.position} ${then.player} off the report`,
        direction: then.team === after.home ? 'HOME' : 'AWAY',
      });
    }
  }

  /* --- weather ------------------------------------------------------ */
  if (
    before.wind_mph !== null &&
    after.wind_mph !== null &&
    Math.abs(after.wind_mph - before.wind_mph) >= THRESHOLDS.wind_mph
  ) {
    changes.push({
      kind: 'WEATHER',
      text: `Wind forecast ${Math.round(before.wind_mph)} → ${Math.round(after.wind_mph)} mph`,
      direction: 'NEUTRAL',
    });
  }

  /* --- market ------------------------------------------------------- */
  if (
    before.market_home_probability !== null &&
    after.market_home_probability !== null &&
    Math.abs(after.market_home_probability - before.market_home_probability) * 100 >=
      THRESHOLDS.market
  ) {
    const up = after.market_home_probability > before.market_home_probability;
    changes.push({
      kind: 'MARKET',
      text:
        `Market ${after.home} ${pct(before.market_home_probability)} → ` +
        `${pct(after.market_home_probability)}`,
      direction: up ? 'HOME' : 'AWAY',
    });
  }

  /* --- the model itself --------------------------------------------- */
  if (
    Math.abs(after.home_win_probability - before.home_win_probability) * 100 >=
    THRESHOLDS.model
  ) {
    const up = after.home_win_probability > before.home_win_probability;
    changes.push({
      kind: 'MODEL',
      text:
        `Model ${after.home} ${pct(before.home_win_probability)} → ` +
        `${pct(after.home_win_probability)}`,
      direction: up ? 'HOME' : 'AWAY',
    });
  }

  return changes;
}

/** Higher means less likely to play. */
function severity(status: string): number {
  const s = status.toUpperCase();
  if (/OUT|IR|PUP|SUSPEN/.test(s)) return 3;
  if (/DOUBT/.test(s)) return 2;
  if (/QUESTION/.test(s)) return 1;
  return 0;
}
