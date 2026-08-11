import { KalshiAdapter } from '@arbterminal/adapters';
import { buildApi } from './api.js';
import { config } from './config.js';
import { Store } from './db.js';
import { Pipeline } from './pipeline.js';

/**
 * Entry point.
 *
 * Stage 1 registers exactly one adapter. Adding a venue is a line in this
 * array plus a directory under packages/adapters — the pipeline, matcher and
 * arb engine do not change.
 */
const adapters = [
  new KalshiAdapter({
    market_limit: config.market_limit,
    depth_fetch_limit: config.depth_fetch_limit,
  }),
];

const store = new Store(config.database_path);
const pipeline = new Pipeline(adapters, store, {
  market_limit: config.market_limit,
  stale_quote_ms: config.stale_quote_ms,
  min_net_edge: config.min_net_edge,
  history_retention_days: config.history_retention_days,
});

const app = buildApi({ pipeline, store, adapters });

async function main(): Promise<void> {
  await app.listen({ port: config.port, host: config.host });
  console.log(`[arbterminal] API listening on http://${config.host}:${config.port}`);
  console.log(`[arbterminal] venues: ${adapters.map((a) => a.display_name).join(', ')}`);

  if (config.disable_poller) {
    console.log('[arbterminal] poller disabled');
    return;
  }
  console.log(`[arbterminal] polling every ${config.poll_interval_ms / 1000}s`);
  pipeline.start(config.poll_interval_ms);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    pipeline.stop();
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error('[arbterminal] failed to start:', error);
  process.exit(1);
});
