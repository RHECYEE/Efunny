import { useEffect, useState } from 'react';
import type { ScannerFeed } from '@arbterminal/adapters/browser';
import { scannerService } from '../services.js';
import { formatPrice } from '../format.js';

/**
 * The scanner feed, on a phone.
 *
 * Sorted by research priority, which is a claim about where to *look* and
 * never about where the price is wrong. That distinction survives the smaller
 * screen: the composite keeps the name Interestingness, and the six component
 * scores stay one tap away, because a market that is 97th-percentile active
 * and 20th-percentile liquid should look suspicious rather than exciting and
 * one number cannot say both.
 *
 * The one thing a phone changes is how much history it pulls. Each market
 * costs a request, so the budget is smaller here — a shorter list, scored the
 * same way, rather than the same list scored on less.
 */

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

export function Featured() {
  const [feed, setFeed] = useState<ScannerFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const body = await scannerService().feed();
        if (live) setFeed(body);
      } catch (e) {
        if (live) {
          setFeed({
            markets: [],
            scanned_at: new Date().toISOString(),
            counts: { requested: 0, with_history: 0, failed: 0 },
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
  }, []);

  if (loading) {
    return <p className="empty">Pulling a month of history for each market…</p>;
  }
  if (!feed) return <p className="empty">Could not load the scanner.</p>;

  return (
    <>
      {feed.error && <div className="banner err">Scan failed: {feed.error}</div>}

      <p className="scan-note">
        Ranked by <b>research priority</b> — where to look, not where the price is wrong. Price
        and volume behaviour can find an unusual market; it cannot establish that a market is
        mispriced.
      </p>

      {feed.markets.length === 0 && !feed.error && (
        <p className="empty">No market had enough history to score.</p>
      )}

      {feed.markets.map((m) => {
        const x = m.metrics;
        const isOpen = open === x.market_id;
        return (
          <article
            key={x.market_id}
            className={`scan-row${isOpen ? ' open' : ''}`}
            onClick={() => setOpen(isOpen ? null : x.market_id)}
          >
            <div className="scan-head">
              <span className="score">{m.scores.interestingness}</span>
              <span className="ttl">{x.title}</span>
            </div>
            <div className="line2 num">
              <span>{x.price !== null ? formatPrice(x.price) : '—'}</span>
              <span className={(x.move_24h?.change ?? 0) >= 0 ? 'pos' : 'neg'}>
                {x.move_24h ? `${pts(x.move_24h.change)} pts 24h` : '—'}
              </span>
              <span>{x.venue}</span>
            </div>
            <div className="badges">
              {m.signals.map((g) => (
                <span key={g.kind} className={`badge ${g.tone.toLowerCase()}`}>
                  {g.label}
                </span>
              ))}
            </div>

            {isOpen && (
              <div className="scan-detail">
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
                        {x.move_1h ? pts(x.move_1h.change) : '—'} /{' '}
                        {x.move_24h ? pts(x.move_24h.change) : '—'} /{' '}
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
                      <td>Backing this comparison</td>
                      <td>
                        {x.sample.distribution_points} periods over{' '}
                        {x.sample.span_hours.toFixed(0)}h
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </article>
        );
      })}

      <p className="showing">
        {feed.counts.with_history} of {feed.counts.requested} markets had enough history to score
        {feed.counts.failed > 0 ? `; ${feed.counts.failed} failed to fetch` : ''}. A phone pulls a
        shorter list than the desktop — each market costs a request.
      </p>
    </>
  );
}
