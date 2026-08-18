import { describe, expect, it } from 'vitest';
import {
  interpretManualRow,
  manualToBook,
  manualToMarket,
  manualToQuote,
  parseAmericanOdds,
  parseCsv,
  parseManualDeadline,
  repairCurrencyTokens,
  validateRows,
  type ManualNormalizeContext,
} from '@arbterminal/adapters';
import { verifyMatch, venueApiProvenance, type Market } from '@arbterminal/core';

const context: ManualNormalizeContext = {
  venue: 'draftkings',
  display_name: 'DraftKings',
  assumed_stake_limit: 500_000,
  jurisdiction: 'US-CFTC',
  currency: 'USD',
};

function row(overrides: Partial<Parameters<typeof manualToMarket>[0]> = {}) {
  return {
    market: 'When will Bitcoin cross $100k again?',
    outcome: 'Before January 2027',
    yes_odds: 400,
    no_odds: -1011,
    section: 'Bitcoin',
    captured_at: '2026-08-11T21:50:57Z',
    observations: 2,
    source: 'capture',
    raw_market: 'When will Bitcoin cross $100k again?',
    repairs: [] as string[],
    settlement_source: '',
    settlement_rules: '',
    void_rules: '',
    ...overrides,
  };
}

describe('CSV parsing', () => {
  it('keeps commas inside quoted fields', () => {
    // Every price bucket looks like "65,000 to 69,999.99"; splitting on
    // commas shreds them silently.
    const rows = parseCsv('market,outcome\n"Bitcoin Price","65,000 to 69,999.99"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('65,000 to 69,999.99');
  });

  it('handles doubled quotes and CRLF', () => {
    const rows = parseCsv('a,b\r\n"say ""hi""",2\r\n');
    expect(rows[0]!.a).toBe('say "hi"');
    expect(rows[0]!.b).toBe('2');
  });
});

describe('odds parsing', () => {
  it('accepts American odds and rejects everything else', () => {
    expect(parseAmericanOdds('+400')).toBe(400);
    expect(parseAmericanOdds('-1011')).toBe(-1011);
    expect(parseAmericanOdds('LOCKED')).toBeNull();
    expect(parseAmericanOdds('')).toBeNull();
    // Nothing between -100 and +100 is a real American price.
    expect(parseAmericanOdds('+50')).toBeNull();
  });
});

describe('OCR repair', () => {
  it('substitutes letters for digits only inside currency tokens', () => {
    expect(repairCurrencyTokens('cross $1OOk again').text).toBe('cross $100k again');
    expect(repairCurrencyTokens('cross $10Ok again').text).toBe('cross $100k again');
    // An ordinary word containing O must survive untouched.
    expect(repairCurrencyTokens('Ohio October').repaired).toBe(false);
  });
});

describe('row validation', () => {
  const base = {
    market: 'When will Bitcoin cross $100k again?',
    outcome: 'Before January 2027',
    yes_odds: '+400',
    no_odds: '-1011',
    observations: '4',
    captured_at: '2026-08-11T21:50:57Z',
  };

  it('accepts a clean row untouched', () => {
    const result = validateRows([base]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.repairs).toEqual([]);
  });

  it('rejects a row with no market name', () => {
    const result = validateRows([{ ...base, market: '' }]);
    expect(result.rows).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain('no market name');
  });

  it('rejects a row whose outcome is an odds value', () => {
    // A shifted column is how "+809" ends up where an outcome belongs.
    const result = validateRows([{ ...base, outcome: '+809' }]);
    expect(result.rejected[0]!.reason).toContain('columns are misaligned');
  });

  it('rejects a locked price rather than importing an untradeable quote', () => {
    const result = validateRows([{ ...base, yes_odds: 'LOCKED' }]);
    expect(result.rejected[0]!.reason).toContain('not tradeable');
  });

  it('rejects a repaired market name that was only seen once', () => {
    // "$100Ok" could be $100k with a stray character or $1000k with a missing
    // one. A single sighting cannot settle which, so it is not imported.
    const result = validateRows([
      { ...base, market: 'When will Bitcoin cross $100Ok again?', observations: '1' },
    ]);
    expect(result.rows).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain('cannot be verified');
  });

  it('imports a repaired name that was corroborated, and records the repair', () => {
    const result = validateRows([
      { ...base, market: 'When will Bitcoin cross $1OOk again?', observations: '4' },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.market).toBe('When will Bitcoin cross $100k again?');
    expect(result.rows[0]!.repairs[0]).toContain('read as');
  });

  it('reports the raw spellings that collapsed into one market', () => {
    const result = validateRows([
      base,
      { ...base, market: 'When will Bitcoin cross $1OOk again?', observations: '1' },
      { ...base, market: 'When will Bitcoin cross $10Ok again?', observations: '1' },
    ]);

    // Only the clean row is imported; the two mangled twins are rejected as
    // unverifiable. The duplication is still surfaced, because repair would
    // otherwise hide it by normalising all three to the same string.
    expect(result.rows).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.suspected_duplicates).toHaveLength(1);
    expect(result.suspected_duplicates[0]!.market).toBe('When will Bitcoin cross $100k again?');
    expect(result.suspected_duplicates[0]!.raw_variants).toEqual([
      'When will Bitcoin cross $100k again?',
      'When will Bitcoin cross $10Ok again?',
      'When will Bitcoin cross $1OOk again?',
    ]);
  });
});

describe('interpretation', () => {
  it('reads a price range as a bounded comparison', () => {
    const reading = interpretManualRow(row({ outcome: '65,000 to 69,999.99' }));
    expect(reading.operator).toBe('BETWEEN');
    expect(reading.threshold).toBe(65_000);
    expect(reading.line).toBe(69_999.99);
  });

  it('reads a crossing market as a threshold', () => {
    const reading = interpretManualRow(row());
    expect(reading.operator).toBe('GT');
    expect(reading.threshold).toBe(100_000);
  });

  it('leaves an unrecognised market with no threshold at all', () => {
    // A market with no parsed threshold can only ever match another with no
    // threshold, so a failed parse can never be equated with a real line.
    const reading = interpretManualRow(row({ market: 'Something unparseable', outcome: 'Yes' }));
    expect(reading.operator).toBe('NONE');
    expect(reading.threshold).toBeNull();
  });

  it('parses deadlines', () => {
    expect(parseManualDeadline('Before January 2027')).toBe('2027-01-01T00:00:00.000Z');
    expect(parseManualDeadline('December 31, 2026')).toBe('2026-12-31T23:59:59.000Z');
    expect(parseManualDeadline('no date here')).toBeNull();
  });
});

describe('normalization', () => {
  it('converts American odds to a cost per $1 of payout', () => {
    const quote = manualToQuote(row(), manualToMarket(row(), context), context);
    // +400 is decimal 5.0, so $1 of payout costs 20c.
    expect(quote.ask).toBe(200);
    // -1011 is decimal 1.0989, so the NO side costs 91c.
    expect(quote.no_ask).toBe(910);
  });

  it('de-vigs the two-sided price into a probability', () => {
    const quote = manualToQuote(row(), manualToMarket(row(), context), context);
    // 20c and 91c overround to 1.11; stripping it leaves about 18%.
    expect(quote.implied_probability).toBeCloseTo(0.1802, 4);
  });

  it('quotes no bid, because a sportsbook does not buy back', () => {
    const quote = manualToQuote(row(), manualToMarket(row(), context), context);
    expect(quote.bid).toBeNull();
    expect(quote.book.yes_bids).toEqual([]);
  });

  it('sizes the single book level from the assumed stake limit', () => {
    const book = manualToBook(row(), context);
    expect(book.yes_asks).toHaveLength(1);
    // $500 at 20c a contract buys 2500 of them.
    expect(book.yes_asks[0]!.size).toBeCloseTo(2500, 6);
  });

  it('records that no depth was observed', () => {
    const market = manualToMarket(row(), context);
    expect(market.provenance.source).toBe('MANUAL_IMPORT');
    expect(market.provenance.depth_observed).toBe(false);
    expect(market.provenance.confidence_ceiling).toBeLessThan(1);
  });

  it('caps a repaired record inside the manual-review band', () => {
    const market = manualToMarket(row({ repairs: ['market name repaired'] }), context);
    expect(market.provenance.repaired).toBe(true);
    expect(market.provenance.confidence_ceiling).toBe(0.94);
  });

  it('leaves settlement fields empty rather than inventing them', () => {
    // Writing the board section here would look like documentation while
    // diffing badly against the other venue's real rules.
    const market = manualToMarket(row(), context);
    expect(market.settlement.settlement_rules_text).toBe('');
    expect(market.settlement.settlement_source).toBe('');
  });
});

describe('cross-venue matching against an exchange', () => {
  const kalshiRules =
    'If the Bitcoin spot price according to the CF Bitcoin Real-Time Index is above ' +
    '$99999.99 starting 01/02/2026 06:00 PM and before Dec 31, 2026 at 11:59 PM ET, then ' +
    'the market resolves to Yes.';

  const kalshi: Market = {
    market_id: 'kalshi:KXBTCMAXY-26DEC31-99999.99',
    event_id: 'HOW_HIGH_WILL_BITCOIN_GET_IN_2026__2026',
    venue: 'kalshi',
    venue_market_id: 'KXBTCMAXY-26DEC31-99999.99',
    outcome: 'ABOVE_99_999_99_WINS',
    outcome_label: 'Above $99,999.99',
    market_type: 'SCALAR_THRESHOLD',
    tier: 'NON_SPORT',
    line: null,
    comparison_operator: 'GT',
    threshold: 99_999.99,
    settlement: {
      settlement_source: 'CF Bitcoin Real-Time Index',
      settlement_rules_text: kalshiRules,
      void_rules: '',
      overtime_rules: '',
    },
    jurisdiction: 'US-CFTC',
    currency: 'USD',
    match_confidence: 0,
    title: 'How high will Bitcoin get in 2026?',
    status: 'OPEN',
    close_time: '2027-01-01T04:59:00Z',
    payout_per_contract: 1000,
    provenance: venueApiProvenance('kalshi'),
  };

  it('pairs a $100,000 strike with a $99,999.99 one', () => {
    // A cent apart is the same contract; an exact comparison would reject it.
    const match = verifyMatch(kalshi, manualToMarket(row(), context));
    expect(match.checks.find((c) => c.name === 'same_line_and_operator')?.passed).toBe(true);
    expect(match.checks.find((c) => c.name === 'same_structural_trigger')?.passed).toBe(true);
  });

  it('surfaces the pairing as unverifiable when the book publishes no index', () => {
    // The wording overlap is near zero, but every structural dimension
    // agrees, so the propositions match. What is missing is the settlement
    // basis — and a book that publishes none has not demonstrated a
    // mismatch. Rejecting here would discard essentially every DraftKings
    // comparison forever.
    const match = verifyMatch(kalshi, manualToMarket(row(), context));

    expect(match.contract.state).toBe('EQUIVALENT');
    expect(match.confidence).toBeGreaterThanOrEqual(0.8);
    expect(match.settlement.assurance).toBe('UNVERIFIABLE');
    expect(match.settlement.right_source).toContain('Not exposed');
    expect(match.eligible_for_arbitrage).toBe(true);
  });

  it('grades a demonstrated index difference as a conflict, not an unknown', () => {
    const differentIndex = manualToMarket(row(), {
      ...context,
      house_rules: {
        source_document: 'house rules',
        sections: { Bitcoin: { settlement_source: 'Coinbase spot price' } },
      },
    });
    const match = verifyMatch(kalshi, differentIndex);
    expect(match.settlement.assurance).toBe('CONFLICT');
    expect(match.eligible_for_arbitrage).toBe(false);
    // The propositions still match; it is the basis that does not.
    expect(match.contract.state).toBe('EQUIVALENT');
  });

  it('does not let a documented conflict masquerade as missing information', () => {
    // This is the case that matters for crypto thresholds. "Coinbase spot"
    // and "CF Bitcoin Real-Time Index" are different numbers that agree
    // almost always and disagree exactly when a threshold is close — which is
    // precisely when a hedge across them would fail. Documenting the rules
    // makes the pairing score *worse*, and that is the correct outcome.
    const differentIndex = manualToMarket(row(), {
      ...context,
      house_rules: {
        source_document: 'venue house rules',
        sections: {
          Bitcoin: {
            settlement_source: 'Coinbase spot price',
            settlement_rules: 'Resolves on the Coinbase spot price for the period.',
          },
        },
      },
    });
    const undocumented = verifyMatch(kalshi, manualToMarket(row(), context));
    const documented = verifyMatch(kalshi, differentIndex);

    // Same contract confidence either way — the propositions did not change.
    // What changed is what we know about settlement, and that is now its own
    // three-valued state rather than a discount on one number.
    expect(undocumented.settlement.assurance).toBe('UNVERIFIABLE');
    expect(documented.settlement.assurance).toBe('CONFLICT');
    expect(undocumented.eligible_for_arbitrage).toBe(true);
    expect(documented.eligible_for_arbitrage).toBe(false);
    const source = documented.settlement_diff.fields.find((f) => f.field === 'settlement_source');
    expect(source?.severity).toBe('MATERIAL');
    expect(source?.right_only_terms).toContain('coinbase');
  });

  it('records how specifically the settlement rules were written', () => {
    // A venue-wide rule applied to one contract is an inference about that
    // contract, so it cannot support the same confidence as a rule written
    // for the market itself.
    const venueWide = manualToMarket(row(), {
      ...context,
      house_rules: { source_document: 'house rules', venue: { settlement_source: 'X' } },
    });
    const sectionLevel = manualToMarket(row(), {
      ...context,
      house_rules: { source_document: 'house rules', sections: { Bitcoin: { settlement_source: 'X' } } },
    });

    expect(venueWide.provenance.settlement_rules_scope).toBe('VENUE');
    expect(sectionLevel.provenance.settlement_rules_scope).toBe('SECTION');
    expect(venueWide.provenance.confidence_ceiling).toBeLessThan(
      sectionLevel.provenance.confidence_ceiling,
    );
  });

  it('confirms settlement when both venues name the same index', () => {
    // Note what this fixture asserts: that DraftKings settles on the *same*
    // index as Kalshi. That is an assumption about the world, not a property
    // of the capture — if the venues use different indices the score drops
    // instead, as the test above shows.
    const documented = manualToMarket(
      row({ settlement_source: 'CF Bitcoin Real-Time Index', settlement_rules: kalshiRules }),
      context,
    );
    const match = verifyMatch(kalshi, documented);
    expect(match.settlement.assurance).toBe('CONFIRMED');
    expect(match.confidence).toBeGreaterThanOrEqual(0.8);
    expect(match.eligible_for_arbitrage).toBe(true);
  });

  it('still refuses a repaired record the top band, however well it scores', () => {
    const repaired = manualToMarket(
      row({
        settlement_source: 'CF Bitcoin Real-Time Index',
        settlement_rules: kalshiRules,
        repairs: ['market name "$1OOk" read as "$100k"'],
      }),
      context,
    );
    const match = verifyMatch(kalshi, repaired);
    expect(match.confidence).toBeLessThanOrEqual(0.94);
    expect(match.checks.find((c) => c.name === 'unmodified_venue_text')?.passed).toBe(false);
  });

  it('rejects a threshold that genuinely differs', () => {
    const other = manualToMarket(
      row({ market: 'When will Bitcoin cross $150k again?' }),
      context,
    );
    const match = verifyMatch(kalshi, other);
    expect(match.confidence).toBe(0);
    expect(match.checks.find((c) => c.name === 'same_line_and_operator')?.passed).toBe(false);
  });
});
