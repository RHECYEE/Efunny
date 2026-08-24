import { describe, expect, it } from 'vitest';
import { ONE_DOLLAR, scan, type FillContext } from '@arbterminal/core';
import {
  KalshiAdapter,
  KalshiClient,
  KalshiFeeModel,
  categoryOf,
  detectExhaustive,
  feeBookFor,
  toEvent,
  toMarket,
  toOrderBook,
  toQuote,
  topOfBookOnly,
  type KalshiEvent,
} from '@arbterminal/adapters';
import liveEvent from './fixtures/kalshi-event.json' with { type: 'json' };

const fixture = liveEvent as unknown as KalshiEvent;

/**
 * These run against a payload captured verbatim from the live Kalshi API, so
 * they pin the adapter to the real wire format without needing the network.
 */
describe('Kalshi normalization', () => {
  it('maps the event onto a venue-neutral canonical id', () => {
    const event = toEvent(fixture);
    expect(event.event_id).toContain('NEXT_SECRETARY_GENERAL_OF_NATO');
    expect(event.category).toBe('POLITICS');
    expect(event.participants).toContain('Kaja Kallas');
  });

  it('records mutual exclusivity but refuses to assume exhaustiveness', () => {
    const event = toEvent(fixture);
    // Kalshi flags at most one YES; it does not promise one of the listed
    // candidates gets the job, so a YES basket is not a hedge here.
    expect(event.canonical_outcome_set).not.toBeNull();
    expect(event.canonical_outcome_set).toHaveLength(4);
    expect(event.exhaustive).toBe(false);
    expect(event.exhaustive_basis).toContain('no catch-all outcome');
  });

  it('accepts exhaustiveness when a catch-all outcome exists', () => {
    const withCatchAll: KalshiEvent = {
      ...fixture,
      markets: [
        ...(fixture.markets ?? []),
        { ...fixture.markets![0]!, ticker: 'X-OTHER', yes_sub_title: 'Any other candidate' },
      ],
    };
    const { exhaustive, basis } = detectExhaustive(withCatchAll);
    expect(exhaustive).toBe(true);
    expect(basis).toContain('Any other candidate');
  });

  it('will not call a non-mutually-exclusive event exhaustive', () => {
    expect(detectExhaustive({ ...fixture, mutually_exclusive: false }).exhaustive).toBe(false);
  });

  it('normalizes a market with its settlement rules and canonical outcome', () => {
    const raw = fixture.markets![0]!;
    const market = toMarket(fixture, raw);

    expect(market.market_id).toBe(`kalshi:${raw.ticker}`);
    expect(market.venue).toBe('kalshi');
    expect(market.outcome).toBe('KLAUS_IOHANNIS_WINS');
    expect(market.tier).toBe('NON_SPORT');
    expect(market.status).toBe('OPEN');
    expect(market.payout_per_contract).toBe(ONE_DOLLAR);
    expect(market.settlement.settlement_source).toBe('North Atlantic Treaty Organization');
    expect(market.settlement.settlement_rules_text).toContain('Secretary General of NATO');
    // Adapters never assert a match confidence; that is the matcher's job.
    expect(market.match_confidence).toBe(0);
  });

  it('reconstructs executable ask ladders from resting bids', () => {
    // Exactly the shape the live orderbook endpoint returns.
    const book = toOrderBook({
      yes_dollars: [
        ['0.0600', '2226.98'],
        ['0.1000', '1014.00'],
      ],
      no_dollars: [
        ['0.7800', '264.32'],
        ['0.8900', '165.20'],
      ],
    });

    // Best NO bid 0.89 means YES is offered at 0.11.
    expect(book.yes_asks[0]).toEqual({ price: 110, size: 165.2 });
    expect(book.no_asks[0]).toEqual({ price: 900, size: 1014 });
    expect(book.yes_bids[0]).toEqual({ price: 100, size: 1014 });
  });

  it('matches the venue-quoted top of book after reconstruction', () => {
    const raw = fixture.markets![0]!;
    const book = topOfBookOnly(raw);
    expect(book.yes_asks[0]?.price).toBe(140); // yes_ask_dollars "0.1400"
    expect(book.no_asks[0]?.price).toBe(900); // no_ask_dollars  "0.9000"
  });

  it('reports no implied probability when only one side is quoted', () => {
    const book = toOrderBook({ yes_dollars: [['0.1000', '10']], no_dollars: [] });
    const quote = toQuote('kalshi:X', book, '2026-08-11T12:00:00.000Z');
    expect(quote.ask).toBeNull();
    expect(quote.implied_probability).toBeNull();
  });

  it('classifies categories from the venue label', () => {
    expect(categoryOf('Elections')).toBe('POLITICS');
    expect(categoryOf('Sports')).toBe('SPORTS');
    expect(categoryOf('Climate and Weather')).toBe('CLIMATE');
    expect(categoryOf(undefined)).toBe('OTHER');
  });

  it('treats sports events as futures unless they are two-way head-to-head', () => {
    const sports: KalshiEvent = { ...fixture, category: 'Sports' };
    expect(toMarket(sports, sports.markets![0]!).market_type).toBe('FUTURES_CHAMPIONSHIP');

    const headToHead: KalshiEvent = {
      ...sports,
      markets: sports.markets!.slice(0, 2),
    };
    expect(toMarket(headToHead, headToHead.markets![0]!).market_type).toBe('MONEYLINE');
    expect(toMarket(headToHead, headToHead.markets![0]!).tier).toBe('GAME');
  });
});

