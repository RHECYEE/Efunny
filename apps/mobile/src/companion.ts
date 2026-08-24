import type {
  FighterDataSource,
  FighterProfile,
  FightDetail,
} from '@arbterminal/adapters/browser';

/**
 * The one thing a phone cannot fetch for itself.
 *
 * Everything else on this app's four screens is plain HTTP and runs on the
 * handset. UFCStats is not: it serves its pages behind a check that only
 * clears once the page's own script has executed, so reading it needs a real
 * browser engine driving a real page. A WebView cannot be pointed at it and
 * asked nicely — the request has to be made by something that will run the
 * script and wait.
 *
 * So the career statistics are the one borrowed capability. If the desktop
 * app is running on the same network, the phone asks it; if it is not, the
 * UFC tab still shows both venues' prices and every fighter's identity, and
 * says plainly that the grappling model did not run. It never fills the gap
 * with a guess.
 */

export interface CompanionOptions {
  /** e.g. "http://192.168.1.40:8787". Empty means no companion. */
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

/** Trim a trailing slash so the caller can paste either form. */
export function normalizeBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function companionFighterSource(options: CompanionOptions): FighterDataSource | null {
  const base = normalizeBase(options.baseUrl);
  if (!base) return null;

  async function getJson<T>(path: string): Promise<T> {
    const response = await options.fetchImpl(`${base}${path}`);
    if (!response.ok) throw new Error(`Companion responded ${response.status}`);
    return (await response.json()) as T;
  }

  return {
    async profiles(names) {
      const out = new Map<string, FighterProfile | null>();
      // One request for the whole card. A phone asking for thirty fighters
      // one at a time over a home network is thirty round trips for a screen
      // somebody is waiting on.
      const body = await getJson<{ profiles: Array<{ name: string; profile: FighterProfile | null }> }>(
        `/api/ufc/profiles?names=${encodeURIComponent(names.join('|'))}`,
      );
      for (const row of body.profiles) out.set(row.name, row.profile);
      return out;
    },
    async fightDetails(name, fighterUrl, limit) {
      const body = await getJson<{ details: FightDetail[] }>(
        `/api/ufc/fights?name=${encodeURIComponent(name)}` +
          `&url=${encodeURIComponent(fighterUrl)}&limit=${limit}`,
      );
      return body.details;
    },
    describe: `UFCStats, via the desktop app at ${base}`,
  };
}
