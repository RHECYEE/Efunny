import {
  NflService,
  ScannerService,
  UfcBoardService,
  UfcDeepService,
} from '@arbterminal/adapters/browser';
import { companionFighterSource, normalizeBase } from './companion.js';
import { nativeFetch } from './http.js';

/**
 * The other three screens, running on the handset.
 *
 * There is no server in this build, so these are the same service classes the
 * desktop runs, handed a native transport instead of the global one. Nothing
 * about the analysis differs — the projection, the scoring and the grappling
 * model all live in `@arbterminal/core` and are identical on both — only the
 * budgets, which are set for a phone on a mobile connection rather than a
 * machine on a wire.
 *
 * A phone gets smaller sweeps for a reason that is not politeness: every
 * request is a visible pause on a screen somebody is holding. Sixty history
 * requests is a couple of seconds on a server and most of a minute here.
 */

/** Bounds chosen for a handset, not a datacentre. */
const PHONE = {
  request_timeout_ms: 12_000,
  /** History requests per scanner pass. */
  history_budget: 18,
  kalshi_market_limit: 150,
  polymarket_event_limit: 60,
};

let scanner: ScannerService | null = null;
let nfl: NflService | null = null;
let ufc: UfcBoardService | null = null;
let ufcDeep: UfcDeepService | null = null;
let ufcCompanion = '';

export function scannerService(): ScannerService {
  scanner ??= new ScannerService({
    fetch_impl: nativeFetch,
    request_timeout_ms: PHONE.request_timeout_ms,
    history_budget: PHONE.history_budget,
    kalshi_market_limit: PHONE.kalshi_market_limit,
    polymarket_event_limit: PHONE.polymarket_event_limit,
  });
  return scanner;
}

export function nflService(): NflService {
  nfl ??= new NflService({
    fetch_impl: nativeFetch,
    request_timeout_ms: PHONE.request_timeout_ms,
  });
  return nfl;
}

/**
 * The UFC board, with career statistics if a companion desktop is configured.
 *
 * Rebuilt when the companion address changes, because the fighter source is
 * fixed at construction and a board cached without one would otherwise keep
 * reporting that the grappling model did not run after the user has just
 * supplied the means to run it.
 */
export function ufcServices(companionUrl: string): {
  board: UfcBoardService;
  deep: UfcDeepService;
} {
  const normalized = normalizeBase(companionUrl);
  if (!ufc || !ufcDeep || normalized !== ufcCompanion) {
    ufcCompanion = normalized;
    const fighters = companionFighterSource({
      baseUrl: normalized,
      fetchImpl: nativeFetch,
      timeoutMs: PHONE.request_timeout_ms,
    });
    ufc = new UfcBoardService({
      fetch_impl: nativeFetch,
      request_timeout_ms: PHONE.request_timeout_ms,
      ...(fighters ? { fighters } : {}),
    });
    ufcDeep = new UfcDeepService(ufc);
  }
  return { board: ufc, deep: ufcDeep };
}
