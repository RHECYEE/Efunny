import { describe, expect, it } from 'vitest';
import {
  diffSnapshots,
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
