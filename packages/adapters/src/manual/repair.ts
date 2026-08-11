import type { CsvRow } from './csv.js';

/**
 * Validation and repair of manually captured price rows.
 *
 * These files are transcribed from a screen, so they arrive with damage an
 * API response never has: `$100k` read as `$1OOk`, a market name lost
 * entirely, an odds value landing in the outcome column. The rules here are
 * deliberately narrow — repair only what can be fixed deterministically, and
 * reject anything whose meaning would have to be guessed.
 *
 * Nothing here is silent. Every repair travels with the record as provenance,
 * and every rejection is reported with its reason.
 */

export interface RepairOptions {
  /**
   * A repaired *market name* seen this many times or fewer is rejected rather
   * than imported. One sighting of a mangled name is unverifiable: `$100Ok`
   * could be `$100k` with a stray character or `$1000k` with a missing one,
   * and the digit substitution alone cannot tell them apart.
   */
  min_observations_for_repaired_name?: number;
}

export interface RejectedRow {
  row: CsvRow;
  reason: string;
}

export interface ValidRow {
  /** Market name after repair. */
  market: string;
  /** Market name exactly as the file had it, before any repair. */
  raw_market: string;
  outcome: string;
  /** American odds. */
  yes_odds: number;
  no_odds: number | null;
  section: string;
  captured_at: string;
  observations: number;
  source: string;
  repairs: string[];
  /** Optional settlement columns. Empty when the capture omits them. */
  settlement_source: string;
  settlement_rules: string;
  void_rules: string;
}

export interface ImportResult {
  rows: ValidRow[];
  rejected: RejectedRow[];
  /**
   * Distinct spellings in the file that resolve to one market. Reported so a
   * capture producing four readings of the same row is visible and fixable —
   * repair alone would hide it by quietly normalising them all to the same
   * string.
   */
  suspected_duplicates: Array<{ market: string; raw_variants: string[] }>;
}

/**
 * Replace the letter O with a zero, but only inside a token that is already
 * a currency amount — `$1OOk` becomes `$100k`. Restricting it to `$`-prefixed
 * alphanumeric runs keeps it from mangling ordinary words.
 */
const CURRENCY_TOKEN = /\$[0-9OoIl,.]+k?\b/gi;

export function repairCurrencyTokens(text: string): { text: string; repaired: boolean } {
  let repaired = false;
  const out = text.replace(CURRENCY_TOKEN, (token) => {
    const fixed = token
      .replace(/[Oo]/g, '0')
      // A capital I or lowercase l in a numeric run is a 1.
      .replace(/[Il](?=[0-9,.])|(?<=[0-9,.])[Il]/g, '1');
    if (fixed !== token) repaired = true;
    return fixed;
  });
  return { text: out, repaired };
}

/** American odds, e.g. `+400`, `-1011`. `LOCKED` and blanks are not odds. */
export function parseAmericanOdds(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || /locked|susp|n\/?a/i.test(trimmed)) return null;
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  // American odds are never between -100 and +100 exclusive of the extremes.
  if (!Number.isFinite(value) || value === 0 || Math.abs(value) < 100) return null;
  return value;
}

/** An outcome cell that is really an odds value means the columns shifted. */
function looksLikeOdds(text: string): boolean {
  return /^[+-]\d{3,}$/.test(text.trim());
}

