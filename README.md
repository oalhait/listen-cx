# listen.cx

A small TypeScript backend for Spotify and Apple Music track metadata and stored
short links. The previous web UI, threads, push notifications, Raycast extension,
playlist experiments, and fuzzy cross-provider matching have been removed.

A minimal landing-page prototype now lives in `public/` and is served at `/` by
Wrangler static assets. It includes a demo link input and music-app chooser.
The demo makes no API calls and does not generate live links or save preferences.
Cross-platform Jams are presented as coming soon.

Run `pnpm dev` and open the printed local URL to preview it. Database migrations
are needed for API development, but not for the landing page.

## Run locally

```sh
pnpm install
pnpm migrate:local
pnpm dev
```

## API

- `GET /healthz` checks database connectivity; returns 200 or 503.
- `POST /create` accepts JSON `{ "url": "<Spotify or Apple Music track URL>" }`.
  Returns `{ link, slug, title, artist, artworkUrl }`. Requests are limited to 4 KiB.
- `GET /:slug` returns the stored row as JSON, including `spotify_url` and
  `apple_url`. It does not contact providers, render HTML, or redirect.

New rows contain only the source provider's URL. The opposite provider URL is
null. Every creation gets a new seven-character slug. Invalid inputs return 400,
missing tracks return 404, oversized bodies return 413, and provider failures
return 502. Storage failures return 500.

```sh
curl http://localhost:8787/create \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO"}'
```

## Retained code

- `src/urls.ts`: track URL parsing and provider URL builders.
- `src/spotify.ts`: public oEmbed and embed metadata lookup.
- `src/itunes.ts`: Apple lookup, catalog search, and public-page metadata fallback.
- `src/fetch.ts`: bounded retries and per-attempt timeouts.
- `src/resolve.ts`: source-provider metadata only; no match guessing.
- `src/db.ts`, `src/app.ts`, `src/worker.ts`: D1 storage and JSON API.

`ItunesClient.searchTracks` returns catalog candidates. It does not establish
that a result matches a recording on another provider. Spotify metadata and the
Apple fallback depend on public page formats and can fail if those formats change.
Unavailable tracks return null; unavailable or malformed provider responses throw.

## Verification

```sh
pnpm test           # deterministic tests in the Cloudflare Worker runtime
pnpm typecheck
pnpm test:live      # read-only network checks; no credentials required
```

The live checks assert known Spotify titles and artists, Apple lookup and search
in US/GB storefronts, and the Apple page fallback. They are separate from offline
regression tests because availability and catalogs change. Passing a sample is
not a guarantee for every track or future provider response. During the restart,
all five live checks and local Worker create/read flows for both providers passed.
One initial Spotify request timed out; the next live run passed.

## Existing deployments and data

This restart has not been deployed. Historical D1 migrations remain unchanged;
no remote data has been deleted. Existing rows retain their original values,
including any old inferred cross-provider URLs. Those values have not been
reverified, and the API does not certify them as matches.

The Worker no longer exports the old Thread Durable Object. Deploying over an
existing installation requires a deliberate Durable Object migration decision
first; this change does not schedule deletion of its stored data. Production
commands must be run by Omar. A deployment also changes short links from the old
receiver UI to JSON, so existing consumers must be considered before release.
