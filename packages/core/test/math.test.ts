import { describe, expect, it } from 'vitest';
import {
  americanToContractPrice,
  americanToDecimal,
  americanToImpliedProbability,
  consensusProbability,
  decimalToAmerican,
  decimalToContractPrice,
  devig,
  formatMoney,
  formatPrice,
  jointCapacity,
  overround,
  parseDecimalToDeciCents,
  reconstructAsks,
  roundHalfAway,
  vig,
  walkBook,
} from '@arbterminal/core';

describe('deci-cent arithmetic', () => {
  it('parses fixed-point strings without float drift', () => {
    expect(parseDecimalToDeciCents('0.8900')).toBe(890);
    expect(parseDecimalToDeciCents('0.0706')).toBe(71);
    expect(parseDecimalToDeciCents('1.0000')).toBe(1000);
    expect(parseDecimalToDeciCents('0.0010')).toBe(1);
    expect(parseDecimalToDeciCents('-0.2500')).toBe(-250);
    expect(parseDecimalToDeciCents('')).toBe(0);
  });

  it('rounds the fourth decimal rather than truncating it', () => {
    // 0.12345 dollars is 123.45 deci-cents, which rounds down to 123.
    expect(parseDecimalToDeciCents('0.12345')).toBe(123);
    expect(parseDecimalToDeciCents('0.12355')).toBe(124);
  });

  it('sums exactly where floating point would not', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; in deci-cents it is exact.
    const total = parseDecimalToDeciCents('0.10') + parseDecimalToDeciCents('0.20');
    expect(total).toBe(parseDecimalToDeciCents('0.30'));
  });

  it('formats prices to four decimals and money to two', () => {
    expect(formatPrice(890)).toBe('$0.8900');
    expect(formatPrice(1000)).toBe('$1.0000');
    expect(formatMoney(123456)).toBe('$123.46');
    expect(formatMoney(-500)).toBe('-$0.50');
  });

  it('rounds halves away from zero', () => {
    expect(roundHalfAway(0.5)).toBe(1);
    expect(roundHalfAway(-0.5)).toBe(-1);
    expect(roundHalfAway(2.4)).toBe(2);
  });
});

describe('order book reconstruction', () => {
  it('derives the YES ask ladder from resting NO bids', () => {
    // A resting NO bid at 0.89 is an offer to sell YES at 0.11.
    const asks = reconstructAsks([
      { price: 890, size: 165.2 },
      { price: 870, size: 1907.44 },
      { price: 780, size: 264.32 },
    ]);
    expect(asks).toEqual([
      { price: 110, size: 165.2 },
      { price: 130, size: 1907.44 },
      { price: 220, size: 264.32 },
    ]);
  });

  it('drops levels that cannot be executed', () => {
    expect(reconstructAsks([{ price: 500, size: 0 }])).toEqual([]);
    expect(reconstructAsks([{ price: 1000, size: 10 }])).toEqual([]);
    expect(reconstructAsks([{ price: 0, size: 10 }])).toEqual([]);
  });
});

describe('book walking', () => {
  const ladder = [
    { price: 100, size: 10 },
    { price: 120, size: 20 },
    { price: 150, size: 30 },
  ];

  it('fills entirely at the top level when size allows', () => {
    const walk = walkBook(ladder, 10);
    expect(walk.filled).toBe(10);
    expect(walk.vwap).toBe(100);
    expect(walk.slippage_per_contract).toBe(0);
    expect(walk.depth_exhausted).toBe(false);
  });

  it('computes a volume-weighted average across levels', () => {
    // 10 @ 100 + 20 @ 120 = 3400 over 30 contracts.
    const walk = walkBook(ladder, 30);
    expect(walk.cost).toBe(3400);
    expect(walk.vwap).toBeCloseTo(113.333, 3);
    expect(walk.slippage_per_contract).toBeCloseTo(13.333, 3);
  });

  it('reports exhaustion rather than inventing liquidity', () => {
    const walk = walkBook(ladder, 100);
    expect(walk.filled).toBe(60);
    expect(walk.depth_exhausted).toBe(true);
  });

  it('handles an empty ladder', () => {
    const walk = walkBook([], 5);
    expect(walk.filled).toBe(0);
    expect(walk.top_price).toBeNull();
    expect(walk.depth_exhausted).toBe(true);
  });

  it('caps joint capacity at the thinnest ladder', () => {
    expect(jointCapacity([ladder, [{ price: 300, size: 7 }]])).toBe(7);
  });
});

describe('odds conversion', () => {
  it('converts American to decimal in both directions', () => {
    expect(americanToDecimal(150)).toBeCloseTo(2.5, 10);
    expect(americanToDecimal(-200)).toBeCloseTo(1.5, 10);
    expect(decimalToAmerican(2.5)).toBeCloseTo(150, 10);
    expect(decimalToAmerican(1.5)).toBeCloseTo(-200, 10);
  });

  it('rejects impossible odds', () => {
    expect(() => americanToDecimal(0)).toThrow(RangeError);
    expect(() => decimalToContractPrice(1)).toThrow(RangeError);
  });

  it('restates sportsbook odds as the cost of $1 of payout', () => {
    // -110 implies 0.5238; an event contract at 52.38c is the same price.
    expect(americanToImpliedProbability(-110)).toBeCloseTo(0.5238, 4);
    expect(americanToContractPrice(-110)).toBe(524);
    expect(decimalToContractPrice(2)).toBe(500);
  });

  it('measures the book margin', () => {
    const probs = [americanToImpliedProbability(-110), americanToImpliedProbability(-110)];
    expect(overround(probs)).toBeCloseTo(1.0476, 4);
    expect(vig(probs)).toBeCloseTo(0.0476, 4);
  });

  it('de-vigs to probabilities that sum to one', () => {
    const probs = [0.55, 0.5];
    for (const method of ['MULTIPLICATIVE', 'ADDITIVE', 'POWER'] as const) {
      const fair = devig(probs, method);
      expect(fair.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      // De-vigging must preserve the ordering of the outcomes.
      expect(fair[0]).toBeGreaterThan(fair[1]!);
    }
  });

  it('weights consensus toward the tighter market', () => {
    const consensus = consensusProbability([
      { probability: 0.4, spread: 1 },
      { probability: 0.6, spread: 200 },
    ]);
    // The tight quote dominates, so consensus sits near 0.4, not at 0.5.
    expect(consensus).toBeLessThan(0.45);
    expect(consensusProbability([])).toBeNull();
  });
});
