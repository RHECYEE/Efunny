/**
 * The reads the career page cannot summarise.
 *
 * A fighter's career box gives averages. It cannot say whether he keeps
 * shooting after a stuffed attempt, how long he holds people once he gets
 * there, whether he gets back up, or whether any of it survives into the
 * third round. Those come out of the per-round lines from individual bouts,
 * one page each, which is why this is computed on demand rather than for a
 * whole card.
 *
 * Get-up ability in particular is the piece a takedown-defence percentage
 * misses entirely: a fighter can be taken down twice and lose four seconds or
 * eight minutes, and only one of those decides rounds.
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
  control_seconds: number;
}

export interface FightLines {
  /** This fighter's rounds, then the opponent's, from the same bout. */
  own: RoundLine[];
  opponent: RoundLine[];
}

export interface DeepRead {
  fights_read: number;
  rounds_read: number;

  /* --- pressure ---------------------------------------------------- */
  /** Takedown attempts per fifteen minutes, landed or not. */
  takedown_attempts_per15: number | null;
  /**
   * Attempts after the first in the same round — whether he re-shoots.
   *
   * The difference between pressure and a single look. A fighter with one
   * attempt a round and a fighter with four have the same landed count when
   * the first one connects, and completely different fights when he does not.
   */
  reshoot_rate: number | null;

  /* --- control ----------------------------------------------------- */
  /** Seconds of control per takedown landed. */
  control_per_takedown: number | null;
  control_seconds_per_round: number | null;
  /** Seconds spent controlled by opponents, per round. */
  controlled_seconds_per_round: number | null;
  /**
   * Reversals and escapes per round spent underneath.
   *
   * The get-up read. Low here with high controlled time is a fighter who
   * stays where he is put.
   */
  escape_rate: number | null;
  /**
   * Rounds this was measured over — the denominator, which has to travel
   * with the rate.
   *
   * Zero reversals across two rounds on the bottom and zero across twenty
   * are the same number and completely different evidence, exactly as an
   * 85% takedown defence means one thing against seven career attempts and
   * another against fifty.
   */
  held_rounds: number;

  /* --- output ------------------------------------------------------ */
  /**
   * Significant strikes per round in each bout's early rounds against its
   * late ones, pooled across bouts. Within a fight, never across them.
   */
  output_first_half: number | null;
  output_second_half: number | null;
  /** Negative means output fell as fights wore on. */
  cardio_drift: number | null;

  notes: string[];
  gaps: string[];
}

const ROUND_SECONDS = 300;

function sum(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0);
}

