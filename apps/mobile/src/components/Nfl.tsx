import { useEffect, useState } from 'react';
import type { MatchupView, NflBoard } from '@arbterminal/adapters/browser';
import { nflService } from '../services.js';

/**
 * NFL game intelligence, on a phone.
 *
 * The order is the order somebody actually reads in: the number, then how
 * much to trust it, then why, then what could make it wrong — and only after
 * all of that, what the market thinks. The projection is computed before any
 * price is fetched, so it can disagree with the book rather than restate it.
 *
 * "What changed" survives onto the phone because it is the part that pays for
 * reopening a matchup. The snapshot lives in the service, so it is per-device:
 * the phone tells you what changed since you last looked *on the phone*.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="nfl-sec">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Matchup({ m }: { m: MatchupView }) {
  const p = m.projection;
  const homeProb = Math.round(p.home_win_probability * 100);
  const favourite = homeProb >= 50 ? p.home : p.away;
  const favProb = homeProb >= 50 ? homeProb : 100 - homeProb;

  return (
    <div className="matchup" onClick={(e) => e.stopPropagation()}>
      {m.changes.length > 0 && (
        <div className="changed">
          <h4>What changed since you last looked</h4>
          {m.changes.map((c, i) => (
            <div key={i} className={`chg ${c.direction.toLowerCase()}`}>
              {c.text}
            </div>
          ))}
        </div>
      )}

      <div className="headline">
        <div className="score">
          <span>{p.home}</span>
          <b>{p.home_points.toFixed(1)}</b>
          <span className="dash">—</span>
          <b>{p.away_points.toFixed(1)}</b>
          <span>{p.away}</span>
        </div>
        <div className="prob">
          {favourite} win probability: <b>{favProb}%</b>
        </div>
        <div className={`conf ${p.confidence.toLowerCase()}`}>Confidence: {p.confidence}</div>
      </div>

      {p.confidence_reasons.length > 0 && (
        <ul className="conf-why">
          {p.confidence_reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <Section title={`Why ${p.home} is favoured`}>
        {p.why_home.length > 0 ? (
          <ul>
            {p.why_home.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          <p className="hint">No measurable edge in the published statistics.</p>
        )}
      </Section>

      <Section title={`Why ${p.away} can win`}>
        {p.why_away.length > 0 ? (
          <ul>
            {p.why_away.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          <p className="hint">No measurable edge in the published statistics.</p>
        )}
      </Section>

      {p.uncertainties.length > 0 && (
        <Section title="Major uncertainty">
          <ul>
            {p.uncertainties.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="What moved the number">
        {p.factors.map((f) => (
          <div className="factor" key={f.label}>
            <span className={`pts ${f.points >= 0 ? 'pos' : 'neg'}`}>
              {f.points >= 0 ? '+' : ''}
              {f.points.toFixed(1)}
            </span>
            <span className="fl">{f.label}</span>
            <span className="fd">{f.detail}</span>
          </div>
        ))}
      </Section>

      {m.injuries.length > 0 && (
        <Section title="Injuries">
          {m.injuries.map((i) => (
            <div className="factor" key={`${i.team}-${i.player}-${i.position}`}>
              <span className={`pts ${i.points >= 0 ? 'pos' : 'neg'}`}>
                {i.points >= 0 ? '+' : ''}
                {i.points.toFixed(1)}
              </span>
              <span className="fl">
                {i.team} {i.player} ({i.position}, {i.status})
              </span>
              <span className="fd">{i.note}</span>
            </div>
          ))}
        </Section>
      )}

      <Section title="Conditions">
        <p className="hint">
          {m.stadium}
          {m.conditions.indoors
            ? ' — indoors, so weather is not a factor.'
            : [
                m.conditions.temperature !== null ? `${Math.round(m.conditions.temperature)}°F` : null,
                m.conditions.wind_mph !== null ? `${Math.round(m.conditions.wind_mph)} mph wind` : null,
                m.conditions.precipitation !== null && m.conditions.precipitation > 0
                  ? `${m.conditions.precipitation.toFixed(2)}" rain`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ') || ' — no forecast published for this kickoff.'}
        </p>
        <p className="hint">
          Rest: {m.conditions.rest_days[0] ?? '—'} days home, {m.conditions.rest_days[1] ?? '—'}{' '}
          away
          {m.conditions.travel_miles !== null
            ? ` · away side travelled ${Math.round(m.conditions.travel_miles)} miles`
            : ''}
          .
        </p>
      </Section>

      <Section title="Against the market">
        {m.market ? (
          <>
            <div className="mkt num">
              <span>{m.market.venue}</span>
              <span>
                fair {Math.round(m.market.fair_home_probability * 100)}% {p.home}
              </span>
              <span>overround {((m.market.overround - 1) * 100).toFixed(1)}%</span>
              <span className={m.market.model_leans === 'ALIGNED' ? '' : 'warn'}>
                model {m.market.disagreement_points >= 0 ? '+' : ''}
                {m.market.disagreement_points.toFixed(1)} pts
              </span>
            </div>
            <p className="hint">{m.market.note}</p>
          </>
        ) : (
          <p className="hint">No venue prices this game.</p>
        )}
      </Section>

      <p className="hint">
        Statistics are from the {m.stats_season} season. The projection is computed before any
        market price is read, so it can disagree with the book rather than restate it.
      </p>
    </div>
  );
}

export function Nfl() {
  const [board, setBoard] = useState<NflBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [matchup, setMatchup] = useState<MatchupView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const body = await nflService().board();
        if (live) setBoard(body);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function openGame(home: string, away: string, id: string) {
    if (open === id) {
      setOpen(null);
      setMatchup(null);
      return;
    }
    setOpen(id);
    setMatchup(null);
    setError(null);
    setBusy(true);
    try {
      setMatchup(await nflService().matchup(home, away));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="empty">Loading the schedule…</p>;
  if (!board) return <p className="empty">Could not load the schedule.</p>;

  return (
    <>
      {board.error && <div className="banner err">Schedule failed: {board.error}</div>}

      {/*
        Preseason statistics are starters playing one series against opponents
        doing the same. The screen says which season it is reading rather than
        presenting a preseason projection as a regular-season one.
      */}
      {board.season_type === 1 && (
        <div className="banner warn">
          Preseason. These are exhibition games — the projection reads the previous regular
          season and reports LOW confidence for every one of them.
        </div>
      )}

      {board.games.length === 0 && <p className="empty">No games on the board.</p>}

      {board.games.map((g) => (
        <article
          key={g.id}
          className={`game${open === g.id ? ' open' : ''}`}
          onClick={() => void openGame(g.home, g.away, g.id)}
        >
          <div className="game-head">
            <span>
              {g.away} @ {g.home}
            </span>
            <span className="hint">{new Date(g.date).toLocaleDateString()}</span>
          </div>
          {open === g.id && busy && <p className="hint">Building the matchup…</p>}
          {open === g.id && error && <p className="hint">Could not build it: {error}</p>}
          {open === g.id && matchup && <Matchup m={matchup} />}
        </article>
      ))}

      <p className="showing">
        {board.season_year} season, week {board.week ?? '—'} ·{' '}
        {board.games.length} games.
      </p>
    </>
  );
}
