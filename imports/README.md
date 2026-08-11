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
| `settlement_source` | no | Only if the venue shows it per market, which most do not. Use `rules.json` instead. |
| `settlement_rules` | no | As above. |
| `void_rules` | no | As above. |
| `section` | no | Board section. Recorded, not used as settlement text. |
| `source` | no | Where the capture came from. Shown as provenance. |

Extra columns are ignored.

## Settlement rules go in `rules.json`, not in the CSV

Sportsbooks do not put settlement terms on the market card. They publish one
House Rules document per product, and that is what you transcribe — once, not
on every capture. Copy `rules.json.template` to `rules.json` and fill in what
you can actually find, at whatever level the venue writes it:

```json
{
  "source_document": "DraftKings House Rules, retrieved 2026-08-11",
  "venue":    { "settlement_source": "..." },
  "sections": { "Bitcoin": { "settlement_source": "..." } },
  "markets":  { "When will Bitcoin cross $100k again?": { "settlement_source": "..." } }
}
```

Most specific wins. The file is re-read every cycle, so editing it takes
effect without a restart. Leave a field out rather than guessing it — an
invented rule is worse than an absent one, because it reads as documentation
while diffing against the other venue's real wording.

### It will not always help, and that is the point

Pairing DraftKings' `When will Bitcoin cross $100k again?` with Kalshi's
`Above $99,999.99`:

| What the venue's rules say | Confidence | Result |
| --- | --- | --- |
| nothing findable | 0.67 | rejected — rules unknown |
| a **different** price index | 0.55 | rejected — a known difference |
| the **same** price index | **0.85** | review tier, surfaced |

For a threshold contract the settlement index *is* the contract. Two indices
that agree almost always can still land on opposite sides of $100,000 on the
day — which is exactly when the hedge matters. Finding out the venues differ
is a better outcome than a confident-looking number built on the assumption
they do not.

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