describe('Kalshi fee schedule', () => {
  const model = new KalshiFeeModel();
  const context = (overrides: Partial<FillContext> = {}): FillContext => ({
    venue: 'kalshi',
    product: 'KXNEXTNATOSECGEN',
    side: 'BUY_YES',
    price: 500,
    contracts: 1,
    role: 'TAKER',
    ...overrides,
  });

  it('applies ceil(0.07 * C * P * (1-P)) rounded up to the cent', () => {
    // 1 contract at 50c: 0.07 * 0.25 = $0.0175 -> $0.02 -> 20 deci-cents.
    expect(model.tradingFee(context())).toBe(20);
    // 100 contracts at 50c: 0.07 * 100 * 0.25 = $1.75 exactly.
    expect(model.tradingFee(context({ contracts: 100 }))).toBe(1750);
  });

  it('charges less at the extremes, where P*(1-P) collapses', () => {
    const cheap = model.tradingFee(context({ price: 50, contracts: 100 }));
    const even = model.tradingFee(context({ price: 500, contracts: 100 }));
    expect(cheap).toBeLessThan(even);
    // 0.07 * 100 * 0.05 * 0.95 = $0.3325 -> $0.34.
    expect(cheap).toBe(340);
  });

  it('uses the reduced multiplier on series that carry one', () => {
    const standard = model.tradingFee(context({ contracts: 100 }));
    const reduced = model.tradingFee(context({ contracts: 100, product: 'KXBTC' }));
    expect(reduced).toBeLessThan(standard);
    expect(reduced).toBe(880); // 0.035 * 100 * 0.25 = $0.875 -> $0.88
  });

  it('charges nothing for a zero-size fill', () => {
    expect(model.tradingFee(context({ contracts: 0 }))).toBe(0);
    expect(model.settlementFee()).toBe(0);
  });
});

describe('adapter wiring', () => {
  it('exposes its fee schedule to the engine as data', () => {
    const adapter = new KalshiAdapter();
    const fees = feeBookFor([adapter]);
    expect(fees.has('kalshi')).toBe(true);
    expect(fees.venues()).toEqual(['kalshi']);
  });

  it('declares that its two sides are not independently quoted', () => {
    // The complementary detector relies on this: on a matched book the YES
    // and NO asks cannot both be cheap at once.
    expect(new KalshiAdapter().capabilities.independent_two_sided_asks).toBe(false);
  });

  it('fetches snapshots through an injected client without touching the network', async () => {
    const client = new KalshiClient({
      fetch_impl: (async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/events')) {
          return new Response(JSON.stringify({ events: [fixture] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            orderbook_fp: { yes_dollars: [['0.1000', '50']], no_dollars: [['0.8600', '200']] },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      min_request_interval_ms: 0,
    });

    const adapter = new KalshiAdapter({ client });
    const snapshots = await adapter.fetchSnapshots();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.markets).toHaveLength(4);
    expect(snapshots[0]!.markets[0]!.quote.ask).toBe(140);

    // The whole pipeline runs end to end on this data without any
    // venue-specific code inside the engine.
    const result = scan({ events: snapshots }, { fees: feeBookFor([adapter]) });
    expect(result.scanned_markets).toBe(4);
    // Four candidates at 14c/11c/10c/11c NO-ask ~0.90: no basket clears costs.
    expect(result.opportunities.every((o) => o.type !== 'GUARANTEED_ARB')).toBe(true);
  });
});

describe('option merging', () => {
  it('keeps its defaults when a caller forwards an absent setting', async () => {
    // `{...DEFAULTS, ...options}` treats an explicit undefined as a value.
    // A service forwarding `timeout_ms: config.timeout_ms` from a config that
    // does not set it therefore erased the timeout, and
    // `AbortSignal.timeout(undefined)` threw on every request after that —
    // silently, because the callers catch and return an empty list, so a
    // whole venue just stopped appearing.
    let sawSignal: AbortSignal | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal ?? null;
      return new Response(JSON.stringify({ events: [], cursor: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new KalshiClient({ fetch_impl: fetchImpl, timeout_ms: undefined });
    await client.listEvents({ limit: 1 });
    expect(sawSignal).not.toBeNull();
    expect(sawSignal!.aborted).toBe(false);
  });
});