export function computeDeepRead(fights: FightLines[]): DeepRead {
  const own = fights.flatMap((f) => f.own);
  const opp = fights.flatMap((f) => f.opponent);
  const rounds = own.length;

  const gaps = [
    'Position underneath is inferred from control time and reversals; the site does not publish guard, mount or back time separately.',
    'A round ended by stoppage is a short round, and the page does not say how short. Late-round output is understated wherever a fight was finished early.',
    'Short-notice bookings, weight-cut trouble and camp changes are nowhere in this data.',
  ];

  if (rounds === 0) {
    return {
      fights_read: 0,
      rounds_read: 0,
      takedown_attempts_per15: null,
      reshoot_rate: null,
      control_per_takedown: null,
      control_seconds_per_round: null,
      controlled_seconds_per_round: null,
      escape_rate: null,
      held_rounds: 0,
      output_first_half: null,
      output_second_half: null,
      cardio_drift: null,
      notes: [],
      gaps,
    };
  }

  const minutes = (rounds * ROUND_SECONDS) / 60;
  const attempts = sum(own.map((r) => r.takedowns_attempted));
  const landed = sum(own.map((r) => r.takedowns_landed));
  const control = sum(own.map((r) => r.control_seconds));
  const controlled = sum(opp.map((r) => r.control_seconds));
  const reversals = sum(own.map((r) => r.reversals));

  /**
   * Re-shooting, approximated by attempts beyond one per round.
   *
   * A round with three attempts contains two re-shoots. Crude, because the
   * page does not order events within a round, but it separates a fighter who
   * looks once from one who keeps coming.
   */
  const extraAttempts = sum(own.map((r) => Math.max(0, r.takedowns_attempted - 1)));
  const roundsWithAttempt = own.filter((r) => r.takedowns_attempted > 0).length;

  // Rounds where the opponent held control long enough for getting up to be
  // the question at all. Two of them minimum before a rate is quoted: one
  // round underneath is an anecdote, and "0% escapes" off it reads as a fact.
  const heldRounds = opp.filter((r) => r.control_seconds >= 30).length;
  const HELD_ROUNDS_FLOOR = 2;

  /**
   * Output early against late, split *within each bout*.
   *
   * Splitting the pooled round list instead compares recent fights against
   * older ones, because the rounds arrive fight by fight in date order — it
   * read a fighter's last two wins against his last three losses and called
   * the gap cardio. The question is whether a man fades inside a fight, so
   * the split has to happen inside one.
   *
   * Bouts of a single round say nothing either way and are left out.
   */
  let earlyStrikes = 0;
  let earlyRounds = 0;
  let lateStrikes = 0;
  let lateRounds = 0;
  for (const fight of fights) {
    if (fight.own.length < 2) continue;
    const split = Math.ceil(fight.own.length / 2);
    for (const [i, r] of fight.own.entries()) {
      if (i < split) {
        earlyStrikes += r.significant_strikes_landed;
        earlyRounds += 1;
      } else {
        lateStrikes += r.significant_strikes_landed;
        lateRounds += 1;
      }
    }
  }
  const outputFirst = earlyRounds > 0 ? earlyStrikes / earlyRounds : null;
  const outputSecond = lateRounds > 0 ? lateStrikes / lateRounds : null;

  const notes: string[] = [];

  const perTakedown = landed > 0 ? control / landed : null;
  const controlPerRound = rounds > 0 ? control / rounds : null;

  /*
   * How much of the fight he spends on top, said with the right denominator.
   *
   * Control per takedown alone reads backwards: a fighter who takes you down
   * five times and holds five minutes scores lower on it than one who takes
   * you down once and holds four, even though the first controlled more of
   * the fight. Each new takedown means the last position ended. So the
   * "does he hold people" claim rests on control per round, and control per
   * takedown is quoted only for what it actually measures — whether an
   * individual takedown sticks.
   */
  if (controlPerRound !== null && controlPerRound >= 90) {
    notes.push(
      `Holds position: ${Math.round(controlPerRound)} seconds of control a round. Putting ` +
        `somebody down and keeping them there are different skills, and judges reward the second.`,
    );
  } else if (controlPerRound !== null && landed > 0 && controlPerRound < 30) {
    notes.push(
      `Takes down but does not hold: ${Math.round(controlPerRound)} seconds of control a round ` +
        `off ${landed} takedowns. Position without offence wins fewer rounds than the takedown ` +
        `count suggests.`,
    );
  }
  if (perTakedown !== null && landed >= 3 && perTakedown < 30) {
    notes.push(
      `Each takedown is short-lived — ${Math.round(perTakedown)} seconds on average before the ` +
        `position is lost. Volume rather than a hold.`,
    );
  }

  const controlledPerRound = rounds > 0 ? controlled / rounds : null;
  const escape = heldRounds >= HELD_ROUNDS_FLOOR ? reversals / heldRounds : null;
  if (controlledPerRound !== null && controlledPerRound >= 45) {
    if (escape === null) {
      // Time underneath is real, but spread over too few rounds to say
      // anything about whether he gets up.
      notes.push(
        `Spends ${Math.round(controlledPerRound)} seconds a round underneath, across too few ` +
          `rounds on the bottom to read his get-ups either way.`,
      );
    } else {
      notes.push(
        escape < 0.3
          ? `Spends ${Math.round(controlledPerRound)} seconds a round underneath and reverses ` +
            `rarely — he tends to stay where he is put.`
          : `Spends ${Math.round(controlledPerRound)} seconds a round underneath but works back ` +
            `up.`,
      );
    }
  }

  if (outputFirst !== null && outputSecond !== null) {
    const drift = outputSecond - outputFirst;
    if (Math.abs(drift) >= 4) {
      notes.push(
        drift < 0
          ? `Output falls from ${outputFirst.toFixed(0)} to ${outputSecond.toFixed(0)} ` +
            `significant strikes a round in the later rounds.`
          : `Output rises from ${outputFirst.toFixed(0)} to ${outputSecond.toFixed(0)} ` +
            `significant strikes a round as fights go on.`,
      );
    }
  }

  return {
    fights_read: fights.length,
    rounds_read: rounds,
    takedown_attempts_per15: minutes > 0 ? (attempts * 15) / minutes : null,
    reshoot_rate: roundsWithAttempt > 0 ? extraAttempts / roundsWithAttempt : null,
    control_per_takedown: perTakedown,
    control_seconds_per_round: rounds > 0 ? control / rounds : null,
    controlled_seconds_per_round: controlledPerRound,
    escape_rate: escape,
    held_rounds: heldRounds,
    output_first_half: outputFirst,
    output_second_half: outputSecond,
    cardio_drift: outputFirst !== null && outputSecond !== null ? outputSecond - outputFirst : null,
    notes,
    gaps,
  };
}

/**
 * How much the deep read changes the picture the career page gave.
 *
 * Reported as a comparison rather than folded into the mismatch score,
 * because the two rest on different sample sizes — a career average over
 * thirty fights against five bouts read in detail — and averaging them would
 * hide which one a statement came from.
 */
export function reconcile(
  careerTdPer15: number | null,
  deep: DeepRead,
): string | null {
  if (careerTdPer15 === null || deep.takedown_attempts_per15 === null) return null;
  const attempts = deep.takedown_attempts_per15;
  if (attempts <= 0) return null;

  const conversion = careerTdPer15 / attempts;
  if (conversion < 0.3 && attempts >= 3) {
    return (
      `Shoots ${attempts.toFixed(1)} times per 15 minutes and lands ${careerTdPer15.toFixed(1)} ` +
      `— high volume, low conversion. The pressure is real even where the takedown count is not.`
    );
  }
  if (conversion > 0.6 && attempts < 2) {
    return (
      `Only ${attempts.toFixed(1)} attempts per 15 minutes but converts most of them. Efficient ` +
      `rather than relentless, which is a different threat to an opponent who can be worn down.`
    );
  }
  return null;
}
