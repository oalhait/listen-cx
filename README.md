# listen.cx

A TypeScript Worker for Spotify and Apple Music track metadata, stored short
links, and a small web frontend. Paste a direct track link at `/` to create a
shareable URL with its real title, artist, and artwork. Albums and `spotify.link`
short URLs are not supported. Apple album URLs must include a track's `?i=` ID.

The recipient page opens the original provider URL and offers a clearly labeled
search on the other app. No app preference is saved. Threads collect ordered songs
collaboratively. Connect Apple Music, Spotify, or both from **Account settings**, then
subscribe to Threads separately for each service. Provider credentials are
encrypted once and shared across that account's subscriptions. Actual provider readback is
required before a playlist is reported as synced; fixture tests alone do not
establish live provider behavior.

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
  `apple_url`, by default and for `Accept: application/json`. Explicitly requesting
  `text/html` with a higher quality than JSON (including wildcard quality) returns
  the recipient page instead. Ties select JSON; `*/*` alone stays JSON. Responses
  include `Vary: Accept`. Missing slugs use the same negotiation with status 404.
  Reading a link does not contact providers or redirect automatically.
- `GET /api/jams/:jamId` returns a Jam's state and active ordered queue when the
  local-only Jam gate is enabled; otherwise the route stays dark with 404.
- `GET /api/apple-music/developer-token` signs a short-lived MusicKit developer
  token when Apple credentials are configured and the request origin is allowed.

New rows contain only the source provider's URL. The opposite provider URL is
null. Every creation gets a new seven-character slug. Invalid inputs return 400,
missing tracks return 404, oversized bodies return 413, and provider failures
return 502. Storage failures return 500.

```sh
curl http://localhost:8787/create \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO"}'
```

## MCP for agents

The Worker exposes a stateless Streamable HTTP MCP server at `/mcp`. Start the
local Worker as above, then point an MCP client at:

```text
http://127.0.0.1:8787/mcp
```

This repository includes a project-scoped `.codex/config.toml`, so a trusted
Codex project discovers that endpoint automatically. To add it manually instead:

```sh
codex mcp add listen-cx --url http://127.0.0.1:8787/mcp
```

The checked-in configuration intentionally stays local. After deploying to
staging, register the HTTPS endpoint separately with
`codex mcp add listen-cx-staging --url https://staging.listen.cx/mcp`.

The server always exposes:

- `create_listen_link`: creates a fresh immutable link for one Spotify or Apple
  Music track URL.
- `get_listen_link`: retrieves stored metadata by seven-character slug or link,
  including an explicit source-only or legacy-unverified provider URL status.
- `check_listen_health`: checks link storage and reports whether Jams are ready
  or disabled.

When `JAMS_ENABLED=true` and the request host is loopback, it also exposes:

- `create_jam`: creates a collaborative ordered queue and returns its public id
  plus a secret management token.
- `get_jam`: reads Jam state and active tracks.
- `add_track_to_jam`: idempotently resolves and appends a track.
- `remove_track_from_jam`: removes a contribution with the management token.
- `close_jam`: permanently closes a Jam to new tracks.

Only direct Spotify track URLs and Apple Music track deep-links are supported by
the backend; an Apple album URL must include a track `?i=` parameter. If a user
asks for a Jam, the agent uses the Jam tools rather than pretending a single link
is a collaborative queue. Bare albums and `spotify.link` remain unsupported. The
server instructions also prohibit treating an opposite-provider URL as a verified
match and tell agents never to reveal a Jam management token.

Create and get results use an `ok` envelope. Failures include a stable error
`code`, HTTP-style `status`, safe `message`, and `retryable` flag so agents can
decide whether to correct a request or retry it without parsing prose.

Jam additions require a caller-generated `requestKey`. Reuse the same key when
retrying the same track operation; using it for another track is rejected. A Jam
holds at most 50 active tracks and 500 lifetime contributions. Removal is soft,
closure is permanent, and both management operations are idempotent.

The checked-in production, staging, and dev Worker environments set
`JAMS_ENABLED=false`; `.dev.vars` enables it for the local Worker. The Worker also
requires a loopback request host, so setting the flag on a deployed environment
does not expose Jam data or mutation tools. Before public Jam deployment, add an
authenticated creation policy, rate limiting, create idempotency, and retention
so anonymous callers cannot exhaust permanent D1 capacity.

