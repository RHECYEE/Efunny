# Manual price captures

Books like DraftKings and bet365 publish no usable public API, and this
project does not scrape. What it does read is prices you captured yourself and
dropped here as CSV.

Every `.csv` in `imports/<venue>/` is imported as one venue. Point the server
at it with `MANUAL_IMPORTS_DIR`, `MANUAL_VENUE` and `MANUAL_VENUE_NAME`.

## Columns

| Column | Required | Notes |
| --- | --- | --- |
| `market` | **yes** | Market name. A row without one is rejected — it cannot be identified. |
| `outcome` | **yes** | The outcome being priced, e.g. `Before January 2027` or `65,000 to 69,999.99`. |
| `yes_odds` | **yes** | American odds, e.g. `+400`. `LOCKED` rejects the row. |
| `no_odds` | no | American odds for the other side. Without it there is no way to strip the vig, so no probability is derived. |
| `captured_at` | recommended | ISO timestamp. Drives the staleness warning. |
| `observations` | recommended | How many times the row was seen. A repaired market name seen once is rejected as unverifiable. |
| `settlement_source` | **strongly recommended** | See below. |
| `settlement_rules` | **strongly recommended** | See below. |
| `void_rules` | no | Void / cancellation handling. |
| `section` | no | Board section. Recorded, not used as settlement text. |
| `source` | no | Where the capture came from. Shown as provenance. |

Extra columns are ignored.

## Why the settlement columns matter more than they look

A match is only allowed to be shown as arbitrage at 80% confidence or above,
and the settlement comparison is what gets it there. An undocumented rule is
treated as a **material** gap rather than as agreement, because silence is not
evidence of sameness.

Measured on a real capture, pairing DraftKings' `When will Bitcoin cross $100k
again? / Before January 2027` with Kalshi's `Above $99,999.99`:

| Capture includes | Confidence | Result |
| --- | --- | --- |
| odds only | 0.67 | rejected, never surfaced |
| `+ settlement_source` | 0.76 | still rejected |
| `+ settlement_rules` | **0.85** | review tier, surfaced |

Two extra columns move a pair from unusable to usable. Nothing else in the
capture comes close to that.

## What a capture cannot give you

Recorded on every imported record as provenance, and shown on the card:

- **No order book.** A sportsbook publishes one price and no size. Capacity
  comes from `MANUAL_STAKE_LIMIT` (default $500) and is labelled *assumed, not
  observed*; slippage on those legs is reported as unmodelled rather than as
  zero.
- **One snapshot.** The file does not update. Opportunities carry the age of
  the capture.
- **Transcription error is real.** `$100k` read as `$1OOk` is repaired
  deterministically inside currency tokens and the repair is recorded — but a
  repaired record is capped at 94% confidence and can never be presented as
  mechanically identical to anything.
