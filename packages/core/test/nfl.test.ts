import { describe, expect, it } from 'vitest';
import {
  commonOpponents,
  compareToMarket,
  efficiency,
  guardZeros,
  recordDepth,
  situational,
  specialTeams,
  type StatLookup,
  diffSnapshots,
  headToHead,
  trenchRead,
  turnoverRead,
  injuryPoints,
  marginToWinProbability,
  project,
  snapshotOf,
  windPenalty,
  type MatchupSnapshot,
  type TeamSeasonStats,
} from '../src/index.js';

const team = (over: Partial<TeamSeasonStats>): TeamSeasonStats => ({
  team: 'X', games: 17,
  points_for_per_game: 22.5, points_against_per_game: 22.5,
  yards_per_play: null, yards_per_play_allowed: null,
  third_down_pct: 40, third_down_pct_allowed: null,
  red_zone_td_pct: 55, red_zone_td_pct_allowed: null,
  turnover_margin_per_game: 0, sacks_per_game: 2.5, sacks_allowed_per_game: 2.5,
  pass_yards_per_attempt: 7, pass_yards_per_attempt_allowed: null,
  rush_yards_per_carry: 4.2, rush_yards_per_carry_allowed: null,
  recent_margins: [0, 0, 0],
  ...over,
});

const conditions = {
  temperature: 60, wind_mph: 5, precipitation: 0, indoors: false,
  rest_days: [7, 7] as [number | null, number | null], travel_miles: 500,
};

describe('margin to win probability', () => {
  it('puts a pick-em at even money', () => {
    expect(marginToWinProbability(0)).toBeCloseTo(0.5, 5);
  });

  it('keeps a field goal near sixty percent, not near certainty', () => {
    // The scale is what stops a two-point edge reading as a lock.
    const p = marginToWinProbability(3);
    expect(p).toBeGreaterThan(0.55);
    expect(p).toBeLessThan(0.65);
  });

  it('is symmetric', () => {
    expect(marginToWinProbability(7) + marginToWinProbability(-7)).toBeCloseTo(1, 5);
  });
});

describe('injury weighting', () => {
  it('does not treat a quarterback like a punter', () => {
    expect(injuryPoints('QB', 'Out')).toBeGreaterThan(injuryPoints('P', 'Out') * 10);
  });

  it('scales with how likely the player is to miss the game', () => {
    expect(injuryPoints('QB', 'Out')).toBeGreaterThan(injuryPoints('QB', 'Questionable'));
    expect(injuryPoints('QB', 'Active')).toBe(0);
  });
});

describe('weather', () => {
  it('ignores wind indoors', () => {
    expect(windPenalty(30, true)).toBe(0);
  });

  it('ignores a breeze and takes a real wind seriously', () => {
    expect(windPenalty(8, false)).toBe(0);
    expect(windPenalty(25, false)).toBeGreaterThan(3);
  });
});

describe('projection', () => {
  it('gives the home side the home-field points', () => {
    const p = project({
      home: team({ team: 'H' }), away: team({ team: 'A' }),
      injuries: [], conditions, stats_are_prior_season: false,
    });
    expect(p.margin).toBeCloseTo(2.4, 1);
    expect(p.home_win_probability).toBeGreaterThan(0.5);
  });

  it('adjusts scoring for the defence actually faced', () => {
    // Same offence, different opponent: a soft defence should raise the
    // projection and a strong one lower it.
    const soft = project({
      home: team({ team: 'H' }), away: team({ team: 'A', points_against_per_game: 30 }),
      injuries: [], conditions, stats_are_prior_season: false,
    });
    const tough = project({
      home: team({ team: 'H' }), away: team({ team: 'A', points_against_per_game: 14 }),
      injuries: [], conditions, stats_are_prior_season: false,
    });
    expect(soft.home_points).toBeGreaterThan(tough.home_points);
  });

  it('docks confidence when the numbers are last season\'s', () => {
    const now = project({
      home: team({ team: 'H' }), away: team({ team: 'A' }),
      injuries: [], conditions, stats_are_prior_season: false,
    });
    const prior = project({
      home: team({ team: 'H' }), away: team({ team: 'A' }),
      injuries: [], conditions, stats_are_prior_season: true,
    });
    expect(now.confidence).toBe('GOOD');
    expect(prior.confidence).toBe('LOW');
    expect(prior.confidence_reasons.join(' ')).toContain('last completed season');
  });

  it('names the statistics it does not have', () => {
    const p = project({
      home: team({ team: 'H' }), away: team({ team: 'A' }),
      injuries: [], conditions, stats_are_prior_season: false,
    });
    expect(p.not_modelled.join(' ')).toContain('EPA');
  });
});