## Provider authorization

Local secrets belong in the git-ignored `.dev.vars` file. Apple token signing
uses `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID`,
`APPLE_MUSIC_PRIVATE_KEY_P8`, `APPLE_MUSIC_ALLOWED_ORIGINS`, and
`APPLE_MUSIC_MEDIA_ID`. The private key stays server-side; only a short-lived JWT
is returned. Each MusicKit listener still has to authorize their Apple Music
account and subscription interactively.

`SPOTIFY_CLIENT_ID` identifies the app in the browser Authorization Code + PKCE
flow. A client ID alone does not authorize server-side Spotify writes or playback;
the Spotify dashboard must also allow the exact callback and each listener must
authorize their account.

## Threads

Open `/threads/new` to create an ordered, collaborative collection. The website
owns the songs and their order. Anyone with the public sharing link can read and
add tracks; a separate private management link can reorder, remove, and close. Legacy per-Thread Apple connections permanently lock
removal and reordering; additions and closure remain available. New account
subscriptions do not lock website edits and can be unsubscribed without deleting
the provider playlist.
Closing freezes edits while leaving the songs readable. Other browsers see changes
on refresh; stale edits return 409 instead of overwriting newer state.

Run `pnpm migrate:local` after pulling this change, then `pnpm dev`. Migration
`0004` through `0006` add revisions, publication connections, and confirmed
counterpart identities to the historical D1 schema. Migration `0007` adds accounts,
sessions, OAuth state, and subscriber-owned publication rows.
Existing rows, capability digests, removed contributions, and historical positions
are preserved. Legacy Threads start at revision zero with unverified catalog
identities. The old Thread Durable Object is not restored.

`/threads` lists the Threads saved to the signed-in account and this browser's
anonymous history, with creation dates, song counts, and closed state. New creations
are recorded automatically; visiting a Thread with verified management access also
saves it. Migration `0008` adds these private history associations without guessing
owners for older rows. Older Threads can be recovered by pasting a private management
link. Public sharing links cannot establish history ownership. Anonymous history uses
an HttpOnly browser cookie; saving it across devices is an explicit signed-in action.
No raw management secret is stored in the history table or returned by its list API.

All Thread mutations require JSON, a matching `Origin`, and
`X-Listen-Action: thread`. Thread responses are private/no-store and use
`Referrer-Policy: no-referrer`; the pages disallow third-party scripts and framing.

| Route | Contract |
| --- | --- |
| `POST /api/threads` | `{title, creationKey}`; `creationKey` is a random 22-character URL-safe private capability generated before submission. Reusing it with the same title recovers the same Thread. Returns `thread`, `publicUrl`, and `managementUrl` with the secret in its fragment. |
| `GET /api/threads/:capability` | Public snapshot: title, revision, ordered contributions, closed state, and publication statuses. No management secret or digest. |
| `GET /t/:capability` | Thread page; management controls require its scoped HttpOnly cookie. |
| `POST /api/threads/:capability/contributions` | `{url, requestKey, expectedRevision}`; resolves source metadata before committing. |
| `POST /t/:capability/manage/activate` | Exchanges `{managementCapability}` for a Thread-scoped HttpOnly, SameSite=Strict cookie. HTTPS cookies are Secure. The browser removes the fragment before exchange. |
| `POST /t/:capability/manage/mutate` | Manager only: `{kind, requestKey, expectedRevision}`, with `id` for `remove`, all active `ids` for `reorder`, or `kind: "close"`. In account mode, legacy `connect` actions return 410. |
| `GET /settings` | Account onboarding/settings with independent Apple Music and Spotify connections. The former per-Thread connection page redirects here. |
| `GET /api/account` | Private connected providers and their subscriptions. Never returns credentials, provider subject, account group IDs, or publisher keys. |
| `POST /account/:provider/start` | Starts browser-bound sign-in for Spotify or Apple; accepts an optional Thread capability as `returnTo`. |
| `GET /account/:provider/callback` | Consumes expiring, single-use state and creates an HttpOnly account session after provider identity verification. |
| `POST /account/apple/prepare` | Prepares expiring, browser-bound MusicKit onboarding when signed out. |
| `POST /account/apple/token` | Returns a short-lived MusicKit developer token after validating the signed-in session binding, including when adding Apple Music to Spotify. |
| `POST /account/apple/authorize` | Verifies MusicKit permission and access to preserved destinations, then encrypts the account's music token. |
| `POST /account/sign-out` | Revokes the current website session. Existing subscriptions keep syncing. |
| `GET /api/threads/:capability/subscription` | Returns each connected provider's subscription and sync status. |
| `POST /api/threads/:capability/subscription` | Signed-in account only: `{action: "subscribe" | "retry" | "unsubscribe", provider: "apple" | "spotify"}`. Subscribe is idempotent; unsubscribe affects only that provider and preserves its playlist and destination journal. Omitted provider retains the original session provider for older clients. |
| `POST /t/:capability/manage/identify` | Manager only: `{id, url, confirmed: true, requestKey, expectedRevision}` confirms an immutable counterpart from the other music app after source URL verification. |

