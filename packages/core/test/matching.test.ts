import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE,
  diffSettlement,
  matchMarkets,
  tierFor,
  validateProposals,
  venueApiProvenance,
  verifyMatch,
  type Market,
} from '@arbterminal/core';
import { market, settlement } from './helpers.js';

describe('settlement rule diffing', () => {
  it('reports identical rule sets as identical', () => {
    const diff = diffSettlement(settlement(), settlement());
    expect(diff.worst_severity).toBe('IDENTICAL');
    expect(diff.confidence_penalty).toBe(0);
  });

  it('treats contradictory overtime rules as disqualifying', () => {
    const diff = diffSettlement(
      settlement({ overtime_rules: 'Final score including overtime counts.' }),
      settlement({ overtime_rules: 'Settles on regulation time only; overtime does not count.' }),
    );
    expect(diff.worst_severity).toBe('DISQUALIFYING');
    expect(diff.confidence_penalty).toBe(1);

    const field = diff.fields.find((f) => f.field === 'overtime_rules');
    // The user gets a readable statement of the gap, not just a score.
    expect(field?.explanation).toContain('Overtime treatment');
    expect(field?.explanation).toContain('regulation time only');
  });

  it('treats silence on a rule as material, not as agreement', () => {
    const diff = diffSettlement(
      settlement({ void_rules: 'Voided if the match is abandoned.' }),
      settlement({ void_rules: '' }),
    );
    const field = diff.fields.find((f) => f.field === 'void_rules');
    expect(field?.severity).toBe('MATERIAL');
    expect(field?.explanation).toContain('Only one venue documents this rule');
  });

  it('treats pure rewording as cosmetic', () => {
    const diff = diffSettlement(
      settlement({ settlement_rules_text: 'Resolves YES if the named candidate wins election.' }),
      settlement({ settlement_rules_text: 'Resolves YES if named candidate wins the election.' }),
    );
    const field = diff.fields.find((f) => f.field === 'settlement_rules_text');
    expect(field?.severity).toBe('COSMETIC');
    expect(diff.confidence_penalty).toBeLessThan(0.05);
  });

  it('surfaces the wording gap as specific terms', () => {
    const diff = diffSettlement(
      settlement({ settlement_source: 'Associated Press' }),
      settlement({ settlement_source: 'certified state election results' }),
    );
    const field = diff.fields.find((f) => f.field === 'settlement_source');
    expect(field?.left_only_terms).toContain('associated');
    expect(field?.right_only_terms).toContain('certified');
  });
});

describe('confidence tiers', () => {
  it('maps scores to the documented bands', () => {
    expect(tierFor(1)).toBe('MECHANICALLY_IDENTICAL');
    expect(tierFor(0.97)).toBe('ALMOST_CERTAIN');
    expect(tierFor(0.85)).toBe('REVIEW_REQUIRED');
    expect(tierFor(0.79)).toBe('REJECTED');
  });

  it('puts the arbitrage floor at 80%', () => {
    expect(CONFIDENCE.ARBITRAGE_FLOOR).toBe(0.8);
  });
});

