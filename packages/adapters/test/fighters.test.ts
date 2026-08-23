import { describe, expect, it } from 'vitest';
import {
  buildFightCards,
  classifyDiscipline,
  classifyStyle,
  isStyleClash,
  nameKey,
  parseCareerStats,
  parseFightRow,
  type Fighter,
} from '../src/index.js';
import { venueApiProvenance, type Market, type Quote } from '@arbterminal/core';

describe('fighter name keys', () => {
  it('survives the venues disagreeing about word order', () => {
    // Kalshi lists "Yadong Song"; Polymarket lists "Song Yadong".
    expect(nameKey('Song Yadong')).toBe(nameKey('Yadong Song'));
  });

  it('survives accents', () => {
    expect(nameKey('André Lima')).toBe(nameKey('Andre Lima'));
    expect(nameKey('Morgan Charrière')).toBe(nameKey('Morgan Charriere'));
  });

  it('does not merge two different people', () => {
    expect(nameKey('Sean Woodson')).not.toBe(nameKey('Jack Jenkins'));
  });
});

describe('style classification', () => {
  it('reads the promotion vocabulary', () => {
    expect(classifyStyle('Brazilian Jiu-Jitsu')).toBe('GRAPPLER');
    expect(classifyStyle('Muay Thai')).toBe('STRIKER');
  });

  it('refuses to read anything into the empty labels', () => {
    // Roughly half the roster is filed as "MMA" or "Freestyle". Forcing
    // those into a bucket would invent the read the tab exists to surface.
    expect(classifyStyle('MMA')).toBe('UNKNOWN');
    expect(classifyStyle('Freestyle')).toBe('UNKNOWN');
    expect(classifyStyle('')).toBe('UNKNOWN');
  });

  it('does not mistake professional wrestling for grappling', () => {
    // "Professional wrestler" is WWE, not amateur wrestling.
    expect(classifyDiscipline('professional wrestler')).toBe('UNKNOWN');
    expect(classifyDiscipline('sport wrestler')).toBe('GRAPPLER');
    expect(classifyDiscipline('judoka')).toBe('GRAPPLER');
    expect(classifyDiscipline('kickboxer')).toBe('STRIKER');
  });
});

describe('style clash', () => {
  const f = (cls: Fighter['style_class']): Fighter => ({
    name: 'x', key: 'x', nationality: null, nationality_source: null,
    style_label: null, style_source: null, style_class: cls, nickname: null, record: null,
  });

  it('needs both fighters classified', () => {
    expect(isStyleClash(f('GRAPPLER'), f('STRIKER'))).toBe(true);
    // One known and one unknown is not a matchup, it is a missing bio.
    expect(isStyleClash(f('GRAPPLER'), f('UNKNOWN'))).toBe(false);
    expect(isStyleClash(f('GRAPPLER'), null)).toBe(false);
    expect(isStyleClash(f('STRIKER'), f('STRIKER'))).toBe(false);
  });
});

describe('fight cards', () => {
  const mk = (venue: string, label: string, complement: string | null, ask: number): {
    market: Market;
    quote: Quote;
  } => {
    const market: Market = {
      market_id: `${venue}:${label}`,
      event_id: `E_${venue}`,
      venue,
      venue_market_id: label,
      outcome: label.toUpperCase().replace(/\s+/g, '_'),
      outcome_label: label,
      complement_label: complement,
      market_type: 'MONEYLINE',
      tier: 'GAME',
      line: null,
      comparison_operator: 'NONE',
      threshold: null,
      settlement: { settlement_source: 'ufc.com', settlement_rules_text: '', void_rules: '', overtime_rules: '' },
      jurisdiction: 'US-CFTC',
      currency: 'USD',
      match_confidence: 0,
      title: 'card',
      status: 'OPEN',
      close_time: '2026-08-30T00:00:00Z',
      payout_per_contract: 1000,
      provenance: venueApiProvenance(venue),
    };
    const book = {
      yes_asks: [{ price: ask, size: 100 }],
      no_asks: [{ price: 1000 - ask, size: 100 }],
      yes_bids: [],
      no_bids: [],
    };
    return {
      market,
      quote: {
        quote_id: `q${venue}${label}`, market_id: market.market_id,
        bid: null, ask, no_bid: null, no_ask: 1000 - ask,
        implied_probability: ask / 1000, liquidity: 100, book,
        timestamp: '2026-08-23T00:00:00Z',
      },
    };
  };

  it('joins the two venues onto one fight', () => {
    // Polymarket names both sides on one market; Kalshi lists each fighter
    // separately. The grouping key is the unordered pair, not either
    // venue's idea of an event.
    const cards = buildFightCards(
      [
        mk('polymarket', 'Song Yadong', 'Umar Nurmagomedov', 210),
        mk('kalshi', 'Yadong Song', null, 230),
      ],
      new Map(),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.venues).toEqual(['kalshi', 'polymarket']);
    expect(cards[0]!.divergence).toBe(20);
  });

  it('does not invent a fight from a one-sided listing alone', () => {
    const cards = buildFightCards([mk('kalshi', 'Yadong Song', null, 230)], new Map());
    expect(cards).toHaveLength(0);
  });
});

describe('UFCStats parsing', () => {
  // The career box exactly as the rendered page lays it out.
  const page = [
    "HEIGHT: 5' 10\"",
    'WEIGHT: 155 lbs.',
    'REACH: 74"',
    'STANCE: Orthodox',
    'DOB: Oct 17, 1989',
    'CAREER STATISTICS:',
    'SLpM: 3.23',
    'Str. Acc.: 55%',
    'SApM: 3.05',
    'Str. Def: 48%',
    'TD Avg.: 2.29',
    'TD Acc.: 39%',
    'TD Def.: 54%',
    'Sub. Avg.: 2.6',
    'SLpM - Significant Strikes Landed per Minute',
  ].join('\n');

  it('reads every statistic, including the ones with dots in the label', () => {
    // Pre-escaping the labels double-escaped them, so every field containing
    // a full stop silently parsed as null and a fighter looked like he had
    // no takedown record at all.
    const s = parseCareerStats(page);
    expect(s.slpm).toBe(3.23);
    expect(s.td_per15).toBe(2.29);
    expect(s.td_accuracy).toBeCloseTo(0.39, 5);
    expect(s.td_defence).toBeCloseTo(0.54, 5);
    expect(s.sub_per15).toBe(2.6);
    expect(s.strike_defence).toBeCloseTo(0.48, 5);
    expect(s.height_inches).toBe(70);
    expect(s.reach_inches).toBe(74);
  });

  it('splits a fight row into both fighters\' numbers', () => {
    const row = parseFightRow(
      ['WIN', 'Charles Oliveira Max Holloway', '0 0', '50 26', '5 0', '4 0',
       'UFC 326 Mar. 07, 2026', 'U-DEC', '5', '5:00'],
      'Charles Oliveira',
    );
    expect(row?.opponent).toBe('Max Holloway');
    expect(row?.takedowns).toEqual([5, 0]);
    expect(row?.submission_attempts).toEqual([4, 0]);
    expect(row?.result).toBe('WIN');
  });
});
