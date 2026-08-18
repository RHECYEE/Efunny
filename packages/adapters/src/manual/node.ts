import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ManualCsvAdapter, type ManualCsvAdapterOptions } from './adapter.js';
import { parseHouseRules, RULES_FILENAME, type HouseRules } from './rules.js';

/**
 * The filesystem half of the manual venue.
 *
 * Everything that reads a disk lives here, and nothing else imports it, so
 * the import logic itself stays runnable in a browser or a WebView where
 * `node:fs` does not exist. The server uses this; the mobile app feeds the
 * same adapter from a file picker instead.
 */

export interface ManualCsvDirectoryOptions extends ManualCsvAdapterOptions {
  /** Folder scanned for `.csv` files. Every file found is imported. */
  directory: string;
}

export function loadHouseRules(directory: string): HouseRules | null {
  const path = existsSync(directory) && statSync(directory).isDirectory()
    ? join(directory, RULES_FILENAME)
    : directory;
  if (!existsSync(path)) return null;
  try {
    return parseHouseRules(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A manual venue that re-reads its directory on every cycle, so dropping in a
 * new capture or editing the rules takes effect without a restart.
 */
export class ManualCsvDirectoryAdapter extends ManualCsvAdapter {
  constructor(private readonly directoryOptions: ManualCsvDirectoryOptions) {
    super(directoryOptions);
  }

  private files(): string[] {
    const directory = this.directoryOptions.directory;
    if (!existsSync(directory)) return [];
    if (!statSync(directory).isDirectory()) return [directory];
    return readdirSync(directory)
      .filter((name) => extname(name).toLowerCase() === '.csv')
      .sort()
      .map((name) => join(directory, name));
  }

  override async fetchSnapshots(options = {}) {
    this.setSources(
      this.files().map((file) => {
        try {
          return { name: file, text: readFileSync(file, 'utf8') };
        } catch {
          return { name: file, text: '' };
        }
      }),
    );
    const rules = loadHouseRules(this.directoryOptions.directory);
    this.setHouseRules(rules ? JSON.stringify(rules) : '');
    return super.fetchSnapshots(options);
  }
}