Mutation replies distinguish the committed receipt's revision from the current
Thread snapshot. Replaying the same request key and intent returns its receipt
without another mutation, even after removal or closure. Reusing a key for another
intent returns 409. The client retains an interrupted request in per-tab session
storage for retry and clears it on success. Save the private management link when
creating a Thread; sharing it also shares management access.

Each accepted mutation atomically updates songs, a monotonically increasing
revision, its replay receipt, and both requested publication revisions. The D1
batch claims a revision with `UPDATE … RETURNING`; D1 `meta.changes` also counts
trigger writes and is not a reliable one-row claim check. Reorders change the new
sort order while preserving historical contribution positions. Limits are 50
active songs, 500 lifetime contributions, and 2,000 mutations per Thread; creation
is capped at 10,000 Threads. These limits do not replace deployment abuse controls.

### Downstream publication boundary

`D1ThreadStore.getDesiredState(capability, provider)` returns one consistent
snapshot: website revision/order, every contribution, provider-specific identity
resolution, and publication status. A source track establishes only its own service's
identity. Before publishing, a private matching step looks for the counterpart by
International Standard Recording Code (ISRC), when available. If that finds no
compatible candidate, it searches by title and artist. It checks recording version, duration,
content ratings, and destination playability. Equivalent releases sharing an ISRC
are grouped; a clear result is selected automatically. Ambiguous results remain
unresolved. The frontend presents one unified song entry without provider match links or manual
matching controls. The management API still supports confirmed links for compatibility; it
verifies the catalog URL, while the manager verifies the recording.
Manual confirmations remain immutable. Unverified legacy sources stay unresolved.
Missing identities block the entire provider snapshot, preserving duplicates and order.

Automatic evidence lives in `automatic_track_matches` (migration `0010`), separately
from manual confirmations and source links. Each subscriber destination retains its
own accepted catalog IDs across retries and website revisions; manual confirmations
take precedence. Matching does not change website revisions. Each alarm attempts
matching for at most five uncached contributions, with later alarms continuing the batch.
Uncertain results are reused within a revision; an explicit sync retry searches them
again. Accepted IDs are retained so Apple append journals and retry receipts stay stable.

Metadata matching currently requires normalized title and artist agreement and a
duration difference of at most the smaller of 3 seconds and 2%. Explicit and clean
conflicts are rejected. Apple's unrated songs can match Spotify's nonexplicit songs;
missing Spotify rating information requires review. These thresholds are conservative
initial choices, not a measured accuracy guarantee. Search is bounded to 25 Apple or
10 Spotify results. Matching uses the Apple subscriber's stored storefront; Spotify's
user token determines availability, taking priority over the fallback US market.

Apple catalog reads use an app developer token. Spotify catalog reads use the
subscriber's Spotify grant, including their own linked Spotify connection when
matching into Apple. Apple-only listeners fall back to public Spotify track metadata
and Apple catalog search. No contributor is required to connect both services.

