import { useEffect, useState } from 'react';
import { formatPrice } from '../format.js';

/**
 * The UFC board.
 *
 * Deliberately not an arbitrage view. Nothing here is a guaranteed profit, so
 * nothing here borrows the three-status language that means exactly that on
 * the other tabs — this is a way of reading a card: who is fighting, what each
 * venue charges to back them, and what is actually known about the two people
 * involved.
 *
 * Where something is not known it says so. Half a fight card is made up of
 * people no public dataset has heard of, and a tab that quietly filled those
 * gaps with plausible guesses would be worse than one that leaves them blank.
 */

interface VenuePrice {
  venue: string;
  price: number;
  size: number;
}

interface Fighter {
  nationality: string | null;
  nationality_source: string | null;
  style_label: string | null;
  style_source: string | null;
  style_class: 'GRAPPLER' | 'STRIKER' | 'UNKNOWN';
  nickname: string | null;
  record: string | null;
}

interface FightSide {
  name: string;
  fighter: Fighter | null;
  prices: VenuePrice[];
  best: VenuePrice | null;
}

interface FightCard {
  fight_id: string;
  title: string;
  when: string | null;
  sides: [FightSide, FightSide];
  divergence: number | null;
  mismatch: Mismatch | null;
  market: FightMarket | null;
  brazilian: boolean;
  venues: string[];
}

interface MismatchComponent {
  name: string;
  label: string;
  value: number | null;
  weight: number;
  detail: string;
}

interface Physical {
  reach_advantage_inches: number | null;
  height_advantage_inches: number | null;
  age_gap_years: number | null;
  open_stance: boolean;
  stances: [string | null, string | null];
  layoffs: Array<{ name: string; days: number }>;
  notes: string[];
}

interface Mismatch {
  score: number;
  grappler: string | null;
  striker: string | null;
  role_basis: string;
  components: MismatchComponent[];
  not_modelled: string[];
  no_grappler: boolean;
  physical: Physical | null;
}

interface FightMarket {
  fair: [number, number];
  overround: number;
  venue: string;
  tension: string | null;
}

interface Board {
  cards: FightCard[];
  coverage: {
    fights: number;
    both_known: number;
    both_scored: number;
    two_venue: number;
    dossier_size: number;
  };
  scanned_at: string;
  error: string | null;
}

type Filter = 'ALL' | 'BRAZILIAN' | 'CLASH' | 'TWO_VENUE';

/** How lopsided, in words. Mirrors the core labels. */
function band(score: number): string {
  if (score >= 75) return 'Severe';
  if (score >= 60) return 'Large';
  if (score >= 45) return 'Moderate';
  if (score >= 30) return 'Slight';
  return 'Minimal';
}

const STYLE_MARK: Record<string, string> = {
  GRAPPLER: 'grappler',
  STRIKER: 'striker',
  UNKNOWN: 'unknown',
};

