/**
 * @arbterminal/adapters — venue integrations, minus anything needing a disk.
 *
 * Nothing in this package is imported by the matching or arbitrage engines.
 * Adding a venue means adding a directory here and registering the adapter;
 * no engine code changes.
 *
 * This is the entry point a browser or WebView build must use. It is the
 * whole package except the filesystem-backed CSV directory adapter, which
 * pulls in `node:fs` and cannot be bundled for a phone. `index.ts` is this
 * plus that one module, for Node callers.
 *
 * The split is structural rather than advisory: a mobile build that reached
 * for the wrong entry point used to fail deep inside the bundler with an
 * unresolved `node:fs`, which says nothing about what went wrong.
 */

export * from './types.js';
export * from './kalshi/client.js';
export * from './kalshi/fees.js';
export * from './kalshi/normalize.js';
export * from './kalshi/adapter.js';
export * from './polymarket/client.js';
export * from './polymarket/fees.js';
export * from './polymarket/adapter.js';
// Same collision as the manual normalizer below: every adapter owns a
// `toMarket`/`toQuote` of its own, so they are named rather than splatted.
export {
  POLYMARKET_VENUE,
  categoryOf as polymarketCategoryOf,
  detectExhaustive as polymarketDetectExhaustive,
  isTradeable as polymarketIsTradeable,
  parseJsonArray as polymarketParseJsonArray,
  tokenIdsOf as polymarketTokenIds,
  toLadder as polymarketToLadder,
  toOrderBook as polymarketToOrderBook,
  toSettlement as polymarketToSettlement,
  toMarket as polymarketToMarket,
  toQuote as polymarketToQuote,
  toEvent as polymarketToEvent,
} from './polymarket/normalize.js';
export * from './history/index.js';
export * from './nfl/espn.js';
export * from './nfl/stadiums.js';
export * from './fighters/ufcstats.js';
export * from './fighters/dossier.js';
export * from './fighters/card.js';
export * from './manual/csv.js';
export * from './manual/repair.js';
export * from './manual/rules.js';
export * from './manual/adapter.js';
// `toMarket`, `toQuote` and friends exist in both normalizers by design —
// each adapter owns its own mapping — so the manual ones are renamed rather
// than star-exported into a collision.
export {
  interpret as interpretManualRow,
  parseDeadline as parseManualDeadline,
  categoryOf as manualCategoryOf,
  toMarket as manualToMarket,
  toEvent as manualToEvent,
  toQuote as manualToQuote,
  toBook as manualToBook,
  type Interpretation as ManualInterpretation,
  type NormalizeContext as ManualNormalizeContext,
} from './manual/normalize.js';

/*
 * The screens, as services.
 *
 * These sit here rather than in the server because both the desktop app and
 * the phone build run them — the phone has no server at all, and duplicating
 * the orchestration would mean two implementations of the same screen
 * drifting apart. Every network call takes an injected transport, which is
 * what makes that possible.
 */
export {
  ScannerService,
  type ScannerFeed,
  type ScannerOptions,
} from './services/scanner.js';
export {
  NflService,
  type NflBoard,
  type NflOptions,
  type MatchupView,
  type TeamContext,
} from './services/nfl.js';
export {
  UfcBoardService,
  UfcDeepService,
  type FighterDataSource,
  type UfcOptions,
  type UfcBoard as UfcBoardData,
  type DeepMatchupRead,
  type DeepFighterRead,
} from './services/ufc.js';

import { FeeBook } from '@arbterminal/core';
import { AdapterRegistry, type VenueAdapter } from './types.js';

/** Collect every registered adapter's fee schedule into one book. */
export function feeBookFor(adapters: VenueAdapter[]): FeeBook {
  const book = new FeeBook();
  for (const adapter of adapters) book.register(adapter.fee_model);
  return book;
}

export function registryOf(adapters: VenueAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
