import { CapacitorHttp } from '@capacitor/core';
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

/**
 * The whole pipeline, on the phone.
 *
 * There is no server in this build. The same `@arbterminal/core` the desktop
 * app uses runs here unchanged — normalization, matching, the arb engine —
 * because core has no dependencies and touches no I/O. Only the two edges
 * differ: prices come from a file the user picked instead of a directory, and
 * HTTP goes through the native layer.
 */

/**
 * Kalshi rejects any request carrying an `Origin` header — with a 403,
 * whatever the value, and regardless of User-Agent. A WebView `fetch()` always
 * attaches one on a cross-origin call, so the browser networking stack simply
 * cannot reach this API. That is not a CORS misconfiguration to work around
 * with a proxy; it is why this app has to exist as a native shell rather than
 * a web page.
 *
 * `CapacitorHttp` performs the request in Java, which sends no Origin, so the
 * adapter is handed this in place of `fetch` and is otherwise untouched.
 */
/**
 * Give a promise a deadline it cannot outlive.
 *
 * `CapacitorHttp` resolves through the native bridge, and a bridge that is
 * missing or wedged leaves the promise pending forever rather than
 * rejecting — which surfaces as a scan button stuck on "Scanning…" with no
 * way back. A phone on a flaky connection produces the same symptom. Every
 * network path here therefore carries its own deadline.
 */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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

const nativeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const response = await withDeadline(
    CapacitorHttp.request({
      url,
      method: (init?.method ?? 'GET') as 'GET',
      headers: { accept: 'application/json' },
      // Ask for the parsed body; Capacitor hands back an object for JSON.
      responseType: 'json',
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
    }),
    REQUEST_TIMEOUT_MS,
    'Kalshi request',
  );

  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  return new Response(body, {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
};

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
