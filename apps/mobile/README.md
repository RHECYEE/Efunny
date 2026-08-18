# ArbTerminal for Android

Import a capture, compare it against Kalshi, see what came back. The whole
pipeline runs on the phone — there is no server.

## Why this has to be an app, not a web page

Kalshi **rejects any request carrying an `Origin` header** with a 403 —
whatever the value, and regardless of User-Agent:

```
no Origin header                200
Origin: https://localhost       403
Origin: capacitor://localhost   403
OPTIONS preflight               403
browser User-Agent, no Origin   200
```

A browser always attaches `Origin` to a cross-origin request, so a web page,
a PWA, or a plain WebView `fetch()` simply cannot reach this API. That is not
a CORS header this project can work around; it is a decision on Kalshi's side.

The desktop build only works because its **Node server** makes those calls and
the browser talks to that server same-origin. Strip the server out and a
static page is dead on arrival.

This app solves it by routing HTTP through `CapacitorHttp`, which performs the
request in Java via OkHttp and sends no `Origin`. The Kalshi adapter is handed
that in place of `fetch` and is otherwise untouched — the injection point
already existed for testing.

## What runs on the device

Everything. `@arbterminal/core` has no dependencies and performs no I/O, so
normalization, the matching engine, settlement diffing, the assurance grading
and the arb engine all run in the WebView unchanged — the same code the
desktop app runs, not a reimplementation that could drift.

Only the two edges differ:

| Edge | Desktop | Android |
| --- | --- | --- |
| Prices in | a scanned directory of CSVs | a file picker or paste box |
| HTTP | Node `fetch` | `CapacitorHttp` (native, no Origin) |
| Storage | SQLite quote log | `@capacitor/preferences` |

To keep `node:fs` out of the bundle, the manual adapter was split: the
parsing, validation, OCR repair and normalization live in `manual/adapter.ts`
and take CSV *text*, while `manual/node.ts` adds the directory-scanning
wrapper the server uses. The mobile build imports the first and never the
second.

## Building

```bash
npm install
npm run apk -w @arbterminal/mobile     # → android/app/build/outputs/apk/debug/
```

Needs the Android SDK (platform 34, build-tools 34.0.0) with `ANDROID_HOME`
set, plus JDK 21. The release workflow builds it on CI and attaches the APK to
a GitHub Release.

The debug APK is signed with the standard Android debug key, so Android will
warn on install from an unknown source. That is expected for a build that is
not distributed through Play.

## Using it

1. **Import** — pick your CSV, or paste it. The last capture is remembered.
2. **Series** — name the Kalshi series your capture overlaps with, e.g.
   `KXBTCMAXY`. Kalshi lists ~90,000 open markets and sweeping all of them
   takes about half a minute; naming the series keeps a scan to a couple of
   seconds.
3. **House rules** (optional) — paste the venue's settlement rules as JSON.
   Without them, matches still surface, graded **unverifiable** rather than
   hidden.
4. **Compare** — results are ordered by executable edge, with the assurance
   grade leading each card. Tap a card for the settlement comparison, the cost
   stack, and the two settlement scenarios.

Rejected rows are listed with the reason each was dropped, so a bad capture is
visible rather than silently shrinking the result.

## What it does not do

No orders, anywhere, ever. No paper-trade fill simulation either — that needs
a re-fetched order book at execution time and a place to store the history,
which is the desktop build's job. This app answers one question: what does my
capture look like against Kalshi right now.
