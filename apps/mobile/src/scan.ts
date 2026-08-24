import {
  FeeBook,
  countOpportunities,
  matchMarkets,
  scan as runScan,
  type EventSnapshot,
  type Opportunity,
  type OpportunityCounts,
} from '@arbterminal/core';
import { KalshiAdapter } from '../../../packages/adapters/src/kalshi/adapter.js';
import { ManualCsvAdapter, type ImportDiagnostics } from './manualAdapter.js';
import { nativeFetch, withDeadline } from './http.js';

/**
 * Mobile deadlines are much tighter than the server's.
 *
 * Someone holding a phone is watching the button, not a log. A scan of a
 * named series is a handful of requests and should take about two seconds;
 * anything past twenty means the answer is not coming, and saying so beats
 * spinning.
 */
const REQUEST_TIMEOUT_MS = 8_000;
const SCAN_TIMEOUT_MS = 20_000;

/**
 * The whole pipeline, on the phone.
 *
 * There is no server in this build. The same `@arbterminal/core` the desktop
 * app uses runs here unchanged — normalization, matching, the arb engine —
 * because core has no dependencies and touches no I/O. Only the two edges
 * differ: prices come from a file the user picked instead of a directory, and
 * HTTP goes through the native layer.
 */

export interface ScanInput {
  /** CSV documents the user imported. */
  sources: Array<{ name: string; text: string }>;
  /** Optional house-rules JSON. Empty string means none. */
  rulesText: string;
  /** Kalshi series to sweep, e.g. ["KXBTCMAXY"]. */
  series: string[];
  venue: string;
  displayName: string;
  stakeLimitDollars: number;
}

export interface ScanOutput {
  opportunities: Opportunity[];
  counts: OpportunityCounts;
  diagnostics: ImportDiagnostics | null;
  kalshiMarkets: number;
  importedMarkets: number;
  matches: number;
  scannedAt: string;
  error: string | null;
}

export async function scanOnDevice(input: ScanInput): Promise<ScanOutput> {
  const manual = new ManualCsvAdapter({
    venue: input.venue,
    display_name: input.displayName,
    assumed_stake_limit_dollars: input.stakeLimitDollars,
  });
  manual.setSources(input.sources);
  manual.setHouseRules(input.rulesText);

  const kalshi = new KalshiAdapter({
    fetch_impl: nativeFetch,
    series_tickers: input.series,
    // The client's own retry ladder compounds with the deadlines above; one
    // retry is the most a phone should wait before being told what happened.
    max_retries: 1,
    timeout_ms: REQUEST_TIMEOUT_MS,
    // One depth request per market, on a phone connection. Enough to price
    // the handful of markets a capture actually lines up against.
    depth_fetch_limit: 40,
  });

  const manualSnapshots: EventSnapshot[] = await manual.fetchSnapshots();
  let kalshiSnapshots: EventSnapshot[] = [];
  let error: string | null = null;
  try {
    kalshiSnapshots = await withDeadline(
      kalshi.fetchSnapshots({}),
      SCAN_TIMEOUT_MS,
      'Kalshi scan',
    );
  } catch (e) {
    // The capture is still worth showing on its own; say what failed rather
    // than returning an empty screen.
    error = e instanceof Error ? e.message : String(e);
  }

  const events = [...kalshiSnapshots, ...manualSnapshots];
  const markets = events.flatMap((e) => e.markets.map((m) => m.market));
  const matches = matchMarkets(markets);

  // Each adapter carries its own fee schedule as data; the engine only ever
  // sees this book, never a venue name.
  const fees = new FeeBook().register(kalshi.fee_model).register(manual.fee_model);
  const result = runScan({ events, matches }, { fees });

  return {
    opportunities: result.opportunities,
    counts: countOpportunities(result.opportunities),
    diagnostics: manual.diagnostics,
    kalshiMarkets: kalshiSnapshots.reduce((n, e) => n + e.markets.length, 0),
    importedMarkets: manualSnapshots.length,
    matches: matches.length,
    scannedAt: result.scanned_at,
    error,
  };
}