Publication status includes `connected`, `requestedRevision`, `appliedRevision`,
`pending | blocked | failed | synced`, `blockedReason`, `failureCode`, and verified
playlist ID/URL. Each connected provider has an independent destination per Thread. Migration
`0007` queues connected subscribers whenever the Thread revision advances. Subscribing
does not change the Thread revision or grant management rights. Legacy per-Thread
Apple connections retain their existing edit restriction; new personal subscriptions
do not lock website edits. A removal or reorder can therefore block an Apple copy,
whose provider adapter only supports exact suffix additions.
- [ ] Investigate Apple Music playlist updates after song reordering or deletion. Spotify already applies the full ordered snapshot; Apple currently supports exact suffix additions only. Prove a safe update path with actual provider readback, including retries and duplicate songs, before changing the adapter.

An old successful readback cannot mark a newer Thread revision synced.

A private `ThreadPublisher` Durable Object serializes each destination through its
alarm. D1 publication rows act as an outbox; request completion wakes pending work,
and a scheduled sweep recovers work missed between commit and wakeup. Provider
markers use private random destination keys, never Thread capabilities. No public
route accepts destination IDs or publication reports. Account-token handoff requires a matching signed-in account or a valid browser-bound Apple onboarding grant.
A separate account Durable Object serializes credential refresh and replacement
across all of that account's subscriptions.

Spotify creates one public playlist and replaces its contents to apply additions,
removal, and order. Apple creates one public playlist and only appends an exact
suffix. Both require provider readback before reporting success. An ambiguous
creation is fenced to avoid duplicate playlists. Apple recovers an uncertain append
only when readback establishes the exact intended list; it never blindly re-appends.
Unexpected Apple playlist edits require attention rather than replacement or removal.

### Song attribution and profiles

New contributions record the signed-in account on the server. Public Thread views
expose only the contributor's display name and optional photo, never account IDs,
provider subjects, or credentials. The author stays fixed through retries, reorders,
and removal. Profile edits update existing bylines without changing song order or
publication revisions. Historical and signed-out contributions have no recorded author;
the interface labels them Guest rather than guessing who added them.

Account settings include an editable display name and a photo upload picker. JPG, PNG, and WebP
files up to 10 MB are converted locally to a 192×192 PNG before saving.
Spotify seeds these from its authenticated profile API; existing connected users are
imported when they open settings. A failed import leaves settings usable and is retried
at most hourly. Apple Music's supported API does not expose a user name or photo, so
Apple-only profiles start as Listener. Linking Spotify can seed an untouched profile;
a user-edited profile is never overwritten by a provider reconnect or import. Linked
providers share one profile, with the anchor account's edits taking precedence.

`GET /api/account` includes `profile` and a short-lived `profileBinding`.
`POST /api/account/profile` accepts `{displayName, avatarUrl, profileBinding}` for
existing or removed photos, or `{displayName, avatarImageBase64, profileBinding}`
for uploads, and
requires the same signed-in session that loaded the form. Names contain 1–80 characters;
uploads are bounded to 192 KiB and 256×256 pixels, stored with the profile in one
D1 transaction, and served as PNG with no sniffing or caching. Migration `0012` adds
photo storage; provider-seeded HTTPS photos remain supported. Migration
`0011_song_attribution.sql` is additive and must be applied before the updated Worker.

### Publisher configuration

Production and staging enable `ACCOUNT_SUBSCRIPTIONS_ENABLED`, `MUSIC_ACCOUNT_CONNECTIONS_ENABLED`,
and both publishing flags; dev keeps all four disabled. App
configuration does not preauthorize any person.
Existing research sessions and per-Thread credentials are not imported into accounts.

| Provider | Worker secrets |
| --- | --- |
| Spotify | `SPOTIFY_CLIENT_ID`, `PUBLISHER_ENCRYPTION_KEY` |
| Sign in with Apple (optional) | `APPLE_SIGN_IN_CLIENT_ID`, `APPLE_SIGN_IN_KEY_ID`, `APPLE_SIGN_IN_TEAM_ID`, `APPLE_SIGN_IN_PRIVATE_KEY_P8` |
| Apple Music library | `APPLE_MUSIC_KEY_ID`, `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_PRIVATE_KEY_P8`, `PUBLISHER_ENCRYPTION_KEY` |

