/**
 * @arbterminal/adapters — venue integrations.
 *
 * Nothing in this package is imported by the matching or arbitrage engines.
 * Adding a venue means adding a directory here and registering the adapter;
 * no engine code changes.
 */

export * from './types.js';
export * from './kalshi/client.js';
export * from './kalshi/fees.js';
export * from './kalshi/normalize.js';
export * from './kalshi/adapter.js';

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
