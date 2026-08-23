import { describe, expect, it } from 'vitest';
import {
  assignRoles,
  computeMismatch,
  defenceConfidence,
  estimateAttemptsFaced,
  mismatchLabel,
  type FighterStats,
} from '../src/index.js';

const base: FighterStats = {
  name: 'x', td_per15: 0, td_accuracy: 0.3, td_defence: 0.6, sub_per15: 0,
  slpm: 3, sapm: 3, strike_accuracy: 0.5, strike_defence: 0.5,
  reach_inches: 72, height_inches: 70,
  fights_counted: 20, takedowns_conceded: 10, knockdowns_landed: 5,
  knockdowns_absorbed: 5, ko_wins: 5, submission_wins: 2, wins: 12,
};
const f = (over: Partial<FighterStats>): FighterStats => ({ ...base, ...over });

describe('who is the grappler', () => {
  it('is decided by takedown pressure, never by a label', () => {
    const wrestler = f({ name: 'wrestler', td_per15: 4.2, sub_per15: 0.3 });
    const striker = f({ name: 'striker', td_per15: 0.2, sub_per15: 0 });
    expect(assignRoles(wrestler, striker).grappler?.name).toBe('wrestler');
  });

  it('does not make a submission specialist the wrestler when he cannot get it there', () => {
    // The distinction the whole model exists for. A BJJ black belt averaging
    // 0.4 takedowns per 15 minutes only grapples when the other man agrees,
    // and against a superior striker that is the wrong side of the thesis.
    const bjj = f({ name: 'bjj', td_per15: 0.4, sub_per15: 2.8, submission_wins: 9 });
    const striker = f({ name: 'striker', td_per15: 0.3, sub_per15: 0 });
    const m = computeMismatch(bjj, striker);
    expect(m.no_grappler).toBe(true);
    expect(m.score).toBe(0);
    expect(m.role_basis).toContain('forcing the fight to the floor');
  });

  it('says so plainly when two strikers meet', () => {
    const m = computeMismatch(f({ name: 'a', td_per15: 0.11 }), f({ name: 'b', td_per15: 0.05 }));
    expect(m.no_grappler).toBe(true);
    expect(m.components).toHaveLength(0);
  });
});

describe('takedown defence needs a denominator', () => {
  it('recovers attempts faced from defence and takedowns conceded', () => {
    // 85% stopped with 3 conceded implies roughly 20 attempts faced.
    const s = f({ td_defence: 0.85, takedowns_conceded: 3 });
    expect(estimateAttemptsFaced(s)).toBeCloseTo(20, 0);
  });

  it('trusts a well-tested defence more than an untested one', () => {
    expect(defenceConfidence(50)).toBe(1);
    expect(defenceConfidence(7)).toBeLessThan(0.2);
    expect(defenceConfidence(null)).toBeLessThan(0.5);
  });

  it('discounts a spotless record built on almost no attempts', () => {
    const wrestler = f({ name: 'w', td_per15: 4 });
    const tested = f({ name: 'tested', td_per15: 0.2, td_defence: 0.85, takedowns_conceded: 8, fights_counted: 25 });
    const untested = f({ name: 'untested', td_per15: 0.2, td_defence: 0.85, takedowns_conceded: 1, fights_counted: 4 });

    const a = computeMismatch(wrestler, tested);
    const b = computeMismatch(wrestler, untested);
    const gapOf = (m: typeof a) => m.components.find((c) => c.name === 'td_defence')!.value!;
    // The untested 85% is pulled toward neutral rather than believed.
    expect(gapOf(b)).toBeGreaterThan(gapOf(a));
  });
});

describe('scoring', () => {
  it('narrows the mismatch when the striker can punch', () => {
    const wrestler = f({ name: 'w', td_per15: 4.5, sub_per15: 1.5 });
    const harmless = f({ name: 'harmless', td_per15: 0.2, td_defence: 0.5, ko_wins: 0, knockdowns_landed: 0, wins: 12 });
    const dangerous = f({ name: 'dangerous', td_per15: 0.2, td_defence: 0.5, ko_wins: 11, knockdowns_landed: 14, wins: 12 });
    expect(computeMismatch(wrestler, dangerous).score).toBeLessThan(
      computeMismatch(wrestler, harmless).score,
    );
  });

  it('does not score a missing statistic as a weak matchup', () => {
    // Renormalising over present components stops a fighter with thin data
    // from being systematically buried.
    const wrestler = f({ name: 'w', td_per15: 4.5 });
    const partial = f({ name: 'p', td_per15: 0.2, td_defence: null, td_accuracy: null });
    expect(computeMismatch(wrestler, partial).score).toBeGreaterThan(0);
  });

  it('never claims a win probability', () => {
    const m = computeMismatch(f({ name: 'w', td_per15: 4.5 }), f({ name: 's', td_per15: 0.2 }));
    expect(mismatchLabel(m.score)).toBeTruthy();
    expect(JSON.stringify(m).toLowerCase()).not.toContain('win_probability');
  });
});
