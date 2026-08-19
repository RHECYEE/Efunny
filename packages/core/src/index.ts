/**
 * @arbterminal/core — deterministic domain model, matching and arbitrage math.
 *
 * This package has no dependencies, performs no I/O and makes no LLM calls.
 * Everything that decides an edge, a stake or a P/L number lives here so it
 * can be unit-tested without a network or a model in the loop.
 */

export * from './domain/money.js';
export * from './domain/types.js';
export * from './domain/ids.js';

export * from './normalize/book.js';
export * from './normalize/odds.js';
export * from './normalize/canonical.js';

export * from './match/confidence.js';
export * from './match/settlementDiff.js';
export * from './match/assurance.js';
export * from './match/engine.js';

export * from './arb/fees.js';
export * from './arb/reserve.js';
export * from './arb/hedge.js';
export * from './arb/position.js';
export * from './arb/engine.js';

export * from './paper/simulator.js';
export * from './portfolio/allocation.js';
export * from './portfolio/cart.js';
export * from './portfolio/filters.js';
