import type { SettlementSpec } from '@arbterminal/core';

/**
 * House rules for a manually captured venue.
 *
 * Sportsbooks do not publish settlement terms per market. They publish one
 * House Rules document covering a whole product or sport, and the market card
 * in the app carries none of it. Asking for per-market rules in the capture
 * asks for something that does not exist.
 *
 * So the rules are supplied once, in a file, at whatever granularity the venue
 * actually documents them — the whole venue, a section of the board, or a
 * named market when the venue happens to be that specific. Which scope a rule
 * came from is recorded, because "this venue settles crypto on Coinbase spot"
 * is a weaker claim about one market than a rule written for that market.
 */

export type RulesScope = 'MARKET' | 'SECTION' | 'VENUE' | 'NONE';

export interface RulesEntry {
  settlement_source?: string;
  settlement_rules?: string;
  void_rules?: string;
  overtime_rules?: string;
}

export interface HouseRules {
  /** Where the text was transcribed from, shown as provenance. */
  source_document?: string;
  /** Applies to every market from this venue. */
  venue?: RulesEntry;
  /** Keyed by the `section` column in the capture. */
  sections?: Record<string, RulesEntry>;
  /** Keyed by exact market name, for venues that document individual markets. */
  markets?: Record<string, RulesEntry>;
}

export interface ResolvedRules {
  settlement: SettlementSpec;
  scope: RulesScope;
  source_document: string;
}

export const RULES_FILENAME = 'rules.json';

/**
 * Parse a rules document. Kept separate from reading it off a disk so the
 * same logic runs on a phone, where there is no filesystem to read from and
 * the text arrives from a file picker or a text box instead.
 */
export function parseHouseRules(text: string): HouseRules | null {
  try {
    return JSON.parse(text) as HouseRules;
  } catch {
    // A malformed rules file must not take the price import down with it; the
    // markets simply carry no settlement text, which the differ already
    // reports as a material gap.
    return null;
  }
}

function toSpec(entry: RulesEntry): SettlementSpec {
  return {
    settlement_source: entry.settlement_source ?? '',
    settlement_rules_text: entry.settlement_rules ?? '',
    void_rules: entry.void_rules ?? '',
    overtime_rules: entry.overtime_rules ?? '',
  };
}

/**
 * Most specific rule wins. A per-row value from the capture beats the file
 * entirely — if the venue did surface rules on a particular market and they
 * were transcribed, that is better evidence than any house-wide default.
 */
export function resolveRules(
  rules: HouseRules | null,
  row: { market: string; section: string; settlement_source: string; settlement_rules: string; void_rules: string },
): ResolvedRules {
  const fromRow =
    row.settlement_source || row.settlement_rules || row.void_rules
      ? {
          settlement: {
            settlement_source: row.settlement_source,
            settlement_rules_text: row.settlement_rules,
            void_rules: row.void_rules,
            overtime_rules: '',
          },
          scope: 'MARKET' as RulesScope,
          source_document: 'captured with the row',
        }
      : null;
  if (fromRow) return fromRow;

  const document = rules?.source_document ?? 'house rules file';

  const named = rules?.markets?.[row.market];
  if (named) return { settlement: toSpec(named), scope: 'MARKET', source_document: document };

  const section = row.section ? rules?.sections?.[row.section] : undefined;
  if (section) return { settlement: toSpec(section), scope: 'SECTION', source_document: document };

  if (rules?.venue) {
    return { settlement: toSpec(rules.venue), scope: 'VENUE', source_document: document };
  }

  return {
    settlement: {
      settlement_source: '',
      settlement_rules_text: '',
      void_rules: '',
      overtime_rules: '',
    },
    scope: 'NONE',
    source_document: '',
  };
}

/**
 * Confidence ceiling implied by how specifically the rule was written.
 *
 * A rule transcribed for this exact market says what this market does. A
 * venue-wide rule only says what the venue usually does, and applying it to a
 * particular contract is an inference. Neither is a reason to reject a match,
 * but the broader ones cannot support the top confidence band.
 */
export function ceilingForScope(scope: RulesScope): number {
  switch (scope) {
    case 'MARKET':
      return 0.97;
    case 'SECTION':
      return 0.95;
    case 'VENUE':
      return 0.92;
    case 'NONE':
      // No ceiling of its own — the settlement differ already charges heavily
      // for undocumented rules, and double-counting would hide why.
      return 0.97;
  }
}

export function describeScope(scope: RulesScope, document: string): string {
  switch (scope) {
    case 'MARKET':
      return `settlement rules written for this market (${document})`;
    case 'SECTION':
      return `settlement rules for this section of the board (${document})`;
    case 'VENUE':
      return `venue-wide house rules applied to this market (${document})`;
    case 'NONE':
      return 'no settlement rules available for this venue';
  }
}