export function validateRows(rows: CsvRow[], options: RepairOptions = {}): ImportResult {
  const minObservations = options.min_observations_for_repaired_name ?? 2;
  const valid: ValidRow[] = [];
  const rejected: RejectedRow[] = [];

  for (const row of rows) {
    const rawMarket = (row.market ?? '').trim();
    const outcome = (row.outcome ?? '').trim();

    if (rawMarket === '') {
      rejected.push({ row, reason: 'no market name — the row cannot be identified' });
      continue;
    }
    if (outcome === '') {
      rejected.push({ row, reason: 'no outcome' });
      continue;
    }
    if (looksLikeOdds(outcome)) {
      rejected.push({
        row,
        reason: `outcome "${outcome}" is an odds value, so the columns are misaligned`,
      });
      continue;
    }

    const yesOdds = parseAmericanOdds(row.yes_odds ?? '');
    if (yesOdds === null) {
      rejected.push({
        row,
        reason: `yes odds "${row.yes_odds ?? ''}" are not tradeable American odds`,
      });
      continue;
    }
    const noOdds = parseAmericanOdds(row.no_odds ?? '');

    const repairs: string[] = [];
    const marketRepair = repairCurrencyTokens(rawMarket);
    const outcomeRepair = repairCurrencyTokens(outcome);
    const observations = Number(row.observations ?? '0') || 0;

    if (marketRepair.repaired) {
      if (observations < minObservations) {
        rejected.push({
          row,
          reason:
            `market name "${rawMarket}" needed a character repair but was seen only ` +
            `${observations} time(s); the correction cannot be verified`,
        });
        continue;
      }
      repairs.push(`market name "${rawMarket}" read as "${marketRepair.text}"`);
    }
    if (outcomeRepair.repaired) {
      repairs.push(`outcome "${outcome}" read as "${outcomeRepair.text}"`);
    }
    if (noOdds === null) {
      repairs.push(`no side unavailable ("${(row.no_odds ?? '').trim()}"), only YES is priced`);
    }
    if (observations <= 1) {
      repairs.push('captured from a single observation');
    }

    valid.push({
      market: marketRepair.text,
      raw_market: rawMarket,
      outcome: outcomeRepair.text,
      yes_odds: yesOdds,
      no_odds: noOdds,
      section: (row.section ?? '').trim(),
      captured_at: (row.captured_at ?? '').trim(),
      observations,
      source: (row.source ?? '').trim(),
      repairs,
      settlement_source: (row.settlement_source ?? '').trim(),
      settlement_rules: (row.settlement_rules ?? row.rules ?? '').trim(),
      void_rules: (row.void_rules ?? '').trim(),
    });
  }

  // Duplicate detection runs over everything, including rejects: the whole
  // point is to show that four differently-mangled names were one market, and
  // three of those four were the rows that got rejected.
  const everything: ValidRow[] = [
    ...valid,
    ...rejected
      .filter((r) => (r.row.market ?? '').trim() !== '')
      .map((r) => ({
        market: repairCurrencyTokens((r.row.market ?? '').trim()).text,
        raw_market: (r.row.market ?? '').trim(),
        outcome: (r.row.outcome ?? '').trim(),
        yes_odds: parseAmericanOdds(r.row.yes_odds ?? '') ?? 0,
        no_odds: parseAmericanOdds(r.row.no_odds ?? ''),
        section: '',
        captured_at: '',
        observations: 0,
        source: '',
        repairs: [],
        settlement_source: '',
        settlement_rules: '',
        void_rules: '',
      })),
  ];

  return { rows: valid, rejected, suspected_duplicates: findDuplicates(everything) };
}

/**
 * Find markets the file spelled more than one way.
 *
 * Grouping is on the *repaired* name, so the report answers the question that
 * matters to whoever produced the capture: which raw readings turned out to
 * be the same row. Nothing is merged on the strength of it — this is a
 * diagnostic, and the rows themselves were already accepted or rejected on
 * their own evidence.
 */
function findDuplicates(rows: ValidRow[]): ImportResult['suspected_duplicates'] {
  const groups = new Map<string, Set<string>>();
  for (const row of rows) {
    const bucket = groups.get(row.market);
    if (bucket) bucket.add(row.raw_market);
    else groups.set(row.market, new Set([row.raw_market]));
  }

  return [...groups.entries()]
    .filter(([, variants]) => variants.size > 1)
    .map(([market, variants]) => ({ market, raw_variants: [...variants].sort() }));
}
