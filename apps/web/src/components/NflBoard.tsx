import { useEffect, useState } from 'react';

/**
 * NFL matchup intelligence.
 *
 * The screen reduces to three lines — projected score, win probability,
 * confidence — with the reasoning underneath, in the order somebody actually
 * asks for it: why this side is favoured, how the other side wins, what is
 * still unknown, and what would move the number.
 *
 * Confidence sits next to the probability rather than buried, because the two
 * are meaningless apart. Sixty-one percent off a full season and sixty-one
 * off last season's roster are the same number and completely different
 * claims, and the screen has to say which one it is holding.
 */

interface Game {
  id: string;
  date: string;
  home: string;
  away: string;
  name: string;
  season_type: number;
  week: number | null;
}

interface Factor {
  label: string;
  points: number;
  detail: string;
}

interface Injury {
  team: string;
  player: string;
  position: string;
  status: string;
  points: number;
  note: string;
}

interface Change {
  kind: string;
  text: string;
  direction: 'HOME' | 'AWAY' | 'NEUTRAL';
}

interface Projection {
  home: string;
  away: string;
  home_points: number;
  away_points: number;
  margin: number;
  home_win_probability: number;
  confidence: 'LOW' | 'MODERATE' | 'GOOD';
  confidence_reasons: string[];
  factors: Factor[];
  why_home: string[];
  why_away: string[];
  uncertainties: string[];
  not_modelled: string[];
}

interface TeamContext {
  team: string;
  record: { overall: string | null; home: string | null; road: string | null; division: string | null; conference: string | null };
  recent: number[];
  season_margin: number | null;
  news: Array<{ headline: string; description: string; published: string }>;
  turnovers: { margin_per_game: number | null; fumble_recovery_rate: number | null; luck_note: string };
}

interface Trench {
  differential: number | null;
  severity: 'NONE' | 'NOTABLE' | 'SEVERE';
  detail: string;
  line_injuries: string[];
}

interface MarketRead {
  venue: string;
  fair_home_probability: number;
  overround: number;
  disagreement_points: number;
  model_leans: 'HOME' | 'AWAY' | 'ALIGNED';
  note: string;
}

interface Matchup {
  game: Game;
  projection: Projection;
  injuries: Injury[];
  conditions: {
    temperature: number | null;
    wind_mph: number | null;
    precipitation: number | null;
    indoors: boolean;
    rest_days: [number | null, number | null];
    travel_miles: number | null;
  };
  stadium: string;
  home_context: TeamContext;
  away_context: TeamContext;
  common_opponents: {
    opponents: Array<{ opponent: string; home_margin: number; away_margin: number; difference: number }>;
    average_difference: number | null;
    caveat: string;
  };
  head_to_head: { meetings: Array<{ date: string; margin: number }>; home_wins: number; away_wins: number; note: string };
  trenches: { home: Trench; away: Trench };
  market: MarketRead | null;
  changes: Change[];
  previous_seen_at: string | null;
  stats_season: number;
  stats_are_prior_season: boolean;
}

interface BoardData {
  games: Game[];
  season_year: number;
  season_type: number;
  week: number | null;
  error: string | null;
}

const SEASON_TYPE: Record<number, string> = { 1: 'Preseason', 2: 'Regular season', 3: 'Postseason' };

export function NflBoard() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [matchup, setMatchup] = useState<Matchup | null>(null);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch('/api/nfl');
        if (live) setBoard((await r.json()) as BoardData);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function open(game: Game) {
    setPicking(true);
    try {
      const r = await fetch(`/api/nfl/matchup?home=${game.home}&away=${game.away}`);
      if (r.ok) setMatchup((await r.json()) as Matchup);
    } finally {
      setPicking(false);
    }
  }

  if (loading) return <div className="empty">Loading the schedule…</div>;
  if (!board) return <div className="empty">Could not load the NFL board.</div>;

  return (
    <>
      {board.error && <div className="banner err">{board.error}</div>}

      <div className="nfl-games">
        {board.games.map((g) => (
          <button
            key={g.id}
            className={`nfl-game${matchup?.game.id === g.id ? ' on' : ''}`}
            onClick={() => void open(g)}
          >
            <span className="teams">
              {g.away} @ {g.home}
            </span>
            <span className="when">{g.date.slice(0, 10)}</span>
          </button>
        ))}
      </div>

      {picking && <div className="empty">Assembling the matchup…</div>}

      {matchup && !picking && <MatchupView m={matchup} />}

      {!matchup && !picking && (
        <div className="scan-note">
          {SEASON_TYPE[board.season_type] ?? 'Season'} week {board.week ?? '—'}. Pick a game.
        </div>
      )}
    </>
  );
}

