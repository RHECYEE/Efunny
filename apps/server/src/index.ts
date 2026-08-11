import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { KalshiAdapter } from '@arbterminal/adapters';
import { buildApi } from './api.js';
import { config } from './config.js';
import { Store } from './db.js';
import { Pipeline } from './pipeline.js';
import { registerWeb } from './web.js';

/**
 * Entry point, shared by the development server and the packaged executable.
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
// Registered after the API so /api/* always wins over the UI catch-all.
const webAssets = registerWeb(app);

/**
 * Bind the configured port, stepping forward if it is taken. A packaged app
 * gets double-clicked twice, or shares a machine with something else on 8787;
 * failing to start with EADDRINUSE would be a dead end for a user with no
 * terminal open.
 */
async function listen(): Promise<number> {
  let lastError: unknown;
  for (let offset = 0; offset < 12; offset += 1) {
    const port = config.port + offset;
    try {
      await app.listen({ port, host: config.host });
      return port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? // The empty string is `start`'s window-title argument. Without it a
        // quoted URL is consumed as the title and nothing opens.
        ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      console.log('[arbterminal] could not open a browser automatically.');
    });
    child.unref();
  } catch {
    console.log('[arbterminal] could not open a browser automatically.');
  }
}

async function main(): Promise<void> {
  const port = await listen();
  const url = `http://${config.host}:${port}`;

  console.log('');
  console.log(`  ArbTerminal is running at  ${url}`);
  console.log('');
  console.log(`  venues     ${adapters.map((a) => a.display_name).join(', ')}`);
  console.log(`  quote log  ${config.database_path}`);
  console.log(`  interface  ${webAssets.describe}`);

  if (config.disable_poller) {
    console.log('  polling    disabled');
  } else {
    console.log(`  polling    every ${config.poll_interval_ms / 1000}s`);
    pipeline.start(config.poll_interval_ms);
  }

  console.log('');
  console.log('  Read-only: no order is ever placed at any venue.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Only take over the screen when the user launched the app itself. From a
  // checkout the UI is usually already open on the Vite dev server.
  if (isSea() || process.env.OPEN_BROWSER === '1') openBrowser(url);
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
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
