# listen.cx

A TypeScript Worker for Spotify and Apple Music track metadata, stored short
links, and a small web frontend. Paste a direct track link at `/` to create a
shareable URL with its real title, artist, and artwork. Albums and `spotify.link`
short URLs are not supported. Apple album URLs must include a track's `?i=` ID.

The recipient page opens the original provider URL and offers a clearly labeled
search on the other app. No app preference is saved. Threads collect ordered songs
collaboratively. A Thread's manager can authorize Spotify or Apple Music from
**Connect music apps**, then explicitly start syncing to that account's playlist.
Each Thread stores its own encrypted authorization. Actual provider readback is
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

`SPOTIFY_CLIENT_ID` is available for a future browser Authorization Code + PKCE
flow. A client ID alone does not authorize server-side Spotify writes or playback;
the Spotify dashboard must also allow the exact callback and each listener must
authorize their account.

## Threads

Open `/threads/new` to create an ordered, collaborative collection. The website
owns the songs and their order. Anyone with the public sharing link can read and
add tracks; a separate private management link can connect music apps, confirm
recording matches, reorder, remove, and close. Connecting Apple Music locks removal
and reordering for the entire Thread; additions and closure remain available.
Spotify-only Threads retain full editing. Connections cannot currently be removed.
Closing freezes edits while leaving the songs readable. Other browsers see changes
on refresh; stale edits return 409 instead of overwriting newer state.

Run `pnpm migrate:local` after pulling this change, then `pnpm dev`. Migration
`0004` through `0006` add revisions, publication connections, and confirmed
counterpart identities to the historical D1 schema.
Existing rows, capability digests, removed contributions, and historical positions
are preserved. Legacy Threads start at revision zero with unverified catalog
identities. The old Thread Durable Object is not restored.

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
| `POST /t/:capability/manage/mutate` | Manager only: `{kind, requestKey, expectedRevision}`, with `id` for `remove`, all active `ids` for `reorder`, `provider` for `connect`, or `kind: "close"`. Connection requires an enabled provider and this Thread's authorized account. |
| `GET /t/:capability/manage/apps` | Manager-only account connection screen; authorization alone does not start a new playlist. |
| `POST /t/:capability/manage/apps/spotify/start` | Starts browser-bound Spotify PKCE authorization. The callback stores verified credentials; the manager separately starts sync. |
| `POST /t/:capability/manage/apps/apple/token` | Returns a short-lived app developer JWT to the authorized management page. No private signing key is returned. |
| `POST /t/:capability/manage/apps/apple/authorize` | Accepts the normal MusicKit authorization result, verifies personalized access from the backend, then encrypts the token for this Thread. |
| `POST /t/:capability/manage/retry` | Manager only: `{provider}` retries an enabled, connected publication without changing Thread revision or bypassing retry deadlines. Also works after closure. |
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
identity. Managers may explicitly confirm a counterpart link for the same recording;
the API verifies that the URL names a real catalog track, while the manager is
responsible for choosing the correct recording. Confirmations are immutable.
Legacy identities remain unresolved. Missing identities block the entire provider
snapshot, preserving duplicates and order instead of silently omitting songs.

Publication status includes `connected`, `requestedRevision`, `appliedRevision`,
`pending | blocked | failed | synced`, `blockedReason`, `failureCode`, and verified
playlist ID/URL. Connecting a provider is a revisioned, replayable management action.
The Apple edit restriction is enforced in the same D1 transaction as revision claims.
An old successful readback cannot mark a newer Thread revision synced.

A private `ThreadPublisher` Durable Object serializes each destination through its
alarm. D1 publication rows act as an outbox; request completion wakes pending work,
and a scheduled sweep recovers work missed between commit and wakeup. Provider
markers use private random destination keys, never Thread capabilities. No public
route accepts destination IDs or publication reports. Account-token handoff is
restricted to the manager-authorized Apple connection endpoint.

Spotify creates one public playlist and replaces its contents to apply additions,
removal, and order. Apple creates one public playlist and only appends an exact
suffix. Both require provider readback before reporting success. An ambiguous
creation is fenced to avoid duplicate playlists. Apple recovers an uncertain append
only when readback establishes the exact intended list; it never blindly re-appends.
Unexpected Apple playlist edits require attention rather than replacement or removal.

