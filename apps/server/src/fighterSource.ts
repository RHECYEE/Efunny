import type { FighterDataSource } from '@arbterminal/adapters';
import { fetchProfiles, fetchRecentFightDetails } from './ufcstatsBrowser.js';

/**
 * The desktop's fighter source: a real browser.
 *
 * UFCStats serves its pages behind a check that only clears once the page's
 * own script has run, so there is no cheap request that reaches them. This
 * build has Chromium, so it reads them directly — career boxes for a whole
 * card, and per-round lines from individual bouts on demand.
 *
 * This is the half of the UFC screen a phone cannot do for itself, which is
 * why the service takes it as an argument rather than reaching for it.
 */
export const browserFighterSource: FighterDataSource = {
  profiles: (names, options) => fetchProfiles(names, options ?? {}),
  fightDetails: (name, url, limit) => fetchRecentFightDetails(name, url, limit),
  describe: 'UFCStats, read in a local browser',
};
