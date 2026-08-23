import {
  KalshiAdapter,
  PolymarketAdapter,
  buildDossier,
  buildFightCards,
  type FightCard,
  type Fighter,
} from '@arbterminal/adapters';

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
    both_styled: number;
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

      const board: UfcBoard = {
        cards,
        coverage: {
          fights: cards.length,
          both_known: cards.filter((c) => c.sides.every((s) => s.fighter !== null)).length,
          both_styled: cards.filter((c) =>
            c.sides.every((s) => s.fighter && s.fighter.style_class !== 'UNKNOWN'),
          ).length,
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
          { fights: 0, both_known: 0, both_styled: 0, two_venue: 0, dossier_size: 0 },
        scanned_at: scannedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
