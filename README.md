# EFunny

An Android app that puts out feelers across short-form humour sources, ranks what
is actually trending in the last 24 hours, and compiles it into a set called
**Spotlight**.

## The daily shape

```
7 sources x 3 posts each  =  21 posts per day
delivered as 3 sets of 7  at  05:00 / 15:00 / 20:00 Mountain
                          ->  1 post per source, per drop
```

Every source contributes exactly 3 posts a day, and the day totals 21. Those
numbers live in one place, [`SpotlightSpec`](core/src/main/kotlin/com/rhecyee/efunny/core/spotlight/SpotlightSpec.kt),
and are asserted end to end by `FullDayTest`.

## What actually works, and what doesn't

Two of the platforms in the original brief have no legal API in 2026, and a third
cannot work from a standalone APK. Rather than pretend otherwise, EFunny ships
those as registered feelers that return `Unavailable` with the specific reason,
and fills their slots with sources that genuinely work.

| Source | Status |
|---|---|
| **YouTube Shorts** | Works. Data API v3, API key only. |
| **Reddit** (`r/funny`, `r/memes`) | Works. `installed_client` OAuth needs no client secret, so it is safe in an APK. |
| **Configurable sites** (FML, The Onion, …) | Works. Any RSS 2.0 or Atom URL becomes a source. |
| **Instagram Reels** | Blocked. Hashtag search does return public Reels, but needs a Meta **app secret** — which cannot ship inside a distributed binary — plus App Review. Needs a backend. |
| **TikTok** | Blocked. The Research API is restricted to accredited academic and non-profit institutions and explicitly excludes commercial and independent developers. The Display API only returns your own videos. |
| **Facebook humour groups** | Blocked. Meta removed the Groups API from *every* Graph API version on 22 Apr 2024. No permission or partnership restores third-party read access. |

Scraping the closed three is deliberately not implemented: it breaks their terms,
breaks constantly in practice, and risks the account and IP doing it.

## Getting a build

```
./gradlew :app:assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
./gradlew :core:test             # the ranking, dedup, allocation and timing rules
./gradlew :app:testDebugUnitTest
```

CI runs all three on every push and uploads the APK as
`efunny-debug-<run number>`.

## Setup

**The app is useful before you configure anything.** The RSS sources need no
credentials at all, so a fresh install compiles a Spotlight immediately.

To light up the other two, open **Sources** and paste:

- **YouTube Data API key** — a Google Cloud project with YouTube Data API v3
  enabled. Restrict it to your app's package name and signing certificate.
- **Reddit client ID** — an app of type **installed app** at
  <https://www.reddit.com/prefs/apps>. There is no secret to copy; that is the
  point of this OAuth flow.

Keys are held in `EncryptedSharedPreferences` on the device and never compiled
into the binary, so each install spends its own quota rather than everyone
sharing one rate limit.

## How ranking works

A YouTube view is not a Reddit upvote, so raw engagement is **never** compared
across sources. Scoring normalises within a source and emits a percentile, which
is the only number compared between them:

1. `velocity = engagement / max(ageHours, 1)` — this is what makes it *trending*
   rather than *popular*. 12k views in two hours beats 20k accumulated over twenty.
2. Percentile-rank within that source's own pool.
3. Take the top post per source.

Engagement per source: YouTube is `views + 10 x likes` (a like costs a deliberate
tap where a view can be autoplay); Reddit is `ups + 2 x comments` (an argument in
the replies is a stronger signal than a scroll-by upvote).

**RSS feeds carry no engagement data at all.** Those posts rank on recency and
the UI labels them "Latest" rather than "Trending", because claiming a trend
signal the format cannot provide would be a lie about the data.

### Dedup runs twice

- *Within a drop*, because the same meme genuinely is cross-posted to r/funny and
  r/memes within minutes.
- *Across drops*, because every drop looks back a full 24 hours — without it the
  20:00 set would be largely a rerun of 15:00. Candidates matching an ID,
  permalink, or near-identical title from the previous three drops are excluded
  before allocation.

### Backfill

Allocation is round-robin, which makes the quota rule and the backfill rule fall
out of a single loop: a pass takes at most one post per source, so no source can
reach a second slot until every source has had a first. A dead source costs the
day its 3 posts but never costs a drop its size. If *everything* is dry the drop
reports the shortfall on screen rather than padding with filler.

## Drop timing

Fire times are computed through `ZonedDateTime` against a zone **ID**, never a
fixed offset. Mountain Time swings between MST and MDT, so a hardcoded `UTC-7`
would fire an hour late for roughly half the year. `DropScheduleTest` walks all
1,095 drops of 2026 across both DST transitions to prove none are skipped or
doubled. Arizona users should set `America/Phoenix` in Sources.

Exact wall-clock times rule out `PeriodicWorkRequest`, whose flex window will not
reliably land on 05:00, so each drop is a one-shot that arms the next. The unique
work name embeds the drop's instant — a worker re-arming the chain from inside
itself would otherwise be enqueueing against the very name it runs under, and
`REPLACE` on running work cancels it mid-flight. A `BOOT_COMPLETED` receiver and
a daily re-arm worker restore the chain after a force-stop.

Missed drops are **not** backfilled retroactively: a "trending now" set compiled
six hours late is not trending.

## Architecture

```
core/   Plain Kotlin/JVM. Feelers, scoring, dedup, allocation, drop timing.
app/    Android. Room, Compose, WorkManager, encrypted key storage, wiring.
```

The split is deliberate. Everything that decides *what lands in a Spotlight* is
ordinary JVM code, so it is unit tested directly — no emulator, no Robolectric,
no waiting on CI. A full simulated day runs in milliseconds.

Sources are **rows, not classes**: adding a site or swapping a subreddit is a
config edit, which is what makes "configurable websites" work without touching
code. Every platform sits behind one `Feeler` interface, so enabling Instagram
later is a fetch body rather than a refactor.

There is no DI framework — the graph is a dozen objects with no cycles, wired by
hand in `EFunnyGraph`, matching the sibling FIRE-MAPS project.

## Status

An early build. The pipeline, scheduling and both dedup passes are covered by 72
unit tests, and the RSS parser is tested against a live capture of
`fmylife.com/rss` — which emits ISO-8601 in `pubDate` where the spec calls for
RFC-822, and hides the joke in `<description>` behind a "By Anonymous" byline.

The four seeded feed URLs were checked against the live web on 2026-08-06 and all
return content. Feed URLs rot, though, and no test can catch that offline — if a
default source starts reporting an error on the Sources screen, the fix is to
edit its URL there.

Not yet run against real YouTube or Reddit credentials on a device: those two
feelers are covered by unit tests over captured API payloads, not live calls.
