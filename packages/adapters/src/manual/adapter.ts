import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  VigInPriceFeeModel,
  type EventSnapshot,
  type FeeModel,
  type MarketSnapshot,
  type Quote,
} from '@arbterminal/core';
import type { AdapterCapabilities, FetchOptions, VenueAdapter } from '../types.js';
import { parseCsv } from './csv.js';
import { validateRows, type ImportResult, type RepairOptions } from './repair.js';
import { toEvent, toMarket, toQuote, type NormalizeContext } from './normalize.js';
import { loadHouseRules, type HouseRules } from './rules.js';

/**
 * An adapter over manually captured price files.
 *
 * Books like DraftKings and bet365 publish no usable API, and this project
 * does not scrape. What it can do is read prices the user captured themselves
 * and dropped in a folder as CSV.
 *
 * That makes cross-venue comparison possible today, at a cost that is
 * recorded rather than hidden: the prices are a snapshot that does not update,
 * there is no order book behind them, and transcription errors are real. All
 * three travel with every record as provenance, and the engine refuses to
 * present an assumed capacity as an observed one.
 */

export interface ManualCsvAdapterOptions extends RepairOptions {
  /** Machine identifier used as `Market.venue`, e.g. "draftkings". */
  venue: string;
  display_name: string;
  /** Folder scanned for `.csv` files. Every file found is imported. */
  directory: string;
  /**
   * Stake this book would plausibly accept on one leg, in dollars. Used as
   * the assumed size, since the venue publishes none. Default $500.
   */
  assumed_stake_limit_dollars?: number;
  jurisdiction?: string;
  currency?: string;
}

export interface ImportDiagnostics extends ImportResult {
  files: string[];
  imported: number;
  scanned_at: string;
  /** Whether a house-rules file was found, and what it covers. */
  house_rules: {
    present: boolean;
    source_document: string;
    scopes: Record<string, number>;
  };
}

export class ManualCsvAdapter implements VenueAdapter {
  readonly venue: string;
  readonly display_name: string;
  readonly fee_model: FeeModel;
  readonly capabilities: AdapterCapabilities = {
    order_book_depth: false,
    // A sportsbook prices both outcomes independently with a margin on each,
    // so unlike a matched exchange book the two asks can genuinely both be
    // cheap. The complementary detector is therefore meaningful here.
    independent_two_sided_asks: true,
    settlement_rules_text: false,
    mutually_exclusive_groups: false,
    sports_market_types: ['MONEYLINE'],
  };

  private readonly context: NormalizeContext;
  private readonly options: ManualCsvAdapterOptions;
  private lastImport: ImportDiagnostics | null = null;
  /** Latest quote per market, so a paper trade can re-read the same snapshot. */
  private quotes = new Map<string, Quote>();

  constructor(options: ManualCsvAdapterOptions) {
    this.options = options;
    this.venue = options.venue;
    this.display_name = options.display_name;
    this.fee_model = new VigInPriceFeeModel(
      options.venue,
      'the margin is priced into the odds, so there is no separate commission',
    );
    this.context = {
      venue: options.venue,
      display_name: options.display_name,
      assumed_stake_limit: Math.round((options.assumed_stake_limit_dollars ?? 500) * 1000),
      jurisdiction: options.jurisdiction ?? 'US-STATE-LICENSED',
      currency: options.currency ?? 'USD',
    };
  }

  /** What the last import accepted, rejected and suspected. */
  get diagnostics(): ImportDiagnostics | null {
    return this.lastImport;
  }

  private files(): string[] {
    if (!existsSync(this.options.directory)) return [];
    if (!statSync(this.options.directory).isDirectory()) return [this.options.directory];
    return readdirSync(this.options.directory)
      .filter((name) => extname(name).toLowerCase() === '.csv')
      .sort()
      .map((name) => join(this.options.directory, name));
  }

  async fetchSnapshots(_options: FetchOptions = {}): Promise<EventSnapshot[]> {
    const files = this.files();
    const rawRows = files.flatMap((file) => {
      try {
        return parseCsv(readFileSync(file, 'utf8'));
      } catch {
        // One unreadable file must not lose the others.
        return [];
      }
    });

    const result = validateRows(rawRows, this.options);
    this.quotes = new Map();

    // Sportsbooks document settlement once, for a whole product, not per
    // market. Reload the file each cycle so editing it takes effect without a
    // restart.
    const houseRules: HouseRules | null = loadHouseRules(this.options.directory);
    const context: NormalizeContext = { ...this.context, house_rules: houseRules };
    const scopes: Record<string, number> = {};

    // Each captured row stands alone: nothing in the file establishes that a
    // group of rows is an exhaustive or mutually exclusive set, so they are
    // never bundled into a basket the engine could try to arb.
    const snapshots: EventSnapshot[] = [];
    for (const row of result.rows) {
      const market = toMarket(row, context);
      const quote = toQuote(row, market, context);
      const scope = market.provenance.settlement_rules_scope ?? 'NONE';
      scopes[scope] = (scopes[scope] ?? 0) + 1;
      this.quotes.set(market.market_id, quote);
      const marketSnapshot: MarketSnapshot = { market, quote };
      snapshots.push({ event: toEvent(row, market), markets: [marketSnapshot] });
    }

    this.lastImport = {
      ...result,
      files,
      imported: snapshots.length,
      scanned_at: new Date().toISOString(),
      house_rules: {
        present: houseRules !== null,
        source_document: houseRules?.source_document ?? '',
        scopes,
      },
    };
    return snapshots;
  }

  /**
   * There is nothing to re-fetch: the file is the snapshot. Returning the
   * captured quote unchanged is what makes a paper trade against this venue
   * honest — it reports zero decay *because nothing could be re-checked*,
   * which the trade's provenance warning says plainly.
   */
  async fetchQuotes(marketIds: string[]): Promise<Quote[]> {
    return marketIds
      .map((id) => this.quotes.get(id))
      .filter((quote): quote is Quote => quote !== undefined);
  }
}