### Publisher configuration

Staging enables `MUSIC_ACCOUNT_CONNECTIONS_ENABLED` and both provider flags.
The base and dev configurations leave publishing disabled. Authorization controls
require the corresponding flag and app credentials; no user account token is
preconfigured. Existing research authorization sessions are not imported.

| Provider | Worker secrets |
| --- | --- |
| Spotify | `SPOTIFY_CLIENT_ID`, `PUBLISHER_ENCRYPTION_KEY` |
| Apple Music | `APPLE_MUSIC_KEY_ID`, `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_PRIVATE_KEY_P8`, `PUBLISHER_ENCRYPTION_KEY` |

The encryption key is base64 encoding of 32 random bytes. Credentials are encrypted
with destination-specific authenticated data inside each private publisher object;
Spotify refresh-token rotations are persisted before use. Preserve this encryption
key across deployments. Personal-account mode never falls back to the old shared
publisher secrets. Switching an established Spotify account is rejected; Apple
reconnection must retain access to the existing editable destination. An ambiguous
Apple creation stays fenced. Revoked Apple authorization requires reconnecting.

Staging reuses the registered `https://staging.listen.cx/auth/callback` URI. The
existing authorization Worker forwards only `threads.`-prefixed OAuth states to
`/connections/spotify/callback`; old research callbacks retain their own handler.
The product validates encrypted state, expiry, a browser-bound cookie, and a
single-use nonce before exchanging the code. A same-site landing document restores
the Strict management-cookie context before returning to the connection screen.
Other environments must register their exact configured `SPOTIFY_REDIRECT_URI`
or the default `/connections/spotify/callback` URL.

Only the management authorization HTML permits MusicKit's script and connections
and sends `Referrer-Policy: strict-origin`, which Apple's popup callback needs.
APIs retain `no-referrer` and `no-store`. Staging disables request tracing to avoid
recording OAuth callback queries. User tokens never enter HTML, URLs, or app browser
storage. Use Worker secrets in deployed environments and ignored `.dev.vars` locally.

Live acceptance requires creation and a later update through the product runtime,
with exact readback of the same playlist. Apple's connection endpoint first checks
backend token acceptance without a playlist write; only **Start syncing** creates
a destination. Apple's permanent addition-only restriction remains enforced in D1.
The prior isolated Spotify and foreground Apple proofs are not substitutes for
product-runtime verification or saved-listener propagation tests.

## Retained code

- `src/urls.ts`: track URL parsing and provider URL builders.
- `src/spotify.ts`: public oEmbed and embed metadata lookup.
- `src/itunes.ts`: Apple lookup, catalog search, and public-page metadata fallback.
- `src/fetch.ts`: bounded retries and per-attempt timeouts.
- `src/resolve.ts`: source-provider metadata only; no match guessing.
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
September 12, 2026, with both provider publishing flags disabled. Migrations
`0004`–`0006` were applied after exporting the staging database. Production has
not been redeployed. Historical D1 migration files remain unchanged; no remote
rows have been deleted. Existing source metadata retains its original values,
including any old inferred cross-provider URLs. Those values have not been
reverified, and the API does not certify them as matches. When both URLs are
present, the recipient page cannot identify the original source and offers only
provider searches, regardless of the historical `complete` flag. It ignores
invalid provider URLs. Existing JSON rows and D1 migrations remain unchanged.

The Worker exports a new `ThreadPublisher` Durable Object for background publishing.
Staging uses `src/worker-staging.ts` to retain the existing `ThreadLive` namespace
and its original `v1` migration before creating `ThreadPublisher`. That compatibility
class returns 410 and consumes old alarms without sending notifications or touching
stored values; the application has no binding to it. Its regression test verifies
storage preservation. The old live Thread implementation is not restored.
Other existing installations still require a deliberate Durable Object migration
decision before redeployment; no namespace deletion is scheduled. Production
commands must be run by Omar. Browser requests now receive recipient HTML; JSON
consumers retain the stored-row contract described above.