export function UfcBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/ufc');
        const body = (await response.json()) as Board;
        if (live) setBoard(body);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (loading) return <div className="empty">Reading both venues and the fighter dossier…</div>;
  if (!board) return <div className="empty">Could not load the UFC board.</div>;

  const shown = board.cards.filter((c) => {
    if (filter === 'BRAZILIAN') return c.brazilian;
    if (filter === 'CLASH') return (c.mismatch?.score ?? 0) >= 45;
    if (filter === 'TWO_VENUE') return c.venues.length > 1;
    return true;
  });

  return (
    <>
      {board.error && <div className="banner err">Scan failed: {board.error}</div>}

      <div className="ufc-filters">
        {(
          [
            ['ALL', `All ${board.coverage.fights}`],
            ['BRAZILIAN', 'Brazilians'],
            ['CLASH', 'Grappling mismatch'],
            ['TWO_VENUE', `Both venues ${board.coverage.two_venue}`],
          ] as Array<[Filter, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            className={filter === value ? 'on' : ''}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          <strong>Nothing on this card matches</strong>
          {filter === 'CLASH'
            ? `A grappling read needs career statistics for both fighters, and ` +
              `${board.coverage.both_scored} of ${board.coverage.fights} fights on this card ` +
              `have them. Debutants have no record to read.`
            : 'Try another filter.'}
        </div>
      ) : (
        <div className="ufc-cards">
          {shown.map((card) => (
            <article
              key={card.fight_id}
              className="fight"
              onClick={() => setOpen(open === card.fight_id ? null : card.fight_id)}
            >
              <header>
                <h3>{card.title}</h3>
                <div className="tags">
                  {card.brazilian && <span className="tag br">Brazil</span>}
                  {card.mismatch && !card.mismatch.no_grappler && (
                    <span className="tag clash">
                      Grappling {card.mismatch.score} · {band(card.mismatch.score)}
                    </span>
                  )}
                  {card.venues.length > 1 && card.divergence !== null && (
                    <span className="tag div">
                      {(card.divergence / 10).toFixed(1)}¢ apart
                    </span>
                  )}
                </div>
              </header>

              {card.sides.map((side) => (
                <div className="corner" key={side.name}>
                  <div className="who">
                    <span className="fname">{side.name}</span>
                    <span
                      className={`style ${
                        card.mismatch?.grappler === side.name
                          ? 'grappler'
                          : card.mismatch?.striker === side.name
                            ? 'striker'
                            : 'unknown'
                      }`}
                    >
                      {card.mismatch?.grappler === side.name
                        ? 'takedown pressure'
                        : card.mismatch?.striker === side.name
                          ? 'striking side'
                          : 'no career stats'}
                    </span>
                    {side.fighter?.nationality && (
                      <span className="nat">{side.fighter.nationality}</span>
                    )}
                  </div>
                  <div className="quotes">
                    {side.prices.length === 0 ? (
                      <span className="noprice">no price</span>
                    ) : (
                      side.prices.map((p) => (
                        <span
                          key={p.venue}
                          className={p.venue === side.best?.venue ? 'q best' : 'q'}
                        >
                          {p.venue.slice(0, 4)} {formatPrice(p.price)}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              ))}

              {open === card.fight_id && (
                <div className="fight-detail">
                  {card.mismatch ? (
                    <div className="mismatch">
                      {card.mismatch.no_grappler ? (
                        <p className="src">{card.mismatch.role_basis}</p>
                      ) : (
                        <>
                          <div className="mm-head">
                            <b>
                              Grappling mismatch {card.mismatch.score}/100 ·{' '}
                              {band(card.mismatch.score)}
                            </b>
                          </div>
                          <p className="src">{card.mismatch.role_basis}</p>
                          {card.mismatch.components.map((c) => (
                            <div className="mm-row" key={c.name}>
                              <span className="mm-l">{c.label}</span>
                              <span className="mm-b">
                                <span style={{ width: `${(c.value ?? 0) * 100}%` }} />
                              </span>
                              <span className="mm-v">
                                {c.value === null ? 'n/a' : Math.round(c.value * 100)}
                              </span>
                              <span className="mm-d">{c.detail}</span>
                            </div>
                          ))}
                        </>
                      )}
                      {card.mismatch.physical && card.mismatch.physical.notes.length > 0 && (
                        <div className="phys">
                          <b>Physical and situational</b>
                          <ul>
                            {card.mismatch.physical.notes.map((n) => (
                              <li key={n}>{n}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {card.market && (
                        <div className="mktread">
                          <b>Market</b>
                          <p className="src">
                            {card.sides[0].name} {Math.round(card.market.fair[0] * 100)}% ·{' '}
                            {card.sides[1].name} {Math.round(card.market.fair[1] * 100)}%
                            {' '}de-vigged from {card.market.venue}, margin{' '}
                            {((card.market.overround - 1) * 100).toFixed(1)}%.
                          </p>
                          {card.market.tension && <p className="caution">{card.market.tension}</p>}
                          <p className="src">
                            Shown beside the grappling read, never combined with it. A fighter
                            being likely to win does not make his price a good one.
                          </p>
                        </div>
                      )}

                      <details className="mm-gaps">
                        <summary>What this does not measure</summary>
                        <ul>
                          {card.mismatch.not_modelled.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      </details>
                      <p className="src">
                        This is a read on how the fight is likely to be contested. It is not a
                        win probability, and no value claim follows from it — a fighter being
                        likely to win does not make his price a good one.
                      </p>
                    </div>
                  ) : (
                    <p className="src">
                      No career statistics for one or both fighters, so no grappling read.
                      Nothing is inferred in its place.
                    </p>
                  )}

                  <div className="bios">
                    {card.sides.map((side) => (
                      <div key={side.name}>
                        <b>{side.name}</b>
                        {side.fighter ? (
                          <ul>
                            {side.fighter.record && <li>Record {side.fighter.record}</li>}
                            {side.fighter.nickname && <li>“{side.fighter.nickname}”</li>}
                            <li>
                              {side.fighter.nationality ?? 'Nationality unknown'}
                              {side.fighter.nationality_source && (
                                <span className="src"> — {side.fighter.nationality_source}</span>
                              )}
                            </li>
                          </ul>
                        ) : (
                          <p className="src">No public record found for this name.</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <div className="showing">
        {board.coverage.both_scored} of {board.coverage.fights} fights have career statistics
        for both fighters. Prices are what it costs to back each fighter — not an arbitrage, and
        not a prediction.
      </div>
    </>
  );
}
