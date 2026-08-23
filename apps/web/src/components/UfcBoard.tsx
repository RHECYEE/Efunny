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
  style_clash: boolean;
  brazilian: boolean;
  venues: string[];
}

interface Board {
  cards: FightCard[];
  coverage: {
    fights: number;
    both_known: number;
    both_styled: number;
    two_venue: number;
    dossier_size: number;
  };
  scanned_at: string;
  error: string | null;
}

type Filter = 'ALL' | 'BRAZILIAN' | 'CLASH' | 'TWO_VENUE';

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
    if (filter === 'CLASH') return c.style_clash;
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
            ['CLASH', 'Grappler vs striker'],
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
            ? `Style needs both fighters classified, and only ${board.coverage.both_styled} of ` +
              `${board.coverage.fights} fights on this card have that. Prospects on a ` +
              `preliminary card are rarely in any public dataset.`
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
                  {card.style_clash && <span className="tag clash">Style clash</span>}
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
                    <span className={`style ${STYLE_MARK[side.fighter?.style_class ?? 'UNKNOWN']}`}>
                      {side.fighter
                        ? side.fighter.style_class === 'UNKNOWN'
                          ? 'style unknown'
                          : side.fighter.style_class.toLowerCase()
                        : 'not in dossier'}
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
                  {card.sides.map((side) => (
                    <div key={side.name}>
                      <b>{side.name}</b>
                      {side.fighter ? (
                        <ul>
                          {side.fighter.record && <li>Record {side.fighter.record}</li>}
                          {side.fighter.nickname && <li>“{side.fighter.nickname}”</li>}
                          <li>
                            {side.fighter.style_label ?? 'No style published'}
                            {side.fighter.style_source && (
                              <span className="src"> — {side.fighter.style_source}</span>
                            )}
                          </li>
                          <li>
                            {side.fighter.nationality ?? 'Nationality unknown'}
                            {side.fighter.nationality_source && (
                              <span className="src"> — {side.fighter.nationality_source}</span>
                            )}
                          </li>
                        </ul>
                      ) : (
                        <p className="src">
                          No public record found for this name. Nothing is inferred in its place.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <div className="showing">
        {board.coverage.both_known} of {board.coverage.fights} fights have both fighters on
        record; {board.coverage.both_styled} have a style for both. Prices are what it costs to
        back each fighter, not an arbitrage.
      </div>
    </>
  );
}
