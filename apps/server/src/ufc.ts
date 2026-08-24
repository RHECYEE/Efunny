import {
  KalshiAdapter,
  PolymarketAdapter,
  buildDossier,
  attachMarketTension,
  buildFightCards,
  type FightCard,
  type Fighter,
  type FighterProfile,
} from '@arbterminal/adapters';
import {
  computeDeepRead,
  computeMismatch,
  reconcile,
  type DeepRead,
  type FighterStats,
  type FightLines,
} from '@arbterminal/core';
import { fetchProfiles, fetchRecentFightDetails } from './ufcstatsBrowser.js';

/**
 * A career profile into the shape the mismatch model wants.
 *
 * The derived counts come from the fight table rather than the career box,
 * because the career box has no denominators: it will say a fighter stops 85%
 * of takedowns without saying whether that is off six attempts or sixty.
 */
/** Years from a published date of birth. */
function ageFrom(dob: string | null): number | null {
  if (!dob) return null;
  const born = Date.parse(dob);
  if (!Number.isFinite(born)) return null;
  return Math.floor((Date.now() - born) / (365.25 * 86_400_000));
}

/**
 * Days since the last bout.
 *
 * Read from the event text in the fight table, which carries a date. Returns
 * null rather than zero when no date parses — a fighter with an unreadable
 * record has not just fought.
 */
function layoffFrom(fights: FighterProfile['fights']): number | null {
  for (const fight of fights) {
    const match = fight.event.match(/([A-Z][a-z]{2})\.?\s+(\d{1,2}),\s+(\d{4})/);
    if (!match) continue;
    const parsed = Date.parse(`${match[1]} ${match[2]}, ${match[3]}`);
    if (!Number.isFinite(parsed)) continue;
    return Math.floor((Date.now() - parsed) / 86_400_000);
  }
  return null;
}

function toStats(name: string, profile: FighterProfile): FighterStats {
  const fights = profile.fights;
  const isKo = (m: string) => /^(KO|TKO)/i.test(m);
  return {
    name,
    td_per15: profile.stats.td_per15,
    td_accuracy: profile.stats.td_accuracy,
    td_defence: profile.stats.td_defence,
    sub_per15: profile.stats.sub_per15,
    slpm: profile.stats.slpm,
    sapm: profile.stats.sapm,
    strike_accuracy: profile.stats.strike_accuracy,
    strike_defence: profile.stats.strike_defence,
    reach_inches: profile.stats.reach_inches,
    height_inches: profile.stats.height_inches,
    stance: profile.stats.stance,
    age: ageFrom(profile.stats.dob),
    layoff_days: layoffFrom(fights),
    fights_counted: fights.length,
    takedowns_conceded: fights.reduce((s, f) => s + f.takedowns[1], 0),
    knockdowns_landed: fights.reduce((s, f) => s + f.knockdowns[0], 0),
    knockdowns_absorbed: fights.reduce((s, f) => s + f.knockdowns[1], 0),
    ko_wins: fights.filter((f) => f.result === 'WIN' && isKo(f.method)).length,
    submission_wins: fights.filter((f) => f.result === 'WIN' && /^SUB/i.test(f.method)).length,
    wins: fights.filter((f) => f.result === 'WIN').length,
  };
}

/**
 * The UFC board.
 *
 * A scouting view, not an arbitrage one. It answers "what is on the card, what
 * do the two venues think of it, and what do we actually know about these
 * people" — and deliberately borrows none of the arbitrage vocabulary, because
 * ARBITRAGE FOUND means something precise on the other tabs and using it for
 * "these two prices differ" would empty it out.
 *
 * The dossier is slow to build and changes on the timescale of a fight camp,
 * so it is cached far longer than the prices are.
 */

const DOSSIER_TTL_MS = 6 * 60 * 60 * 1000;
const CARDS_TTL_MS = 60 * 1000;

export interface UfcBoard {
  cards: FightCard[];
  coverage: {
    fights: number;
    /** Fights where both fighters were found in the dossier. */
    both_known: number;
    /** Fights where both fighters have a usable style. */
    /** Fights where both fighters have career statistics. */
    both_scored: number;
    two_venue: number;
    dossier_size: number;
  };
  scanned_at: string;
  error: string | null;
}

export class UfcBoardService {
  private dossier: Map<string, Fighter> | null = null;
  private dossierAt = 0;
  private cached: UfcBoard | null = null;
  private cachedAt = 0;
  private inflight: Promise<UfcBoard> | null = null;

