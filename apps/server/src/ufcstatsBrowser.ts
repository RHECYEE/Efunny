import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FighterProfile, UfcStatsBrowser } from '@arbterminal/adapters';
import { fetchProfile } from '@arbterminal/adapters';

/**
 * Playwright-backed reader for UFCStats, plus a disk cache.
 *
 * The site gates on a browser check, so there is no cheap way to read it —
 * every fighter costs a page load and a few seconds. Two consequences shape
 * this file: the browser is opened once for a whole batch rather than per
 * fighter, and results are cached on disk, because career averages move on
 * the timescale of a fight camp and there is no reason to pay for them twice
 * in a week.
 *
 * Playwright is imported dynamically so that neither the core nor the
 * adapters package acquires a browser dependency, and so a deployment that
 * never opens the UFC tab never loads it.
 */

const CACHE_DIR = process.env.ARBTERMINAL_CACHE ?? '.cache/ufcstats';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  fetched_at: number;
  profile: FighterProfile | null;
}

function cachePath(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return join(CACHE_DIR, `${key}.json`);
}

function readCache(name: string): CacheEntry | null {
  try {
    const path = cachePath(name);
    if (!existsSync(path)) return null;
    const entry = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
    if (Date.now() - entry.fetched_at > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(name: string, profile: FighterProfile | null): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath(name),
      JSON.stringify({ fetched_at: Date.now(), profile } satisfies CacheEntry),
    );
  } catch {
    // A cache that cannot be written is a slower run, not a failure.
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Open a browser, if this deployment has one.
 *
 * Playwright is imported dynamically and left untyped at the boundary: it is
 * not a dependency of this package, and adding it as one would force a
 * browser download on every install for a feature most runs never touch.
 * The DOM callbacks below execute inside the page, not here, so they are
 * deliberately written without DOM types.
 */
async function openBrowser(): Promise<{ reader: UfcStatsBrowser; close: () => Promise<void> }> {
  // Resolved at runtime through a variable so the compiler does not try to
  // type a package this workspace does not depend on.
  const specifier: string = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
  const fallback: string =
    process.env.PLAYWRIGHT_FALLBACK ?? '/opt/node22/lib/node_modules/playwright/index.mjs';
  const mod: any = await import(specifier).catch(() => import(fallback));
  const browser: any = await mod.chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  });
  const page: any = await browser.newPage();

  const reader: UfcStatsBrowser = {
    async read(url: string) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // The browser check swaps the real document in after a moment.
      await page.waitForTimeout(3_000);
      const text: string = await page.innerText('body').catch(() => '');
      const rows: string[][] = await page
        .$$eval('tbody tr', (trs: any[]) =>
          trs.map((tr: any) =>
            Array.from(tr.querySelectorAll('td')).map((td: any) =>
              td.innerText.replace(/\s+/g, ' ').trim(),
            ),
          ),
        )
        .catch(() => []);
      const links: Array<{ href: string; text: string }> = await page
        .$$eval('a[href]', (as: any[]) =>
          as.map((a: any) => ({ href: a.href, text: (a.textContent ?? '').trim() })),
        )
        .catch(() => []);
      return { text, rows, links };
    },
    async close() {
      await browser.close();
    },
  };

  return { reader, close: () => browser.close() };
}

/**
 * Career profiles for a batch of fighters.
 *
 * Cached names never open a browser at all, so a second look at the same card
 * costs nothing. A fighter the site has no page for is cached as a null,
 * which stops a name that will never resolve from being retried on every
 * scan.
 */
export async function fetchProfiles(
  names: string[],
  options: { budget?: number } = {},
): Promise<Map<string, FighterProfile | null>> {
  const out = new Map<string, FighterProfile | null>();
  const missing: string[] = [];

  for (const name of names) {
    const cached = readCache(name);
    if (cached) out.set(name, cached.profile);
    else missing.push(name);
  }

  const budget = options.budget ?? 40;
  const toFetch = missing.slice(0, budget);
  if (toFetch.length === 0) return out;

  let session: Awaited<ReturnType<typeof openBrowser>> | null = null;
  try {
    session = await openBrowser();
    for (const name of toFetch) {
      try {
        const profile = await fetchProfile(session.reader, name);
        out.set(name, profile);
        writeCache(name, profile);
      } catch {
        out.set(name, null);
      }
    }
  } catch {
    // No browser available: every uncached fighter is simply unknown, which
    // the screen already knows how to say.
    for (const name of toFetch) out.set(name, null);
  } finally {
    await session?.close().catch(() => undefined);
  }

  return out;
}