describe('match verification', () => {
  const left = market({ venue: 'venue_a', venue_market_id: 'A1' });

  it('scores an exact, same-settlement pairing at 100%', () => {
    const right = market({ venue: 'venue_b', venue_market_id: 'B1' });
    const match = verifyMatch(left, right);
    expect(match.confidence).toBe(1);
    expect(match.tier).toBe('MECHANICALLY_IDENTICAL');
    expect(match.eligible_for_arbitrage).toBe(true);
  });

  it('refuses to match across market tiers however correlated', () => {
    // "Team -3.5" is not "Team to win", and no price makes it so.
    const spread = market({
      venue: 'venue_b',
      venue_market_id: 'B2',
      tier: 'GAME',
      market_type: 'SPREAD',
      line: -3.5,
    });
    const moneyline = market({
      venue: 'venue_a',
      venue_market_id: 'A2',
      tier: 'GAME',
      market_type: 'MONEYLINE',
    });
    const match = verifyMatch(moneyline, spread);
    expect(match.confidence).toBe(0);
    expect(match.eligible_for_arbitrage).toBe(false);
    expect(match.checks.find((c) => c.name === 'same_market_type')?.passed).toBe(false);
  });

  it('refuses to match different lines on the same market type', () => {
    const a = market({ venue: 'venue_a', market_type: 'TOTAL', tier: 'GAME', line: null, threshold: 47.5, comparison_operator: 'GT' });
    const b = market({ venue: 'venue_b', market_type: 'TOTAL', tier: 'GAME', line: null, threshold: 48.5, comparison_operator: 'GT' });
    const match = verifyMatch(a, b);
    expect(match.eligible_for_arbitrage).toBe(false);
    expect(match.checks.find((c) => c.name === 'same_line_and_operator')?.passed).toBe(false);
  });

  it('refuses to pair a market with itself or with its own venue', () => {
    const sameVenue = market({ venue: 'venue_a', venue_market_id: 'A3' });
    expect(verifyMatch(left, sameVenue).eligible_for_arbitrage).toBe(false);
  });

  it('separates a rules contradiction from the question of contract identity', () => {
    const right = market({
      venue: 'venue_b',
      venue_market_id: 'B3',
      settlement: settlement({
        overtime_rules: 'Regulation time only, overtime does not count.',
      }),
    });
    const withOvertime = market({
      venue: 'venue_a',
      venue_market_id: 'A4',
      settlement: settlement({ overtime_rules: 'Includes overtime.' }),
    });
    const match = verifyMatch(withOvertime, right);
    // The contracts state the same proposition; the rules contradict. One
    // scalar could not say both, which is why they are now separate.
    expect(match.contract.state).not.toBe('MISMATCHED');
    expect(match.confidence).toBeGreaterThanOrEqual(CONFIDENCE.ARBITRAGE_FLOOR);
    expect(match.settlement.assurance).toBe('CONFLICT');
    expect(match.eligible_for_arbitrage).toBe(false);
  });

  it('calls two named-but-different settlement sources a conflict', () => {
    const right = market({
      venue: 'venue_b',
      venue_market_id: 'B4',
      settlement: settlement({ settlement_source: 'Reuters projection' }),
    });
    const match = verifyMatch(left, right);
    // Both venues said what they settle on, and they said different things.
    // That is a demonstrated difference, not missing information.
    expect(match.settlement.assurance).toBe('CONFLICT');
    expect(match.eligible_for_arbitrage).toBe(false);
    expect(match.settlement.reason).toContain('differ');
  });

  it('calls an unpublished settlement source unverifiable, not a conflict', () => {
    const silent = market({
      venue: 'venue_b',
      venue_market_id: 'B4b',
      settlement: settlement({ settlement_source: '' }),
    });
    const match = verifyMatch(left, silent);
    expect(match.settlement.assurance).toBe('UNVERIFIABLE');
    // Unresolved basis risk does not bar an arbitrage claim; it qualifies it.
    expect(match.eligible_for_arbitrage).toBe(true);
    expect(match.settlement.right_source).toContain('Not');
  });

  it('reports each contract dimension separately', () => {
    const right = market({ venue: 'venue_b', venue_market_id: 'B4c' });
    const match = verifyMatch(left, right);
    const names = match.contract.dimensions.map((d) => d.name);
    expect(names).toContain('threshold');
    expect(names).toContain('direction');
    expect(names).toContain('deadline');
    expect(match.contract.dimensions.every((d) => d.agreed)).toBe(true);
  });

  it('treats a differing threshold as a hard contract mismatch', () => {
    // Economic risk is continuous; logical mismatch is absolute. $100k and
    // $105k are different propositions and no confidence can bridge them.
    const other = market({
      venue: 'venue_b',
      venue_market_id: 'B4d',
      market_type: 'SCALAR_THRESHOLD',
      comparison_operator: 'GT',
      threshold: 105_000,
    });
    const base = market({
      venue: 'venue_a',
      venue_market_id: 'A4d',
      market_type: 'SCALAR_THRESHOLD',
      comparison_operator: 'GT',
      threshold: 100_000,
    });
    const match = verifyMatch(base, other);
    expect(match.contract.state).toBe('MISMATCHED');
    expect(match.confidence).toBe(0);
    expect(match.contract.dimensions.find((d) => d.name === 'threshold')?.agreed).toBe(false);
  });

  it('caps fuzzy identity below the almost-certain band', () => {
    const right = market({
      venue: 'venue_b',
      venue_market_id: 'B5',
      event_id: 'PRESIDENTIAL_ELECTION_WINNER_2028',
      outcome: 'CANDIDATE_A_TAKES_OFFICE',
      outcome_label: 'Candidate A',
      title: 'Candidate A - Presidential Election Winner',
    });
    const match = verifyMatch(left, right);
    // Same proposition reached through different wording, with no threshold
    // to corroborate it structurally.
    expect(match.contract.state).toBe('EQUIVALENT');
    expect(match.confidence).toBeLessThan(CONFIDENCE.ALMOST_CERTAIN_MIN);
  });
});

