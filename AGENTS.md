# AGENTS.md

Cross-provider song link converter. A sender pastes a Spotify or Apple Music
track link and gets a short link; a receiver clicks it and the song opens in
*their* provider. The receiver chooses a provider exactly once, ever (cookie,
1 year); every later click is a bare 302. The product is `listen.cx`.

## Product decisions (settled — don't relitigate without asking Omar)

- Receiver-side is the thesis. No sender accounts, no landing-page branding,
  no "add to library" (requires Apple Music user auth — rejected as not
  low-touch). Open the song; that's it.
- One click ever: choice page buttons link to `?to=spotify|apple`, which sets
  the pref cookie AND redirects to this song in one gesture. First click is
  never wasted on configuration.
- Preference is per-browser (cookie), not per-person. Accepted for v0.
- Both directions create a usable link. Cross-provider matches are best-effort;
  the highest-scoring catalog result is used even when imperfect. Tracks only;
  albums/playlists later.
- Choice page design is approved: contained flat artwork (~208px), title,
  artist, muted "Where do you listen?", two NEUTRAL monochrome buttons
  (no brand colors — deliberate), randomized button order (no default
  provider), footnote "Remembers your choice. Next time, songs open
  instantly." Returning users never see any page. No product branding on
  the card. In-app webviews (Instagram etc.) won't share Safari cookies —
  accepted; degrades to one extra tap.
- Escape hatch: `?choose=1` bypasses the cookie.
- Unfurl bots always get the OG-tagged HTML (UA regex), never a redirect.
  The unfurl (artwork + title) is the sender-adoption mechanism.

## Resolution pipeline

- Spotify inbound: track id → public Spotify oEmbed + embed metadata →
  iTunes Search API lookup by title and artist. Candidates are ranked using
  title-token overlap, artist-token overlap, and duration proximity; the best
  result gets the direct Apple URL. No Spotify credentials are required.
- Apple inbound: iTunes lookup by id supplies metadata and the Apple URL. The
  Spotify button uses a title-and-artist search URL because Spotify's public
  embed APIs do not provide catalog search.
- Resolution happens ONCE at create time; rows are immutable. Redirect path
  never calls provider APIs.
- Credential-free resolutions are stored as partial rows and are not deduped.
- Slugs: nanoid, 7 chars, alphabet excludes 0/O/1/l/I (links get read aloud).

## Stack

pnpm, TypeScript, Hono, Cloudflare Workers, D1, Wrangler, and the Cloudflare
Vitest integration. No provider secrets are required. Production and staging
use separate D1 databases; local development uses Wrangler's local D1 state.

## Layout

- src/urls.ts      — parse/normalize track URLs (intl-xx paths, ?i= deep
                     links, storefronts), search-URL fallbacks
- src/spotify.ts   — public oEmbed + embed metadata lookup (injectable fetch)
- src/itunes.ts    — lookupById + searchTracks (keyless; artwork upscaled
                     100x100→600x600)
- src/resolve.ts   — Resolver, both directions, conservative metadata matching
- src/db.ts        — D1-backed LinkStore, immutable short-link rows
- src/page.ts      — choicePage (approved design) + homePage (paste box)
- src/app.ts       — routes: GET /, POST /create, GET /:slug
- src/worker.ts    — Cloudflare Worker entrypoint and binding wiring
- migrations/      — versioned D1 schema migrations
- test/            — Worker-runtime resolver, route, D1, and entrypoint tests

## Commands

pnpm install · pnpm types · pnpm migrate:local · pnpm dev · pnpm test ·
pnpm typecheck · pnpm deploy:staging · pnpm deploy:production

## Live verification still needed (couldn't be done in the scaffold env — no
network access to provider APIs)

1. Measure ranked-match accuracy and false positives on a larger sample of
   real shared links, especially non-US storefronts.
2. iMessage unfurl: confirm the UA regex catches Apple's preview fetcher
   and the og:image renders. Adjust BOT_UA if needed.
3. music.apple.com universal-link handoff to the native app from a 302 on
   iOS and macOS.
4. Public Spotify embed metadata stability; malformed or unavailable metadata
   currently produces a retryable provider error.

## Open items / v1 candidates

- Rate limiting on POST /create.
- Album + playlist links.
- Tidal/YouTube Music as third providers (choice page becomes 3 buttons —
  design holds).
- Prepend-the-domain conversion trick (paste domain before a spotify URL).
