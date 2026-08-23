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
