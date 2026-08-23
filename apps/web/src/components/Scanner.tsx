import { useEffect, useState } from 'react';
import { formatPrice } from '../format.js';

/**
 * The scanner feed.
 *
 * Sorted by research priority, which is a claim about where to *look* and
 * never about where the price is wrong. That distinction is the reason the
 * composite is called Interestingness and the reason the six component scores
 * are shown next to it: a market that is 97th-percentile active and
 * 20th-percentile liquid should look suspicious rather than exciting, and a
 * single number cannot say both.
 */

interface Signal {
  kind: string;
  label: string;
  detail: string;
  tone: 'INFO' | 'GOOD' | 'WARN';
}

interface Scored {
  metrics: {
    market_id: string;
    venue: string;
    title: string;
    price: number | null;
    move_1h: { change: number; covered: boolean } | null;
    move_24h: { change: number; covered: boolean } | null;
    move_7d: { change: number; covered: boolean } | null;
    volume_24h: number;
    volume_acceleration: number | null;
    was_dormant: boolean;
    has_volume_data: boolean;
    realized_volatility: number;
    book: { spread: number | null; depth: number; imbalance: number | null };
    time_remaining_ms: number | null;
    percentiles: { volume: number; volatility: number; move_24h: number; velocity: number };
    sample: { points: number; span_hours: number; distribution_points: number };
  };
  scores: {
    activity: number;
    momentum: number;
    volatility: number;
    liquidity: number;
    market_quality: number;
    anomaly: number;
    interestingness: number;
  };
  signals: Signal[];
}

interface Feed {
  markets: Scored[];
  scanned_at: string;
  counts: { requested: number; with_history: number; failed: number };
  error: string | null;
}

const pts = (dc: number) => `${dc > 0 ? '+' : ''}${((dc / 1000) * 100).toFixed(1)}`;

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="sbar">
      <span className="sl">{label}</span>
      <span className="st">
        <span style={{ width: `${value}%` }} />
      </span>
      <span className="sv">{value}</span>
    </div>
  );
}

export function Scanner() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/scanner');
        const body = (await response.json()) as Feed;
        if (live) setFeed(body);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (loading) {
    return <div className="empty">Pulling a month of history for each market…</div>;
  }
  if (!feed) return <div className="empty">Could not load the scanner.</div>;

  return (
    <>
      {feed.error && <div className="banner err">Scan failed: {feed.error}</div>}

      <div className="scan-note">
        Ranked by <b>research priority</b> — where to look, not where the price is wrong. Price
        and volume behaviour can find an unusual market; it cannot establish that a market is
        mispriced.
      </div>

      <div className="scan-feed">
        {feed.markets.map((m) => {
          const x = m.metrics;
          const s = m.scores;
          const isOpen = open === x.market_id;
          return (
            <article
              key={x.market_id}
              className="scan-row"
              onClick={() => setOpen(isOpen ? null : x.market_id)}
            >
              <div className="score">{s.interestingness}</div>
              <div className="main">
                <div className="line1">
                  <span className="ttl">{x.title}</span>
                  <span className="venue">{x.venue}</span>
                </div>
                <div className="line2 num">
                  <span>{x.price !== null ? formatPrice(x.price) : '—'}</span>
                  <span className={(x.move_24h?.change ?? 0) >= 0 ? 'pos' : 'neg'}>
                    {x.move_24h ? `${pts(x.move_24h.change)} pts 24h` : '—'}
                  </span>
                  <span>
                    {x.has_volume_data ? `${x.volume_24h.toLocaleString()} vol` : 'vol not published'}
                  </span>
                  <span>
                    {x.book.spread !== null ? `${pts(x.book.spread).replace('+', '')} spread` : ''}
                  </span>
                </div>
                <div className="badges">
                  {m.signals.map((g) => (
                    <span key={g.kind} className={`badge ${g.tone.toLowerCase()}`}>
                      {g.label}
                    </span>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {open && (() => {
        const m = feed.markets.find((z) => z.metrics.market_id === open);
        if (!m) return null;
        const x = m.metrics;
        return (
          <div className="scan-detail">
            <h3>{x.title}</h3>
            <div className="scores">
              <Bar label="Activity" value={m.scores.activity} />
              <Bar label="Momentum" value={m.scores.momentum} />
              <Bar label="Volatility" value={m.scores.volatility} />
              <Bar label="Liquidity" value={m.scores.liquidity} />
              <Bar label="Market quality" value={m.scores.market_quality} />
              <Bar label="Anomaly" value={m.scores.anomaly} />
            </div>

            {m.signals.map((g) => (
              <p key={g.kind} className={`sig ${g.tone.toLowerCase()}`}>
                <b>{g.label}</b> — {g.detail}
              </p>
            ))}

            <table className="num">
              <tbody>
                <tr>
                  <td>1h / 24h / 7d</td>
                  <td>
                    {x.move_1h ? pts(x.move_1h.change) : '—'} / {x.move_24h ? pts(x.move_24h.change) : '—'} /{' '}
                    {x.move_7d ? pts(x.move_7d.change) : '—'} pts
                  </td>
                </tr>
                <tr>
                  <td>Volume vs its own normal</td>
                  <td>
                    {!x.has_volume_data
                      ? 'venue publishes no volume'
                      : x.was_dormant
                        ? 'was dormant'
                        : `${(x.volume_acceleration ?? 0).toFixed(1)}x`}
                  </td>
                </tr>
                <tr>
                  <td>Volume percentile (own history)</td>
                  <td>{x.has_volume_data ? Math.round(x.percentiles.volume * 100) : '—'}</td>
                </tr>
                <tr>
                  <td>Volatility percentile (own history)</td>
                  <td>{Math.round(x.percentiles.volatility * 100)}</td>
                </tr>
                <tr>
                  <td>Resting depth</td>
                  <td>{x.book.depth.toLocaleString()}</td>
                </tr>
                <tr>
                  <td>Book imbalance</td>
                  <td>
                    {x.book.imbalance === null
                      ? '—'
                      : `${Math.round(Math.abs(x.book.imbalance) * 100)}% ${x.book.imbalance > 0 ? 'bid' : 'ask'}`}
                  </td>
                </tr>
                <tr>
                  <td>Backing this comparison</td>
                  <td>
                    {x.sample.distribution_points} periods over {x.sample.span_hours.toFixed(0)}h
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })()}

      <div className="showing">
        {feed.counts.with_history} of {feed.counts.requested} markets had enough history to
        score{feed.counts.failed > 0 ? `; ${feed.counts.failed} failed to fetch` : ''}.
      </div>
    </>
  );
}
