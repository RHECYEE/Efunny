# ArbTerminal

A read-only cross-venue prediction market and sports arbitrage scanner. It ingests
prices, normalizes them into a shared schema, detects mathematically valid arbitrage
and value discrepancies, and lets you simulate stakes and paper-trade outcomes.

**It never places a wager.** There is no order-entry code path anywhere in this
repository, and the venue client only reads public market-data endpoints.

---

## Status: Stage 1 complete

| Stage | Scope | State |
| --- | --- | --- |
| 1 | Kalshi-only foundation: live ingestion, normalized binary markets, order-book depth, single-venue arbitrage, quote logging, fee/slippage-adjusted edge, paper trading | **Done** |
| 2 | First cross-venue integration; cross-venue matching and arbitrage | **Working via manual price capture** — a licensed odds feed is still unavailable, see [Stage 2](#stage-2-cross-venue-without-a-data-licence) |
| 3 | Settlement-diff depth, semantic matching, alerting, spreads and totals | Settlement diffing is already first-class; the rest not started |
| 4 | Backtesting, opportunity statistics, arb-quality scoring | Quote log is recording the history it needs; analytics not started |

---

## Quick start

### Download and run it

Grab the file for your platform from [Releases](../../releases) and run it. It
starts a local server and opens ArbTerminal in your browser. Nothing needs to be
installed — the Node runtime, the server and the whole interface are inside the
one file (~120 MB).

| Platform | File |
| --- | --- |
| Windows | `ArbTerminal-windows.exe` |
| macOS | `ArbTerminal-macos` |
| Linux | `ArbTerminal-linux` |

These builds are **unsigned**. Windows SmartScreen warns on first run — "More
info" then "Run anyway". macOS Gatekeeper needs right-click → Open the first
time. Signing needs certificates this project does not have.

The quote log is written to your user data directory, not next to the
executable, so it survives replacing the binary:

| Platform | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ArbTerminal\arbterminal.sqlite` |
| macOS | `~/Library/Application Support/ArbTerminal/` |
| Linux | `~/.local/share/ArbTerminal/` |

### Or run it from source

```bash
npm install
npm run dev          # API on :8787, terminal UI on :5173
```

Then open <http://localhost:5173>. No credentials are needed — every Kalshi endpoint
this uses is public and unauthenticated.

```bash
npm test             # 119 tests, no network, no model
npm run typecheck
npm run package      # build the executable for the current platform
```

`npm run package` builds the UI, bundles the server into one CommonJS file with
esbuild, embeds the interface as SEA assets, and injects the blob into a copy of
this machine's Node. It **cannot cross-build**: the binary is a copy of the host's
own Node, so a Windows `.exe` has to be produced on Windows. The release workflow
runs it on each platform's own runner.

Useful environment variables: `PORT` (steps forward if taken), `POLL_INTERVAL_MS`
(default 30s), `MARKET_LIMIT` (600), `DEPTH_FETCH_LIMIT` (150), `MIN_NET_EDGE`
(1 deci-cent), `ARBTERMINAL_DB`.

---

## Tech stack, and why

TypeScript monorepo on npm workspaces. Three deliberate choices:

**One language across engine, server and UI.** The `Opportunity` the arb engine
produces is the same type the React card renders. A units mistake — cents versus
deci-cents, edge versus ROI — becomes a compile error rather than a wrong number on
a screen. The UI imports `formatPrice` from the engine, so display cannot drift from
the math.

**A dependency-free core package.** `@arbterminal/core` imports nothing. It has no
network access, no database, no framework and no LLM client, which is what makes
"the arb math is testable without live data" structurally true rather than a
convention. 119 tests run in under a second.

**Persistence with no native module.** `node:sqlite` ships with Node 22, so the
quote log needs no build step. Fastify serves the API; Vite and React serve the UI.

### Prices are integers

Every price, cost and edge is an integer in **deci-cents** (1000 = $1.00) until the
moment it is formatted. Kalshi quotes some series on a deci-cent grid, so cents are
not fine enough — and `0.1 + 0.2 !== 0.3` is not an acceptable property for code
whose entire job is deciding whether a basket costs less than the dollar it pays.

---

## Architecture

```
Kalshi API ─┐
            ├─> Ingestion (adapters) ─> Normalizer ─> Matching engine ─> Arb engine ─> App
Odds provider (Stage 2) ─┘
```

```
packages/core/         no dependencies, no I/O, no LLM
  domain/              types, deci-cent arithmetic, content-derived ids
  normalize/           odds conversion, book reconstruction, canonicalization
  match/               settlement diffing, confidence tiers, verification
  arb/                 fee models, slippage, reserve, hedge solver, detectors
  paper/               fill simulation against a re-fetched book
  portfolio/           cart aggregation, filters, honesty statistics
packages/adapters/     the only place a venue is named
  kalshi/              client, wire-format mapping, fee schedule
  manual/              CSV import: parsing, validation, OCR repair, odds mapping
apps/server/           poller, SQLite quote log, read-only HTTP API
apps/web/              multi-panel terminal UI
```

### Adding a venue

Write an adapter implementing `VenueAdapter`, then add it to the array in
`apps/server/src/index.ts`. Nothing else changes — the matching engine and arb
engine consume normalized `Market` and `Quote` objects and never learn a venue's
name. The fee schedule travels with the adapter as data (`FeeModel`), so a venue
with an exotic fee curve does not put a branch in the engine.

`packages/core/test/` proves this: every arb-engine test runs against two synthetic
venues that have no adapter at all.

---

## Design rules the code actually enforces

### 1. No automated execution

There is no order-entry code. `POST /api/opportunities/:id/paper-trade` re-fetches
the public order book, simulates a fill against it, and writes a row to a local
SQLite file.

### 2. The math is deterministic code, not model output

No LLM call sits anywhere in the path that computes an edge, a stake or a P/L. An
LLM may *propose* that two differently-worded markets are the same contract, but a
proposal carries no authority — `verifyMatch` re-derives confidence from blocking
structural checks. A proposal asserting 0.99 confidence on a moneyline/player-prop
pair still scores 0, and there is a test that says so.

### 3. Confidence tiers, and a hard floor

| Confidence | Meaning | Treatment |
| --- | --- | --- |
| 100% | Mechanically identical contracts | Shown as arbitrage |
| 95–99% | Almost certainly identical | Shown as arbitrage |
| 80–94% | Manual review required | Shown, visually distinct, dashed border |
| < 80% | Rejected | **Never surfaced as arbitrage** |

The floor is enforced in `filterOpportunities` regardless of user filter settings.

### 4. Every edge is cost-adjusted

Each card shows the raw edge in muted text and the executable edge as the only large
number on it. The full stack, in display order:

```
raw edge  →  venue fees  →  modeled slippage  →  settlement mismatch reserve  →  EXECUTABLE EDGE
```

Slippage is not a fudge factor: it is the cost of actually walking the visible ask
ladder for the sized position. No liquidity beyond the published book is ever
assumed. The settlement reserve is a deterministic haircut driven by the diff
severity and the residual match uncertainty — at the 80% floor it withholds 5¢ per
dollar, so a review-tier match needs a genuinely wide spread to clear it.

### 5. Four opportunity types

`GUARANTEED_ARB`, `CROSS_VENUE_ARB`, `NEAR_ARB` (a spread exists but costs ate it),
`RELATIVE_VALUE` (probabilities diverge with no hedge available). Classification
happens after costs, so anything whose edge does not survive fees is demoted out of
the arbitrage buckets automatically.

### 6. Settlement differences are readable text

A score alone hides *why* two contracts might not pay out together. The diff engine
reads contradictory concepts — overtime treatment, void handling, settlement timing,
threshold direction — out of the venues' own wording, and the analysis view shows
both rule sets side by side with the terms that appear on only one side highlighted.

Two things worth knowing: contradictory overtime rules are **disqualifying**, not a
penalty, because "including overtime" and "regulation only" are different contracts
at any price. And silence on a rule is treated as **material**, not as agreement —
an undocumented rule is an unknown, not a match.

### 7. Sports market tiers never mix

`GAME` / `TEAM_PROP` / `PLAYER_PROP` / `FUTURES` are checked as a blocking condition.
"Team -3.5" can never be matched to "Team to win" at any confidence. Moneyline is
the only sports market type in scope; the Kalshi adapter classifies a sports event as
moneyline only when it is a two-outcome head-to-head, and everything else in the
category becomes a future.

---

## Two correctness points that matter

### Mutual exclusivity is not exhaustiveness

A venue flagging outcomes as mutually exclusive promises **at most one** resolves
YES — not exactly one. That difference decides real money:

- A **NO basket** is safe under exclusivity alone. At most one YES means at least
  N−1 of the NO legs pay, so buying NO across all of them for less than (N−1)
  dollars is a genuine hedge.
- A **YES basket** is *not*. If none of the listed outcomes happens, every leg
  expires worthless. It is only an arbitrage when the outcome set is also
  exhaustive.

Kalshi does not publish an exhaustiveness flag, so the adapter requires positive
evidence — a catch-all outcome such as "any other candidate", or a two-outcome pair
stated as complements. Absent that, `exhaustive` stays false and the YES basket
detector does not run. This is conservative by design: it means the terminal will
sometimes stay quiet where a naive scanner would show a phantom arbitrage.

The same distinction shapes relative-value reporting. Across a non-exhaustive
mutually exclusive set, mid prices summing to *less* than 1.00 is the expected
state, not a signal — only an overround is anomalous. Enforcing that turned 16
reported "opportunities" on a live scan into the 2 that were real.

### A mid is only a probability if the market is quoted tightly

A market quoted 1c/99c has a midpoint of 50c that means nothing, and summing a
basket of those manufactures an arbitrarily large "overround" out of pure spread
width. A live scan surfaced a 19-outcome UK politics event whose mids summed to
3.15 for exactly this reason, ranked top of the list at "+214.80c".

Divergence detection therefore requires every outcome to be quoted inside
`max_spread_for_divergence` (default 10c) before its mid counts at all, and the
warning states the widest spread in the basket. This is deliberately
conservative: it stays quiet rather than ranking an artifact first.

### Positions are sized on average cost

Sizing walks the book and stops where the **volume-weighted** cost of the whole
position reaches break-even, not where the marginal level does. A fill that eats
past the best level is still an arbitrage while its VWAP stays under the payout.

### Kalshi's book is one ladder seen from two sides

Kalshi publishes resting *bids* on each side. A resting NO bid at $0.89 is an offer
to sell YES at $0.11, so the executable ask ladders are exact complements — that
reconstruction lives in the adapter, not the engine.

A consequence: within a single Kalshi market, `yes_ask + no_ask = 2 − (yes_bid +
no_bid)`, which can only fall below $1.00 on a crossed book. The complementary
detector is still implemented and tested, because it is correct for any venue that
quotes two independent ask ladders — but on Kalshi the real single-venue
opportunity is the mutually exclusive basket.

---

## Paper trading

The core educational payoff, not an afterthought. Pressing **Paper trade** re-fetches
the live order book, simulates the fill against it, and reports:

- **Displayed edge** — what the card advertised.
- **Actually fillable edge** — what was obtainable against the execution-time book.
- **Edge decay**, attributed per leg to a specific cause: price moved, insufficient
  size at the quote, level disappeared, market closed.

The position is scaled down to whichever leg filled worst, because a half-filled
hedge is not a hedge. Both order-book snapshots are stored on the trade. The Paper
Portfolio view aggregates this into an **edge capture rate** — what fraction of the
edge this terminal advertised was actually there.

For relative-value positions the fillable edge is derived from how far the *entry
cost* moved, since those have no guaranteed payout to subtract from.

---

## Stage 2: cross-venue without a data licence

Neither DraftKings nor bet365 offers a public API, and this repository
contains no scraper. The route that does work is importing prices **you**
captured, as CSV — see [`imports/README.md`](imports/README.md) for the format.

That makes cross-venue matching real today. On a live run against a captured
DraftKings board, the pipeline paired:

```
Kalshi       How high will Bitcoin get in 2026?  ->  Above $99,999.99   12.00c ask
DraftKings   When will Bitcoin cross $100k again? ->  Before Jan 2027   +400 (18.02c de-vigged)
```

No arbitrage — Kalshi YES + DK NO is 103c, DK YES + Kalshi NO is 109c, both
above the dollar they would pay — but a six-point disagreement about the same
fact.

Three things had to be true for that pairing to be found at all:

- **Thresholds compare with a relative tolerance.** `$99,999.99` and
  `$100,000` are the same strike a cent apart. The epsilon is relative, never
  absolute: a fixed tolerance wide enough for a six-figure crypto strike would
  happily equate a -3.5 spread with a -4.5 one.
- **Candidates are bucketed on structure, not on the event id.** Two venues
  describe one contract in different words and land on different canonical
  ids, which is precisely the case cross-venue matching exists for. Bucketing
  on tier, market type, comparison and threshold-to-four-significant-figures
  finds them; the cost is |exchange| x |book|, and the book side is small.
- **Matching structure counts as evidence.** Where two markets state the same
  comparison against the same number at the same deadline, that corroborates
  identity in a way token overlap cannot — those two titles share almost no
  words. It sets a floor of 0.85, deliberately below the almost-certain band,
  because matching structure says they trigger on the same fact and *not* that
  they settle the same way.

The pair above is never surfaced, because the settlement comparison cannot be
completed — and that turns out to be the substantive finding rather than a
paperwork problem.

### Settlement rules are not on the market card

Sportsbooks do not publish settlement terms per market. They publish one House
Rules document covering a whole product, and the market card in the app
carries none of it. So the rules are supplied once in
`imports/<venue>/rules.json`, at whatever granularity the venue actually
documents them — the venue, a section of the board, or a named market. Which
scope a rule came from is recorded, because "this venue settles crypto on
index X" is a weaker claim about one contract than a rule written for it.

Doing that does **not** reliably raise confidence, and it should not:

| What the venue's rules say | Confidence | Result |
| --- | --- | --- |
| nothing findable | 0.67 | rejected — the rules are unknown |
| a **different** price index | 0.55 | rejected — a known difference, worse than an unknown |
| the **same** price index | **0.85** | review tier, surfaced |

For a crypto threshold, the settlement index *is* the contract. "Above
$100,000 on the CF Bitcoin Real-Time Index" and "above $100,000 on some other
spot index" are different bets that agree almost always and disagree exactly
when the price is near the threshold — which is precisely when the hedge would
be called upon. A tool that scored those as equivalent would be inventing an
arbitrage.

Capturing the house rules is therefore worth doing whichever way it comes out.
If the sources match you gain a usable signal; if they differ you learn the
hedge is unsound. Both beat assuming.

### A stated conflict costs more than silence

The differ used to charge the same for "the venues disagree" as for "one venue
is silent", which made documenting the rules change nothing. Silence is an
unknown that might resolve either way; a stated conflict is a known
difference. They now carry different penalties, and the summary says which
kind each field is.

### What a manual capture cannot give you

All three are recorded as provenance on every record, and shown on the card:

- **No order book.** One price, no size. Capacity comes from an assumed stake
  limit and is labelled as assumed; slippage on those legs is reported as
  unmodelled rather than as zero, because zero slippage and unmeasurable
  slippage are not the same claim.
- **One snapshot.** The file does not update.
- **Transcription error.** `$100k` read as `$1OOk` is repaired
  deterministically inside currency tokens, the repair travels with the
  record, and a repaired record is capped at 94% confidence — it can never be
  presented as mechanically identical to anything.

Feeding the real capture through: 11 rows imported, 13 rejected with a stated
reason each (four with no market name, one with an odds value in the outcome
column, three unverifiable name repairs, one locked price). Three raw
spellings — `$100k`, `$10Ok`, `$1OOk` — were reported as one market rather
than silently merged.

### The exchange side does not scale to a full crawl

Kalshi lists about **90,000 open markets** across 50+ pages; sweeping all of
them takes roughly 27 seconds, which no short poll interval can absorb. Set
`KALSHI_SERIES` to the series a second venue also prices and the cycle drops
to about two seconds.

### The sportsbook hedge solver

Implemented and tested (`packages/core/src/arb/hedge.ts`). Given N contracts at
price p against decimal odds D, the balanced stake is N/D — a sportsbook
returns stake *plus* profit while an event contract pays a flat $1.00.
Commission on winnings and rounding to the cent are both handled, and the
guarantee reported is always the worse of the two branches.

## API

All read-only except the two paper-trading routes, which write to local SQLite.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/status` | Adapters, last cycle, counts, quote-log size |
| GET | `/api/opportunities` | Filtered list plus counts |
| GET | `/api/opportunities/:id` | Full analysis: quotes, depth, consensus, history, matches |
| POST | `/api/opportunities/:id/paper-trade` | Re-fetch book, simulate fill, store trade |
| GET | `/api/trades` | Paper-trade history and edge-capture statistics |
| POST | `/api/trades/:id/resolve` | Settle a paper trade |
| POST | `/api/cart/summary` | Aggregate a hypothetical portfolio |
| GET | `/api/markets/:id/history` | Logged quote history |

---

## Data sources

**Kalshi** — official public API at `api.elections.kalshi.com/trade-api/v2`. Market
discovery, nested events and order books are all unauthenticated; the client is rate
limited to roughly 8 requests/second with exponential backoff on 429 and 5xx. Depth
costs one request per market, so each cycle spends its budget on the markets most
likely to carry an opportunity.

**DraftKings / bet365** — no public API for either. Stage 2 requires a licensed
odds-data provider. Not scraped, by policy.

---

## Not financial advice

This is a market-analysis tool. Displayed edges are models built on visible
liquidity and published fee schedules; real fills, settlement disputes and venue
risk are not captured by any of them.