  constructor(
    private readonly kalshi = new KalshiAdapter({
      series_tickers: ['KXUFCFIGHT'],
      market_limit: 200,
    }),
    private readonly polymarket = new PolymarketAdapter({
      tag_slugs: ['ufc'],
      event_limit: 200,
    }),
  ) {}

  async board(): Promise<UfcBoard> {
    if (this.cached && Date.now() - this.cachedAt < CARDS_TTL_MS) return this.cached;
    // Collapse concurrent requests onto one scan rather than hammering both
    // venues once per browser tab.
    if (this.inflight) return this.inflight;
    this.inflight = this.build().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async ensureDossier(): Promise<Map<string, Fighter>> {
    if (this.dossier && Date.now() - this.dossierAt < DOSSIER_TTL_MS) return this.dossier;
    this.dossier = await buildDossier();
    this.dossierAt = Date.now();
    return this.dossier;
  }

  private async build(): Promise<UfcBoard> {
    const scannedAt = new Date().toISOString();
    try {
      const [k, p, dossier] = await Promise.all([
        this.kalshi.fetchSnapshots(),
        this.polymarket.fetchSnapshots(),
        this.ensureDossier(),
      ]);

      const entries = [...k, ...p].flatMap((s) => s.markets);
      const cards = buildFightCards(entries, dossier);

      // Career statistics for everyone on the card, then the grappling read.
      // Cached names cost nothing; the budget bounds a cold first run.
      const names = [...new Set(cards.flatMap((c) => c.sides.map((s) => s.name)))];
      const profiles = await fetchProfiles(names, { budget: 40 });
      for (const card of cards) {
        const [a, b] = card.sides;
        const pa = profiles.get(a.name);
        const pb = profiles.get(b.name);
        if (!pa || !pb) continue;
        card.mismatch = computeMismatch(toStats(a.name, pa), toStats(b.name, pb));
        attachMarketTension(card);
      }

      const board: UfcBoard = {
        cards,
        coverage: {
          fights: cards.length,
          both_known: cards.filter((c) => c.sides.every((s) => s.fighter !== null)).length,
          both_scored: cards.filter((c) => c.mismatch !== null).length,
          two_venue: cards.filter((c) => c.venues.length > 1).length,
          dossier_size: dossier.size,
        },
        scanned_at: scannedAt,
        error: null,
      };
      this.cached = board;
      this.cachedAt = Date.now();
      return board;
    } catch (error) {
      return {
        cards: this.cached?.cards ?? [],
        coverage:
          this.cached?.coverage ??
          { fights: 0, both_known: 0, both_scored: 0, two_venue: 0, dossier_size: 0 },
        scanned_at: scannedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}


/* ------------------------------------------------------------------ *
 * Deep read
 * ------------------------------------------------------------------ */

export interface DeepFighterRead {
  name: string;
  deep: DeepRead;
  /** How the detailed sample squares with the career averages. */
  reconciliation: string | null;
}

export interface DeepMatchupRead {
  fight_id: string;
  fighters: [DeepFighterRead | null, DeepFighterRead | null];
  error: string | null;
}

/**
 * The expensive read, for one matchup.
 *
 * Separate from the board because it costs a page load per bout — five
 * fights each side is ten loads and the better part of a minute. Cached for
 * as long as the career figures, since a fighter's last five bouts do not
 * change between now and the weekend.
 */
export class UfcDeepService {
  constructor(private readonly board: UfcBoardService) {}

  async read(fightId: string): Promise<DeepMatchupRead> {
    try {
      const board = await this.board.board();
      const card = board.cards.find((c) => c.fight_id === fightId);
      if (!card) return { fight_id: fightId, fighters: [null, null], error: 'No such fight.' };

      const names = card.sides.map((s) => s.name) as [string, string];
      const profiles = await fetchProfiles(names, { budget: 2 });

      const reads = await Promise.all(
        names.map(async (name): Promise<DeepFighterRead | null> => {
          const profile = profiles.get(name);
          if (!profile) return null;
          const details = await fetchRecentFightDetails(name, profile.url, 5);

          // Already oriented on the way in: slot zero is the fighter whose
          // page the bout was reached from, matched by page URL rather than
          // by reading a name out of a cell that holds two of them.
          const lines: FightLines[] = details.map((d) => ({
            own: d.rounds[0],
            opponent: d.rounds[1],
          }));

          const deep = computeDeepRead(lines);
          return {
            name,
            deep,
            reconciliation: reconcile(profile.stats.td_per15, deep),
          };
        }),
      );

      return { fight_id: fightId, fighters: [reads[0]!, reads[1]!], error: null };
    } catch (error) {
      return {
        fight_id: fightId,
        fighters: [null, null],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
