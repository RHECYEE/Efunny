import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAsset, getAssetKeys, isSea } from 'node:sea';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Serving the built UI.
 *
 * Two sources, chosen at runtime:
 *
 *  - Packaged as a single executable, the UI files are embedded in the binary
 *    as SEA assets. There is no `dist` folder on disk to point at, so they are
 *    read out of the binary itself.
 *  - Running from a checkout, they are read from `apps/web/dist` if it has
 *    been built. In development the UI is served by Vite instead, which
 *    proxies /api here, so this handler simply stays out of the way.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

interface AssetSource {
  kind: 'sea' | 'disk' | 'none';
  describe: string;
  read(key: string): Promise<Buffer | null>;
  has(key: string): boolean;
}

function seaSource(): AssetSource | null {
  if (!isSea()) return null;
  const keys = new Set(getAssetKeys());
  if (keys.size === 0) return null;
  return {
    kind: 'sea',
    describe: `${keys.size} files embedded in the executable`,
    has: (key) => keys.has(key),
    async read(key) {
      if (!keys.has(key)) return null;
      return Buffer.from(getAsset(key));
    },
  };
}

function diskSource(): AssetSource | null {
  // From apps/server/src, the built UI sits at ../../web/dist.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const root = resolve(here, '..', '..', 'web', 'dist');
  if (!existsSync(join(root, 'index.html'))) return null;

  return {
    kind: 'disk',
    describe: `served from ${root}`,
    has: (key) => existsSync(join(root, key)),
    async read(key) {
      // Reject anything that escapes the asset root before touching the disk.
      const target = resolve(root, normalize(key));
      if (target !== root && !target.startsWith(root + sep)) return null;
      try {
        return await readFile(target);
      } catch {
        return null;
      }
    },
  };
}

export function webAssetSource(): AssetSource {
  return (
    seaSource() ??
    diskSource() ?? {
      kind: 'none',
      describe: 'not built — run `npm run build`, or use the Vite dev server',
      has: () => false,
      read: async () => null,
    }
  );
}

/**
 * Register the UI routes. `/api/*` is registered first by the caller and is
 * matched ahead of these, so the catch-all cannot shadow the API.
 */
export function registerWeb(app: FastifyInstance): AssetSource {
  const source = webAssetSource();
  if (source.kind === 'none') return source;

  const send = async (key: string, reply: FastifyReply): Promise<unknown> => {
    const body = await source.read(key);
    if (body === null) return null;
    return reply
      .header('content-type', contentTypeFor(key))
      // Vite fingerprints asset filenames, so they are safe to cache hard.
      // index.html must not be, or a rebuilt UI never reaches the browser.
      .header(
        'cache-control',
        key.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      )
      .send(body);
  };

  app.get('/', async (_request, reply) => {
    const sent = await send('index.html', reply);
    if (sent === null) return reply.code(404).send({ error: 'UI not built' });
    return sent;
  });

  app.get('/*', async (request, reply) => {
    const raw = (request.params as { '*': string })['*'] ?? '';
    const key = decodeURIComponent(raw).replace(/^\/+/, '');

    if (source.has(key)) {
      const sent = await send(key, reply);
      if (sent !== null) return sent;
    }

    // Unknown path with no file extension: hand back the app shell so client
    // routing works. A missing *asset* stays a 404 rather than silently
    // returning HTML, which would otherwise surface as a confusing MIME error.
    if (extname(key) === '') {
      const sent = await send('index.html', reply);
      if (sent !== null) return sent;
    }

    return reply.code(404).send({ error: `not found: /${key}` });
  });

  return source;
}
