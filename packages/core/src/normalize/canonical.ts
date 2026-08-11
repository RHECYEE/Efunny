/**
 * Canonicalization: turning venue wording into stable identifiers.
 *
 *   Venue A: "Will Candidate A win the 2028 election?"
 *   Venue B: "Candidate A - Presidential Election Winner"
 *   -> event=US_PRESIDENT_2028, outcome=CANDIDATE_A_WINS
 *
 * This file is pure string work and knows nothing about any specific venue.
 * Adapters supply the raw text; the matcher consumes the canonical form.
 */

const NOISE_WORDS = new Set([
  'will',
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'to',
  'be',
  'is',
  'are',
  'for',
  'by',
  'and',
  'or',
  'do',
  'does',
  'this',
  'that',
  'which',
  'who',
  'whom',
  'what',
  'when',
]);

/** Words that carry no identity but do carry *meaning* for settlement text. */
const SETTLEMENT_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'be']);

export function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Lowercased, punctuation-stripped tokens with noise words removed. */
export function contentTokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NOISE_WORDS.has(t));
}

export function settlementTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%.$-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SETTLEMENT_STOPWORDS.has(t));
}

/** Jaccard similarity over token sets. 0..1, symmetric, deterministic. */
export function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Normalized Levenshtein similarity. Used only as a tie-breaker on short
 * strings (participant names), where token overlap is too coarse.
 */
export function stringSimilarity(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 1;
  if (s.length === 0 || t.length === 0) return 0;

  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  let curr = new Array<number>(t.length + 1);

  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[t.length]! / Math.max(s.length, t.length);
}

const YEAR_PATTERN = /\b(19|20)\d{2}\b/g;

/** Years are identity-bearing: a 2028 election is not a 2024 election. */
export function extractYears(text: string): string[] {
  return [...new Set(text.match(YEAR_PATTERN) ?? [])].sort();
}

/**
 * Numbers embedded in market text (lines, thresholds, strike prices). A
 * mismatch here is disqualifying, never merely a confidence penalty.
 */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return matches.map(Number).filter(Number.isFinite);
}

export function canonicalOutcomeId(outcomeLabel: string, suffix = 'WINS'): string {
  const base = slug(outcomeLabel);
  return base.length > 0 ? `${base}_${suffix}` : `UNKNOWN_${suffix}`;
}

export function canonicalEventId(parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined && p !== '')
    .map((p) => slug(String(p)))
    .filter((p) => p.length > 0)
    .join('__');
}
