import { describe, expect, it } from 'vitest';
import {
  buildFightCards,
  classifyDiscipline,
  classifyStyle,
  isStyleClash,
  nameKey,
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