Apple Music onboarding calls MusicKit directly using the existing MusicKit app
credentials. It establishes a signed-in browser account only after the backend validates
library permission. A long-lived HttpOnly browser capability identifies this local
account; a Music User Token is a library grant, never a stable Apple identity. Returning
in the same browser reuses the account and its playlist journals, even after sign-out.
Clearing site cookies loses browser-only access; different browsers create separate
Apple accounts unless the user signs in through a linked Spotify account. Spotify
uses its verified provider identity across devices.

Migration `0009` adds account groups, initially placing each existing provider account
in its own group without replacing identities, credentials, subscription destinations,
or history. Connecting the second service
requires its authorization and the initiating website session to remain valid. Each
group permits one Apple connection and one Spotify connection; an account already
linked to another group cannot be moved. Signing in through either member restores
access to the group's connections and history. Connecting a service does not subscribe
it to existing Threads automatically.

Apple browser grants are expiring and single-use, bound to the browser that prepared
MusicKit. Sign-out invalidates outstanding onboarding grants and prevents an in-flight
onboarding request from establishing a session. Existing account reconnects retain the session-bound grant checks.
The optional Sign in with Apple code path still requires its separate Services ID and
sign-in key, but those credentials are not required to try Apple Music. A provider's
identity cannot be replaced by reconnecting with a different provider account.

Enabling publishing in production requires the Spotify redirect URI
`https://listen.cx/account/spotify/callback` to be registered for the configured Spotify
app and the provider secrets above. Deploying the current Worker requires all D1
migrations through `0013_publication_rate_limits.sql` first.
Migration `0013` preserves catalog rate-limit deadlines across Thread edits and retries.
The account routes, including `/settings`, require `ACCOUNT_SUBSCRIPTIONS_ENABLED`.
Run the fail-fast rollout manually with `pnpm migrate:production && pnpm deploy:production`;
this repository forbids agent-executed production deployments.

The encryption key is base64 encoding of 32 random bytes; preserve it across
releases. Account credentials are encrypted in D1 with account-specific authenticated
data. Provider subjects and session hashes never appear in public responses. Spotify
refresh-token rotations are serialized and persisted before use. There is no fallback
to shared publisher credentials for a personal subscription. Reauthorization cannot
change the Spotify identity; Apple reauthorization checks preserved playlist journals
and editable destinations, including unsubscribed copies.

Staging reuses the registered `https://staging.listen.cx/auth/callback` Spotify URI.
The separate staging authorization Worker forwards `account.` states to
`/account/spotify/callback` and legacy `threads.` states to
`/connections/spotify/callback`. Account mode replaces the old connection flow;
old authorization attempts must restart from settings. Deploy the routing update before enabling account
mode. The product validates encrypted state, expiry, a browser-bound cookie, and
single-use consumption before exchanging a code. Account sessions use Secure,
HttpOnly, SameSite=Lax cookies on HTTPS; all mutations require same-origin JSON actions.
The settings page alone permits MusicKit's external script and connections. Callback
URLs are excluded from invocation logs and traces in staging.

Provider readback is required before reporting a personal playlist synced. Background
publishing updates the playlist; browser polling refreshes the displayed sync status
without a page reload. Cross-provider matching runs before publication. If no confident
match is found, the copy pauses and reports that some songs could not be matched.
Refresh the song list to see matching results or retry sync to search again. Apple copies support additions; removing/reordering website songs or
editing the provider playlist can pause their sync. Unsubscribe stops future work;
an already running provider request may still complete. Resubscribing reuses the
existing destination rather than making a new playlist.


## Retained code

- `src/urls.ts`: track URL parsing and provider URL builders.
- `src/spotify.ts`: public oEmbed and embed metadata lookup.
- `src/itunes.ts`: Apple lookup, catalog search, and public-page metadata fallback.
- `src/fetch.ts`: bounded retries and per-attempt timeouts.
- `src/resolve.ts`: source-provider metadata for short links.
- `src/music-catalog.ts`, `src/track-matching.ts`: bounded catalog reads and deterministic matching.
- `src/automatic-matching.ts`: durable per-destination matches before publication.
- `src/jam.ts`, `src/jam-db.ts`, `src/jams.ts`: capability-secured Jam domain,
  preserved D1 storage, and actions.
