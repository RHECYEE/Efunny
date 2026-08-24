import { useEffect, useState } from 'react';
import type { DeepMatchupRead, UfcBoardData } from '@arbterminal/adapters/browser';
import { ufcServices } from '../services.js';
import { formatPrice } from '../format.js';

/**
 * The UFC board, on a phone.
 *
 * Deliberately not an arbitrage view. Nothing here is a guaranteed profit, so
 * nothing here borrows the three-status language that means exactly that on
 * the Arbitrage tab — this is a way of reading a card: who is fighting, what
 * each venue charges to back them, and what is actually known about the two
 * people involved.
 *
 * One thing is different from the desktop and the screen says so rather than
 * hiding it. Career statistics come from UFCStats, which only serves pages to
 * something that will run their script — a browser, which a phone's WebView
 * cannot be pointed at cross-origin. Without a companion desktop the board
 * still shows both venues' prices and every fighter's identity; the grappling
 * model simply does not run, and the banner says which of the two you are
 * looking at.
 */

type Filter = 'ALL' | 'BRAZILIAN' | 'CLASH' | 'TWO_VENUE';

function band(score: number): string {
  if (score >= 75) return 'Severe';
  if (score >= 60) return 'Large';
  if (score >= 45) return 'Moderate';
  if (score >= 30) return 'Slight';
  return 'Minimal';
}