describe('proposal validation', () => {
  it('ignores the proposer confidence and re-derives its own', () => {
    const a = market({ venue: 'venue_a', venue_market_id: 'A9', tier: 'GAME', market_type: 'MONEYLINE' });
    const b = market({
      venue: 'venue_b',
      venue_market_id: 'B9',
      tier: 'PLAYER_PROP',
      market_type: 'PLAYER_POINTS',
    });

    // An LLM insisting these are the same market must not be able to say so.
    const matches = validateProposals(
      [
        {
          left_market_id: a.market_id,
          right_market_id: b.market_id,
          source: 'LLM',
          proposed_confidence: 0.99,
          rationale: 'Both concern the same player and game.',
        },
      ],
      [a, b],
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe(0);
    expect(matches[0]!.eligible_for_arbitrage).toBe(false);
    expect(matches[0]!.method).toBe('SEMANTIC_PROPOSED');
  });

  it('records the semantic method even when the pairing is sound', () => {
    const a = market({ venue: 'venue_a', venue_market_id: 'A10' });
    const b = market({ venue: 'venue_b', venue_market_id: 'B10' });
    const matches = validateProposals(
      [
        {
          left_market_id: a.market_id,
          right_market_id: b.market_id,
          source: 'LLM',
          proposed_confidence: 0.4,
          rationale: 'Differently worded but the same contract.',
        },
      ],
      [a, b],
    );
    // The proposer's low confidence does not cap the deterministic verdict.
    expect(matches[0]!.confidence).toBe(1);
    expect(matches[0]!.method).toBe('SEMANTIC_PROPOSED');
  });
});

describe('bulk matching', () => {
  it('pairs across venues only', () => {
    const markets = [
      market({ venue: 'venue_a', venue_market_id: 'A1' }),
      market({ venue: 'venue_b', venue_market_id: 'B1' }),
      market({ venue: 'venue_b', venue_market_id: 'B2' }),
    ];
    const matches = matchMarkets(markets);
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(match.left_market_id.startsWith('venue_a')).toBe(true);
    }
  });
});

describe('outcome identity where there is no threshold', () => {
  const fighter = (venue: string, name: string): Market => ({
    market_id: `${venue}:${name.replace(/\s+/g, '_')}`,
    event_id: `UFC_${venue}`,
    venue,
    venue_market_id: name,
    outcome: `${name.toUpperCase().replace(/\s+/g, '_')}_WINS`,
    outcome_label: name,
    market_type: 'MONEYLINE',
    tier: 'GAME',
    line: null,
    comparison_operator: 'NONE',
    threshold: null,
    settlement: {
      settlement_source: 'https://www.ufc.com/events',
      settlement_rules_text: 'Official UFC result.',
      void_rules: '',
      overtime_rules: '',
    },
    jurisdiction: 'US-CFTC',
    currency: 'USD',
    match_confidence: 0,
    title: 'UFC Fight Night',
    status: 'OPEN',
    close_time: '2026-08-30T00:00:00Z',
    payout_per_contract: 1000,
    provenance: venueApiProvenance(venue),
  });

  it('refuses to pair two different fighters on the same card', () => {
    // Every structural dimension agrees — same tier, same type, no threshold,
    // no operator, same deadline. Only the names differ, and with nothing to
    // corroborate the wording the names are the entire proposition.
    const match = verifyMatch(fighter('kalshi', 'Sean Woodson'), fighter('polymarket', 'Dan Hooker'));
    expect(match.contract.state).toBe('MISMATCHED');
    expect(match.eligible_for_arbitrage).toBe(false);
  });

  it('still pairs the same fighter across two venues', () => {
    const match = verifyMatch(
      fighter('kalshi', 'Umar Nurmagomedov'),
      fighter('polymarket', 'Umar Nurmagomedov'),
    );
    expect(match.contract.state).not.toBe('MISMATCHED');
    expect(match.eligible_for_arbitrage).toBe(true);
  });
});