describe('what changed', () => {
  const base = (over: Partial<MatchupSnapshot> = {}): MatchupSnapshot => ({
    taken_at: '2026-08-23T00:00:00Z', home: 'KC', away: 'BUF',
    home_win_probability: 0.58, home_points: 27, away_points: 24,
    injuries: [{ player: 'A Smith', team: 'BUF', position: 'CB', status: 'Questionable' }],
    wind_mph: 8, market_home_probability: 0.6, ...over,
  });

  it('reports a ruling-out, a wind jump and a model move', () => {
    const changes = diffSnapshots(
      base(),
      base({
        injuries: [{ player: 'A Smith', team: 'BUF', position: 'CB', status: 'Out' }],
        wind_mph: 17,
        home_win_probability: 0.61,
      }),
    );
    const text = changes.map((c) => c.text).join(' | ');
    expect(text).toContain('questionable → out');
    expect(text).toContain('8 → 17 mph');
    expect(text).toContain('58% → 61%');
  });

  it('stays quiet about noise', () => {
    // A one-mph forecast tweak and a tenth of a point are not news, and a
    // diff that reports them teaches people to stop reading it.
    const changes = diffSnapshots(base(), base({ wind_mph: 9, home_win_probability: 0.582 }));
    expect(changes).toHaveLength(0);
  });

  it('knows which side a change helps', () => {
    const changes = diffSnapshots(
      base(),
      base({ injuries: [{ player: 'A Smith', team: 'BUF', position: 'CB', status: 'Out' }] }),
    );
    // A Buffalo player ruled out helps Kansas City, the home side.
    expect(changes[0]!.direction).toBe('HOME');
  });
});

describe('snapshots', () => {
  it('captures what a later visit will be compared against', () => {
    const p = project({
      home: team({ team: 'KC' }), away: team({ team: 'BUF' }),
      injuries: [], conditions, stats_are_prior_season: false,
    });
    const snap = snapshotOf(p, [], 12, 0.55);
    expect(snap.home).toBe('KC');
    expect(snap.wind_mph).toBe(12);
    expect(snap.market_home_probability).toBe(0.55);
  });
});

describe('context', () => {
  const r = (opponent: string, pf: number, pa: number, date = '2025-10-01') => ({
    date, opponent, home: true, points_for: pf, points_against: pa,
  });

  it('compares two teams against shared opponents and states the sample', () => {
    const read = commonOpponents(
      [r('NO', 10, 30), r('JAX', 14, 20), r('XX', 30, 0)],
      [r('NO', 31, 10), r('JAX', 20, 14)],
    );
    expect(read.opponents).toHaveLength(2);
    expect(read.caveat).toContain('2 shared opponents');
    expect(read.caveat).toContain('no weight');
  });

  it('shows head-to-head and says it carries no weight', () => {
    const h = headToHead([r('BUF', 30, 20), r('MIA', 10, 20)], 'BUF');
    expect(h.home_wins).toBe(1);
    expect(h.note).toContain('no weight');
  });

  it('does not produce a fumble rate above one', () => {
    // Total recoveries over forced fumbles gave "114%": recoveries include a
    // team's own fumbles, the denominator counted only forced ones.
    const t = turnoverRead(0.2, 20, 7);
    expect(t.fumble_recovery_rate).toBeCloseTo(0.65, 2);
    expect(t.luck_note).toContain('luck rather than skill');
  });

  it('calls a near-even recovery rate earned rather than lucky', () => {
    expect(turnoverRead(0.1, 20, 10).luck_note).toContain('earned');
  });

  it('escalates a trench read on line injuries', () => {
    const clean = trenchRead(2.0, 2.7, []);
    const hurt = trenchRead(2.0, 2.7, ['LT A Smith (Out)', 'C B Jones (Out)']);
    expect(clean.severity).toBe('NOTABLE');
    expect(hurt.severity).toBe('SEVERE');
    expect(hurt.detail).toContain('crude stand-in for pressure rate');
  });
});

