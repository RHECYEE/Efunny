import type { EventSnapshot, FeeModel, Quote } from '@arbterminal/core';

/**
 * The venue adapter contract.
 *
 * This is the *only* seam between a venue and the rest of the system. An
 * adapter converts a venue's wire format into normalized `Event` / `Market` /
 * `Quote` objects and declares that venue's fee schedule. The matching engine
 * and the arb engine never learn a venue's name, so adding a venue means
 * writing one of these and registering it — nothing downstream changes.
 */

export interface AdapterCapabilities {
  /** Venue publishes a full depth ladder, not just top of book. */
  order_book_depth: boolean;
  /** Both sides quote independently, so a single-market complementary arb is possible. */
  independent_two_sided_asks: boolean;
  /** Venue exposes settlement rule text per market. */
  settlement_rules_text: boolean;
  /** Venue flags mutually exclusive outcome groups. */
  mutually_exclusive_groups: boolean;
  /** Sports market tiers this adapter is allowed to emit. */
  sports_market_types: string[];
}

export interface FetchOptions {
  /** Cap on markets pulled per cycle. Adapters must respect it. */
  limit?: number;
  /** Only fetch events in these categories, if the venue supports it. */
  categories?: string[];
  /** Fetch depth ladders as well as top of book. Costs extra requests. */
  with_depth?: boolean;
  signal?: AbortSignal;
}

export interface VenueAdapter {
  /** Stable machine identifier used as `Market.venue`. */
  readonly venue: string;
  readonly display_name: string;
  readonly capabilities: AdapterCapabilities;
  /** This venue's fee schedule, supplied as data to the engine. */
  readonly fee_model: FeeModel;

  /** Normalized events, markets and quotes for the current cycle. */
  fetchSnapshots(options?: FetchOptions): Promise<EventSnapshot[]>;

  /**
   * Re-fetch quotes for specific markets. Used by paper trading to price a
   * fill against a *fresh* book rather than the one on the card.
   */
  fetchQuotes(marketIds: string[], options?: FetchOptions): Promise<Quote[]>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, VenueAdapter>();

  register(adapter: VenueAdapter): this {
    this.adapters.set(adapter.venue, adapter);
    return this;
  }

  get(venue: string): VenueAdapter | undefined {
    return this.adapters.get(venue);
  }

  all(): VenueAdapter[] {
    return [...this.adapters.values()];
  }

  venues(): string[] {
    return [...this.adapters.keys()].sort();
  }
}