- `src/apple-music-auth.ts`: origin-bound MusicKit developer-token signing.
- `src/db.ts`, `src/app.ts`, `src/worker.ts`: D1 storage and API.
- `src/recipient.ts`: negotiated recipient HTML with escaped metadata.
- `public/`: landing page, create controller, and shared visual styles.

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

`pnpm test` also connects a real MCP SDK client over the Worker's Streamable HTTP
transport, creates and reads a link, and exercises a complete Jam lifecycle
against test D1.

The live checks assert known Spotify titles and artists, Apple lookup and search
in US/GB storefronts, and the Apple page fallback. They are separate from offline
regression tests because availability and catalogs change. Passing a sample is
not a guarantee for every track or future provider response. During the restart,
all five live checks and local Worker create/read flows for both providers passed.
One initial Spotify request timed out; the next live run passed.

## Existing deployments and data

The restart and Threads integration were deployed to `staging.listen.cx` on
September 12, 2026. A subsequent deployment enabled personal account connections
and both provider publishing flags; no personal account is connected by default.
Account settings and subscriber-owned playlists were deployed to staging on
September 12, 2026 (version `574e154c-9bd0-4080-b30a-023456e082ab`), after a fresh
database export and migration `0007`. The UI and Spotify sign-in redirect were
checked in the live browser; the account/subscription change passed 435 offline tests.
That rollout did not include personal subscription readback. Apple sign-in
was unavailable: the checked Doppler `listen-cx` configs (`dev_personal`, `stg`)
contain MusicKit credentials, but not the separate Sign in with Apple credentials.
Direct MusicKit onboarding was subsequently deployed to staging (version
`75206045-4c1e-466a-8341-4c9c794f74fd`). Its 50 focused tests and typecheck passed,
and the live settings page enabled Apple Music after SDK preparation. The embedded
browser did not expose an authorization window, so that check did not verify user
consent or personal subscription readback.
Dual-provider connections were deployed after a fresh staging export and migration
`0009` (version `c82892f0-976d-4098-b0fe-16add9b6182c`). Ninety focused tests and
typecheck passed, including both connection directions, independent subscriptions,
session revocation, and history preservation. Live settings and Thread pages show both
providers; simultaneous personal playlist readback still requires user authorization.
Automatic matching was deployed with migration `0010` (version
`3ef5acfc-62e7-4dce-bb42-2b106eab92a2`). The change passed 179 focused tests and
typecheck. The first migration request failed with Cloudflare authorization code
7403, but the Worker upload proceeded; the migration then succeeded on retry. Future
migration/deployment sequences must stop on any failed command to avoid that window.
Live verification found both Apple-origin songs in `omartest3` by ISRC and confirmed
its Spotify subscription at revision 2 through provider readback. The public Spotify
playlist independently showed AMAZING followed by Lay It on Me; the existing Apple
subscription remained synced at revision 2. A separate six-song read-only check of
Spotify public metadata against Apple catalog search selected five counterparts and
left one ambiguous. This is smoke evidence, not a measured accuracy benchmark.

Migrations `0004`–`0006` were also applied after exporting staging. Production has
not been redeployed. Historical D1 migration files remain unchanged; no remote
rows have been deleted. Existing source metadata retains its original values,
including any old inferred cross-provider URLs. Those values have not been
reverified, and the API does not certify them as matches. When both URLs are
present, the recipient page cannot identify the original source and offers only
provider searches, regardless of the historical `complete` flag. It ignores
invalid provider URLs. Existing JSON rows and D1 migrations remain unchanged.

The Worker exports a new `ThreadPublisher` Durable Object for background publishing.
Production and staging preserve the retired `ThreadLive` namespace's original `v1`
migration and class registration before creating `ThreadPublisher`, while leaving it
unbound from the application. The shared compatibility class returns 410 and consumes
old alarms without sending notifications or touching stored values. Its regression
test verifies that request and alarm handling leave stored values intact. The old live
Thread implementation is not restored, and no namespace deletion is scheduled.
Production commands must be run by Omar. Browser requests now receive recipient HTML;
JSON consumers retain the stored-row contract described above.