describe('market comparison', () => {
  it('removes the margin before comparing', () => {
    // Comparing against an un-devigged price manufactures a disagreement the
    // width of the overround on every single game.
    const c = compareToMarket(0.55, { venue: 'v', home_price: 550, away_price: 500 });
    expect(c.overround).toBeCloseTo(1.05, 3);
    expect(c.fair_home_probability).toBeCloseTo(0.5238, 3);
    expect(Math.abs(c.disagreement_points)).toBeLessThan(3.5);
  });

  it('refuses to call a disagreement an edge', () => {
    const c = compareToMarket(0.75, { venue: 'v', home_price: 400, away_price: 620 });
    expect(c.model_leans).toBe('HOME');
    expect(c.note).toContain('not an edge');
  });

  it('says so plainly when model and market agree', () => {
    const c = compareToMarket(0.5, { venue: 'v', home_price: 500, away_price: 500 });
    expect(c.model_leans).toBe('ALIGNED');
  });
});

describe('units', () => {
  const lookup = (data: Record<string, number>): StatLookup => (n) => (n in data ? data[n]! : null);

  it('treats an impossible zero as missing, not as a number', () => {
    // A team does not run zero drives or allow zero points across a season.
    // ESPN carries these fields and leaves them at zero, which turned yards
    // per drive into a division by nothing.
    const g = guardZeros(lookup({ totalDrives: 0, pointsAllowed: 0, thirdDownConvs: 0 }));
    expect(g('totalDrives')).toBeNull();
    expect(g('pointsAllowed')).toBeNull();
    // A genuine zero on a stat that can be zero stays zero.
    expect(g('thirdDownConvs')).toBe(0);
  });

  it('reads a kicker by distance rather than in aggregate', () => {
    // 85% of chip shots and 85% including a dozen fifty-yarders are
    // different kickers, and only one of them changes what a stalled drive
    // near midfield is worth.
    const st = specialTeams('X', lookup({
      fieldGoalsMade20_29: 6, fieldGoalAttempts20_29: 6,
      fieldGoalsMade50: 9, fieldGoalAttempts50: 14,
    }), []);
    expect(st.field_goals.find((b) => b.label === '50+')!.pct).toBeCloseTo(0.643, 2);
    expect(st.notes.join(' ')).toContain('Shaky from 50+');
  });

  it('falls back to a derived points-allowed when the feed is silent', () => {
    const e = efficiency('X', lookup({ pointsAllowed: 0, totalPointsPerGame: 24 }), 17, 28.1);
    expect(e.points_allowed_per_game).toBe(28.1);
    expect(e.points_allowed_is_derived).toBe(true);
    expect(e.notes.join(' ')).toContain('per-possession rates are absent');
  });

  it('separates settling for three from finishing drives', () => {
    const good = situational('X', lookup({ redzoneTouchdownPct: 65, redzoneFieldGoalPct: 25 }), 17);
    const bad = situational('Y', lookup({ redzoneTouchdownPct: 45, redzoneFieldGoalPct: 40 }), 17);
    expect(good.notes.join(' ')).toContain('Finishes drives');
    expect(bad.notes.join(' ')).toContain('Settles for three');
  });
});

describe('record depth', () => {
  const r = (opponent: string, pf: number, pa: number) => ({
    date: '2025-10-01', opponent, home: true, points_for: pf, points_against: pa,
  });

  it('splits a record by the quality of who it was built against', () => {
    // Two 9-8 teams are the same standings line and different teams.
    const results = [r('GOOD', 10, 30), r('GOOD2', 14, 20), r('BAD', 30, 3), r('BAD2', 24, 10)];
    const winPct = new Map([['GOOD', 0.8], ['GOOD2', 0.7], ['BAD', 0.2], ['BAD2', 0.3]]);
    const margins = new Map([['GOOD', 8], ['GOOD2', 6], ['BAD', -9], ['BAD2', -7]]);
    const d = recordDepth('X', results, winPct, margins);
    expect(d.vs_winning).toBe('0-2');
    expect(d.vs_losing).toBe('2-0');
    expect(d.strength_of_schedule).toBeCloseTo(-0.5, 1);
  });

  it('counts the last five and ten separately', () => {
    const results = Array.from({ length: 12 }, (_, i) => r(`T${i}`, i < 5 ? 30 : 3, 10));
    const d = recordDepth('X', results, new Map(), new Map());
    expect(d.last_5).toBe('5-0');
    expect(d.last_10).toBe('5-5');
  });
});
