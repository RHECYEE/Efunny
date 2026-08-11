import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Opportunity, PaperTrade, Quote } from '@arbterminal/core';

/**
 * Quote log and paper-trade store.
 *
 * Every quote the poller sees is written here, which is what makes Stage 4
 * backtesting possible at all: an opportunity can only be scored against how
 * it actually behaved if the book that produced it was recorded at the time.
 *
 * `node:sqlite` ships with the runtime, so the whole persistence layer needs
 * no native module and no build step.
 */

export interface QuoteHistoryRow {
  timestamp: string;
  bid: number | null;
  ask: number | null;
  no_bid: number | null;
  no_ask: number | null;
  implied_probability: number | null;
  liquidity: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quote_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id      TEXT NOT NULL,
  venue          TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  bid            INTEGER,
  ask            INTEGER,
  no_bid         INTEGER,
  no_ask         INTEGER,
  implied_probability REAL,
  liquidity      REAL NOT NULL DEFAULT 0,
  book           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quote_log_market_time ON quote_log (market_id, timestamp);

CREATE TABLE IF NOT EXISTS opportunity_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,
  detected_at    TEXT NOT NULL,
  type           TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  net_edge       INTEGER NOT NULL,
  gross_edge     INTEGER NOT NULL,
  match_confidence REAL NOT NULL,
  capacity       REAL NOT NULL,
  payload        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_log_id ON opportunity_log (opportunity_id, detected_at);

CREATE TABLE IF NOT EXISTS paper_trade (
  trade_id       TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  executed_at    TEXT NOT NULL,
  resolution     TEXT NOT NULL,
  realized_pl    INTEGER,
  payload        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_trade_time ON paper_trade (executed_at);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL keeps the poller's writes from blocking API reads.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  recordQuotes(quotes: Array<{ quote: Quote; venue: string }>): void {
    const insert = this.db.prepare(
      `INSERT INTO quote_log
         (market_id, venue, timestamp, bid, ask, no_bid, no_ask, implied_probability, liquidity, book)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const { quote, venue } of quotes) {
        insert.run(
          quote.market_id,
          venue,
          quote.timestamp,
          quote.bid,
          quote.ask,
          quote.no_bid,
          quote.no_ask,
          quote.implied_probability,
          quote.liquidity,
          JSON.stringify(quote.book),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordOpportunities(opportunities: Opportunity[]): void {
    const insert = this.db.prepare(
      `INSERT INTO opportunity_log
         (opportunity_id, detected_at, type, event_id, net_edge, gross_edge,
          match_confidence, capacity, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const opportunity of opportunities) {
        insert.run(
          opportunity.opportunity_id,
          opportunity.detected_at,
          opportunity.type,
          opportunity.event_id,
          opportunity.net_edge,
          opportunity.gross_edge,
          opportunity.match_confidence,
          opportunity.capacity,
          JSON.stringify(opportunity),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Price history for the analysis view, oldest first. */
  quoteHistory(marketId: string, limit = 200): QuoteHistoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT timestamp, bid, ask, no_bid, no_ask, implied_probability, liquidity
           FROM quote_log
          WHERE market_id = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(marketId, limit) as unknown as QuoteHistoryRow[];
    return rows.reverse();
  }

  /** How often this opportunity has been seen, and how its edge has moved. */
  opportunityHistory(opportunityId: string, limit = 200): Array<{
    detected_at: string;
    net_edge: number;
    gross_edge: number;
    capacity: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT detected_at, net_edge, gross_edge, capacity
           FROM opportunity_log
          WHERE opportunity_id = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(opportunityId, limit) as unknown as Array<{
      detected_at: string;
      net_edge: number;
      gross_edge: number;
      capacity: number;
    }>;
    return rows.reverse();
  }

  saveTrade(trade: PaperTrade): void {
    this.db
      .prepare(
        `INSERT INTO paper_trade (trade_id, opportunity_id, executed_at, resolution, realized_pl, payload)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(trade_id) DO UPDATE SET
           resolution = excluded.resolution,
           realized_pl = excluded.realized_pl,
           payload = excluded.payload`,
      )
      .run(
        trade.trade_id,
        trade.opportunity_id,
        trade.executed_at,
        trade.resolution,
        trade.realized_pl,
        JSON.stringify(trade),
      );
  }

  trades(limit = 200): PaperTrade[] {
    const rows = this.db
      .prepare(`SELECT payload FROM paper_trade ORDER BY executed_at DESC LIMIT ?`)
      .all(limit) as unknown as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as PaperTrade);
  }

  trade(tradeId: string): PaperTrade | null {
    const row = this.db
      .prepare(`SELECT payload FROM paper_trade WHERE trade_id = ?`)
      .get(tradeId) as unknown as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as PaperTrade) : null;
  }

  /** Drop quote history past the retention window. */
  prune(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const before = this.count('quote_log');
    this.db.prepare(`DELETE FROM quote_log WHERE timestamp < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM opportunity_log WHERE detected_at < ?`).run(cutoff);
    return before - this.count('quote_log');
  }

  count(table: 'quote_log' | 'opportunity_log' | 'paper_trade'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as {
      n: number;
    };
    return Number(row.n);
  }

  close(): void {
    this.db.close();
  }
}