function MatchupView({ m }: { m: Matchup }) {
  const p = m.projection;
  const homeProb = Math.round(p.home_win_probability * 100);
  const favourite = homeProb >= 50 ? p.home : p.away;
  const favProb = homeProb >= 50 ? homeProb : 100 - homeProb;

  return (
    <div className="matchup">
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

      <div className="reasons">
        <section>
          <h4>Why {p.home} is favoured</h4>
          {p.why_home.length > 0 ? (
            <ul>
              {p.why_home.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="src">No measurable edge in the published statistics.</p>
          )}
        </section>
        <section>
          <h4>Why {p.away} can win</h4>
          {p.why_away.length > 0 ? (
            <ul>
              {p.why_away.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="src">No measurable edge in the published statistics.</p>
          )}
        </section>
      </div>

      {p.uncertainties.length > 0 && (
        <section className="uncertain">
          <h4>Major uncertainty</h4>
          <ul>
            {p.uncertainties.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>What moved the number</h4>
        <div className="factors">
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
        </div>
      </section>

      <div className="conditions num">
        <span>{m.stadium}</span>
        <span>{m.conditions.indoors ? 'Indoors' : 'Outdoors'}</span>
        {!m.conditions.indoors && m.conditions.wind_mph !== null && (
          <span className={m.conditions.wind_mph >= 15 ? 'warn' : ''}>
            {Math.round(m.conditions.wind_mph)} mph wind
          </span>
        )}
        {!m.conditions.indoors && m.conditions.temperature !== null && (
          <span>{Math.round(m.conditions.temperature)}°F</span>
        )}
        {m.conditions.travel_miles !== null && <span>{m.conditions.travel_miles} mi travel</span>}
        {m.conditions.rest_days[0] !== null && m.conditions.rest_days[1] !== null && (
          <span>
            rest {m.conditions.rest_days[0]}/{m.conditions.rest_days[1]}
          </span>
        )}
      </div>

      {m.injuries.length > 0 && (
        <section>
          <h4>Availability</h4>
          <div className="inj">
            {m.injuries.slice(0, 10).map((i) => (
              <div key={`${i.team}-${i.player}`} className="injury">
                <span className="it">{i.team}</span>
                <span className="ip">
                  {i.position} {i.player}
                </span>
                <span className={`is ${i.status.toLowerCase().replace(/\s+/g, '-')}`}>
                  {i.status}
                </span>
                <span className="iv">−{i.points.toFixed(1)} pts</span>
                <span className="in">{i.note}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4>Records</h4>
        <table className="splits num">
          <thead>
            <tr><th /><th>Overall</th><th>Home</th><th>Road</th><th>Div</th><th>Conf</th></tr>
          </thead>
          <tbody>
            {[m.home_context, m.away_context].map((c) => (
              <tr key={c.team}>
                <td className="tm">{c.team}</td>
                <td>{c.record.overall ?? '—'}</td>
                <td>{c.record.home ?? '—'}</td>
                <td>{c.record.road ?? '—'}</td>
                <td>{c.record.division ?? '—'}</td>
                <td>{c.record.conference ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h4>Recent form against the season</h4>
        {[m.home_context, m.away_context].map((c) => {
          const last3 = c.recent.slice(0, 3);
          const avg3 = last3.length > 0 ? last3.reduce((s, x) => s + x, 0) / last3.length : null;
          const drift = avg3 !== null && c.season_margin !== null ? avg3 - c.season_margin : null;
          return (
            <div className="form" key={c.team}>
              <span className="tm">{c.team}</span>
              <span className="marg">
                {c.recent.map((x, i) => (
                  <span key={i} className={x >= 0 ? 'pos' : 'neg'}>
                    {x >= 0 ? '+' : ''}
                    {x}
                  </span>
                ))}
              </span>
              <span className="fd">
                last 3 average {avg3?.toFixed(1) ?? '—'} against a season {c.season_margin ?? '—'}
                {drift !== null && Math.abs(drift) >= 4
                  ? ` — ${drift > 0 ? 'improving' : 'sliding'} relative to the full year`
                  : ''}
              </span>
            </div>
          );
        })}
      </section>

      <section>
        <h4>Trenches</h4>
        {(['home', 'away'] as const).map((side) => {
          const t = m.trenches[side];
          const team = side === 'home' ? p.home : p.away;
          return (
            <div className={`trench ${t.severity.toLowerCase()}`} key={side}>
              <span className="tm">{team} protection</span>
              <span className={`sev ${t.severity.toLowerCase()}`}>{t.severity}</span>
              <span className="fd">{t.detail}</span>
              {t.line_injuries.length > 0 && (
                <span className="fd warn">Line: {t.line_injuries.join(', ')}</span>
              )}
            </div>
          );
        })}
      </section>

      <section>
        <h4>Turnovers</h4>
        {[m.home_context, m.away_context].map((c) => (
          <div className="turnover" key={c.team}>
            <span className="tm">{c.team}</span>
            <span className="fd">
              {c.turnovers.margin_per_game !== null
                ? `${c.turnovers.margin_per_game > 0 ? '+' : ''}${c.turnovers.margin_per_game.toFixed(2)} per game. `
                : ''}
              {c.turnovers.luck_note}
            </span>
          </div>
        ))}
      </section>

      {m.common_opponents.opponents.length > 0 && (
        <section>
          <h4>Common opponents</h4>
          <div className="commons">
            {m.common_opponents.opponents.slice(0, 6).map((o) => (
              <div className="cmn" key={o.opponent}>
                <span className="tm">{o.opponent}</span>
                <span className="num">{o.home_margin >= 0 ? '+' : ''}{o.home_margin}</span>
                <span className="vs">vs</span>
                <span className="num">{o.away_margin >= 0 ? '+' : ''}{o.away_margin}</span>
                <span className={o.difference >= 0 ? 'pos' : 'neg'}>
                  {o.difference >= 0 ? '+' : ''}
                  {o.difference}
                </span>
              </div>
            ))}
          </div>
          <p className="src">{m.common_opponents.caveat}</p>
        </section>
      )}

      <section>
        <h4>Head to head</h4>
        <p className="src">
          {m.head_to_head.meetings.length > 0
            ? `${m.head_to_head.home_wins}-${m.head_to_head.away_wins} in this sample. `
            : ''}
          {m.head_to_head.note}
        </p>
      </section>

      <section>
        <h4>Market</h4>
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
            <p className="src">{m.market.note}</p>
          </>
        ) : (
          <p className="src">No venue prices this game.</p>
        )}
      </section>

      {(m.home_context.news.length > 0 || m.away_context.news.length > 0) && (
        <section>
          <h4>Recent news</h4>
          <div className="newsgrid">
            {[m.home_context, m.away_context].map((c) => (
              <div key={c.team}>
                <b className="tm">{c.team}</b>
                <ul>
                  {c.news.slice(0, 5).map((n) => (
                    <li key={n.headline}>{n.headline}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="src">
            Headlines as published, unfiltered. Deciding which of these matters for this game is
            an editorial call, and one made automatically would be a guess presented as analysis.
          </p>
        </section>
      )}

      <details className="mm-gaps">
        <summary>What this projection does not use</summary>
        <ul>
          {p.not_modelled.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>

      <p className="src">
        Statistics from the {m.stats_season} season
        {m.stats_are_prior_season ? ' — the last one completed' : ''}. The projection is computed
        before any market price is read, so it can disagree with the book rather than restate it.
      </p>
    </div>
  );
}