function DeepPanel({ fightId, companion }: { fightId: string; companion: string }) {
  const [data, setData] = useState<DeepMatchupRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [asked, setAsked] = useState(false);

  async function load() {
    setAsked(true);
    setLoading(true);
    try {
      setData(await ufcServices(companion).deep.read(fightId));
    } catch (e) {
      setData({
        fight_id: fightId,
        fighters: [null, null],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }

  if (!asked) {
    return (
      <button
        className="deep-btn"
        onClick={(e) => {
          e.stopPropagation();
          void load();
        }}
      >
        Deep read — control time, get-ups, re-shoots
      </button>
    );
  }
  if (loading) return <p className="hint">Reading the last five bouts for each fighter…</p>;
  if (!data || data.error) return <p className="hint">{data?.error ?? 'Could not load.'}</p>;

  const secs = (v: number | null) => (v === null ? '—' : `${Math.round(v)}s`);

  return (
    <div className="deep" onClick={(e) => e.stopPropagation()}>
      {data.fighters.map((f) =>
        f === null ? null : (
          <div key={f.name}>
            <b>{f.name}</b>
            <span className="hint">
              {' '}
              — {f.deep.fights_read} bouts, {f.deep.rounds_read} rounds read
            </span>
            {f.deep.rounds_read === 0 ? (
              <p className="hint">No readable round data.</p>
            ) : (
              <>
                <div className="deep-row">
                  <span>Takedown attempts / 15</span>
                  <span>{f.deep.takedown_attempts_per15?.toFixed(1) ?? '—'}</span>
                </div>
                <div className="deep-row">
                  <span>Re-shoots per round with an attempt</span>
                  <span>{f.deep.reshoot_rate?.toFixed(1) ?? '—'}</span>
                </div>
                <div className="deep-row">
                  <span>Control per round, on top</span>
                  <span>{secs(f.deep.control_seconds_per_round)}</span>
                </div>
                <div className="deep-row">
                  <span>Control per takedown landed</span>
                  <span>{secs(f.deep.control_per_takedown)}</span>
                </div>
                <div className="deep-row">
                  <span>Time underneath per round</span>
                  <span>{secs(f.deep.controlled_seconds_per_round)}</span>
                </div>
                <div className="deep-row">
                  <span>
                    Reversals per round underneath
                    {/* The rate is meaningless without the rounds it came off. */}
                    <span className="hint"> over {f.deep.held_rounds} rd</span>
                  </span>
                  <span>{f.deep.escape_rate?.toFixed(2) ?? '—'}</span>
                </div>
                <div className="deep-row">
                  <span>Output drift, early to late rounds</span>
                  <span>
                    {f.deep.cardio_drift === null
                      ? '—'
                      : `${f.deep.cardio_drift > 0 ? '+' : ''}${f.deep.cardio_drift.toFixed(0)} str/rd`}
                  </span>
                </div>
                {f.deep.notes.map((n) => (
                  <p className="hint" key={n}>
                    {n}
                  </p>
                ))}
                {f.reconciliation && <p className="caution">{f.reconciliation}</p>}
              </>
            )}
          </div>
        ),
      )}
      {data.fighters[0]?.deep.gaps.length ? (
        <details className="gaps">
          <summary>Still not measured</summary>
          <ul>
            {data.fighters[0].deep.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function Ufc({ companion }: { companion: string }) {
  const [board, setBoard] = useState<UfcBoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void (async () => {
      try {
        const body = await ufcServices(companion).board.board();
        if (live) setBoard(body);
      } catch (e) {
        if (live) {
          setBoard({
            cards: [],
            coverage: { fights: 0, both_known: 0, both_scored: 0, two_venue: 0, dossier_size: 0 },
            stats_source: null,
            scanned_at: new Date().toISOString(),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [companion]);

  if (loading) return <p className="empty">Reading both venues and the fighter dossier…</p>;
  if (!board) return <p className="empty">Could not load the card.</p>;

  const cards = board.cards.filter((c) => {
    if (filter === 'BRAZILIAN') return c.brazilian;
    if (filter === 'CLASH') return c.mismatch !== null && !c.mismatch.no_grappler;
    if (filter === 'TWO_VENUE') return c.venues.length > 1;
    return true;
  });

  return (
    <>
      {board.error && <div className="banner err">Scan failed: {board.error}</div>}

      {/*
        An absent grappling model must be visibly absent. A board that simply
        showed fewer cards with scores would read as "these fights are not
        interesting" rather than "this build could not measure them".
      */}
      {board.stats_source === null ? (
        <div className="banner warn">
          <b>No career statistics on this device.</b> UFCStats only serves its pages to a real
          browser, which a phone cannot supply. Prices, fighters and where the two venues
          disagree are all here; the grappling model is not. Set a companion desktop under
          Settings to turn it on.
        </div>
      ) : (
        <p className="hint">Career statistics: {board.stats_source}.</p>
      )}

      <div className="chips">
        {(['ALL', 'BRAZILIAN', 'CLASH', 'TWO_VENUE'] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {f === 'ALL'
              ? `All ${board.coverage.fights}`
              : f === 'BRAZILIAN'
                ? '🇧🇷 Brazilian'
                : f === 'CLASH'
                  ? 'Style clash'
                  : `Two venues ${board.coverage.two_venue}`}
          </button>
        ))}
      </div>

      {cards.length === 0 && <p className="empty">Nothing matches that filter.</p>}

      {cards.map((card) => {
        const isOpen = open === card.fight_id;
        return (
          <article
            key={card.fight_id}
            className={`fight${isOpen ? ' open' : ''}`}
            onClick={() => setOpen(isOpen ? null : card.fight_id)}
          >
            <div className="fight-head">
              <span>
                {card.brazilian ? '🇧🇷 ' : ''}
                {card.sides[0].name} vs {card.sides[1].name}
              </span>
              {card.mismatch && !card.mismatch.no_grappler && (
                <span className="mm">{band(card.mismatch.score)}</span>
              )}
            </div>

            {card.sides.map((side) => (
              <div key={side.name} className="side num">
                <span>{side.name}</span>
                <span>
                  {side.prices.map((p) => (
                    <span key={p.venue} className="vp">
                      {p.venue.slice(0, 4)} {formatPrice(p.price)}
                    </span>
                  ))}
                </span>
              </div>
            ))}

            {card.divergence !== null && (
              <p className="hint">
                Venues differ by {((card.divergence / 1000) * 100).toFixed(1)} points on this
                fight.
              </p>
            )}

            {isOpen && (
              <div className="fight-body" onClick={(e) => e.stopPropagation()}>
                {card.mismatch ? (
                  card.mismatch.no_grappler ? (
                    <p className="hint">
                      Neither fighter takes anybody down often enough to be read as the grappler,
                      so the mismatch model does not apply here.
                    </p>
                  ) : (
                    <>
                      <p>
                        <b>
                          {band(card.mismatch.score)} grappling mismatch — {card.mismatch.score}
                        </b>
                        <br />
                        <span className="hint">{card.mismatch.role_basis}</span>
                      </p>
                      {card.mismatch.components.map((c) => (
                        <div key={c.name} className="deep-row">
                          <span>{c.label}</span>
                          <span>{c.value === null ? '—' : Math.round(c.value)}</span>
                        </div>
                      ))}
                      {card.mismatch.physical?.notes.map((n) => (
                        <p className="hint" key={n}>
                          {n}
                        </p>
                      ))}
                      <details className="gaps">
                        <summary>What this does not measure</summary>
                        <ul>
                          {card.mismatch.not_modelled.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      </details>
                    </>
                  )
                ) : (
                  <p className="hint">
                    {board.stats_source === null
                      ? 'No career statistics on this device, so the grappling model did not run.'
                      : 'One of these fighters has no usable career record, so nothing is scored.'}
                  </p>
                )}

                {card.market?.tension && <p className="caution">{card.market.tension}</p>}

                <DeepPanel fightId={card.fight_id} companion={companion} />

                <p className="hint">
                  This is a read on how the fight is likely to be contested. It is not a win
                  probability, and no value claim follows from it — a fighter being likely to win
                  does not make his price a good one.
                </p>
              </div>
            )}
          </article>
        );
      })}

      <p className="showing">
        {board.coverage.fights} fights · {board.coverage.both_known} with both fighters known ·{' '}
        {board.coverage.both_scored} scored · {board.coverage.two_venue} priced at both venues.
      </p>
    </>
  );
}
