# Spotify shared-publisher spike

Started September 9, 2026; parity assessment updated September 12. Branch: `omar/spotify-publishing-spike`.

The isolated HTTPS staging publisher is deployed and ready for friend OAuth; local and staging contract tests pass. **No authenticated Spotify playlist write/readback or second-account Spotify experiment has run.** The website remains authoritative; this spike creates one public publisher-owned playlist per opaque website playlist key. Listeners save that shared playlist inside Spotify. Their accounts never authorize this harness.

## Evidence and remaining gates

| Proof layer | Result |
| --- | --- |
| Publisher contract with simulated Spotify responses | 23 passing tests at the September 10 checkpoint |
| Two-phase operator runner with simulated control responses | 10 passing tests at the September 10 checkpoint |
| Real loopback HTTP with simulated Spotify responses | 15 passing tests, including OAuth, explicit publisher confirmation, safe failure diagnostics, refresh and process-state restart |
| Type checks | Spike TypeScript project and root `pnpm typecheck` pass |
| Actual app mode, Premium and publisher allowlist | Not inspected; configuration is explicitly operator-reported |
| Staging Worker-runtime contracts | 15 passing tests with simulated provider responses |
| Actual staging HTTPS security checks | 20 passed after staging callback routing; homepage unchanged |
| Authenticated Spotify create/update and readback | Pending friend publisher consent and operator confirmation |
| Listener outside OAuth allowlist saving and observing edits inside Spotify | Not run; second account and app access required |

Initially no Spotify credentials were available. Omar subsequently added `SPOTIFY_CLIENT_ID` to Doppler `listen-cx/dev_personal`; a non-logging subprocess confirmed its presence. The first OAuth attempt failed on dashboard redirect matching. After the callback was corrected, consent reached token exchange, but the subsequent `/me` request failed. The first harness discarded the original status/body; a subsequent attempt preserved the actual 403 allowlist rejection, documented below. Publisher identity and dashboard mode remain unverified. No production deployment or existing playlist mutation occurred.

Test-first evidence: initial publisher and harness tests failed because their implementation modules did not exist. After implementation, 16 publisher and 7 HTTP tests passed. The recovery contract then failed with `recoverCreate is not a function`; its HTTP test failed with expected 409 versus actual 404. Both passed after implementation. The discovered-identity setup test then failed with `missing_configuration`; it passed after adding explicit confirmation, including rejection of unconfirmed writes. After the live OAuth failure exposed discarded `/me` diagnostics, five more tests failed against the old status/error mapping and passed after preserving status and redacted provider fields. That checkpoint had 35 passing tests; the later readback/runner checkpoint has 48 Node tests plus 15 Worker tests. The readback tests also cover changing snapshots, missing items, and relinked track IDs without claiming equivalence.

```sh
pnpm exec vitest run --config spikes/spotify-publisher/vitest.config.ts
pnpm exec tsc -p spikes/spotify-publisher/tsconfig.json
pnpm typecheck
```

A separate Node process startup smoke also served an authenticated `/status` request successfully, reporting `authorized: false` and no destinations; it made no provider requests. The dedicated Node configuration runs the harness tests. They must not run in the root Cloudflare Worker test pool.

## Publisher setup

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create/select the actual app, and inspect **App Status** in Settings. Record the mode and date; do not infer an exemption from an existing client ID. In development mode the app owner needs Premium, and the publisher must be in Settings → Users Management. The listener account for the acceptance test must remain outside that list. [Official quota-mode rules](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
2. Register this exact redirect URI: `http://127.0.0.1:8789/auth/callback`. Spotify permits HTTP for explicit loopback IPs, not `localhost`. [Redirect rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
3. Configure the following values, preferably in Doppler. PKCE needs the **Client ID only; no client secret**. The scope is `playlist-modify-public`. The harness verifies the expected publisher account before enabling writes. With no configured publisher ID, OAuth discovers it and a separate control-authorized confirmation binds it. [PKCE documentation](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow).

| Environment variable | Value |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | Dashboard Client ID |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8789/auth/callback` (default) |
| `SPOTIFY_PUBLISHER_ID` | Optional publisher Spotify ID/username; otherwise discover during OAuth and confirm |
| `SPOTIFY_SPIKE_CONTROL_TOKEN` | Random local API secret of at least 32 characters |
| `SPOTIFY_APP_MODE` | Optional at startup; `development` or `extended-quota` after dashboard inspection, required before writes |
| `SPOTIFY_SPIKE_STATE_DIR` | Optional private local directory; default `~/.local/state/songlink/spotify-publisher` |

Use Node 22.18+ or Node 24+ with native TypeScript stripping. Verified locally with Node 25.8.1. Generate a local control secret without printing it, or store an independently generated value in Doppler:

```sh
export SPOTIFY_SPIKE_CONTROL_TOKEN="$(openssl rand -hex 32)"
doppler run --project listen-cx --config dev_personal -- node spikes/spotify-publisher/run.ts
```

The prepared local session is already listening on port 8789. Its generated control token is stored privately at `~/.local/state/songlink/spotify-publisher/control-token`. To control that existing process, load that token instead of generating a different one:

```sh
export SPOTIFY_SPIKE_CONTROL_TOKEN="$(cat ~/.local/state/songlink/spotify-publisher/control-token)"
```

Keep the process running. In another terminal with the same control secret injected, request authorization:

```sh
curl -sS -X POST http://127.0.0.1:8789/auth/start \
  -H "Authorization: Bearer $SPOTIFY_SPIKE_CONTROL_TOKEN"
```

Open the returned `authorizationUrl` in a browser **on the machine running the harness**, then sign in as the configured publisher and grant consent. Sending this loopback authorization URL to someone browsing on another machine will not complete authorization into Omar's harness. A collaborator can run their own local harness, or a later integration must provide an explicitly configured HTTPS callback. Tokens remain server-side and are never returned in the callback or control API. Authorization does not create a playlist. If identity or mode was not configured, the callback returns `candidatePublisherId` with `confirmationRequired: true`. Inspect the ID and the actual app's dashboard mode, then confirm from the control terminal:

```sh
curl -sS -X POST http://127.0.0.1:8789/auth/confirm \
  -H "Authorization: Bearer $SPOTIFY_SPIKE_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"publisherId":"<discovered ID>","appMode":"development"}'
```

Use `extended-quota` only if that is the dashboard-observed mode. Before confirmation, publishing returns 401. Unconfirmed OAuth tokens exist only in process memory; restart requires authorizing again. Confirmed identity and mode persist in `binding.json`; tokens persist in `tokens.json`. OAuth links expire after ten minutes; request `/auth/start` again for a new one.

A collaborator serving as the outside-allowlist listener needs only the eventual Spotify playlist link, their independent account, and the Spotify app. They do not need developer credentials, this harness, or an OAuth authorization link.

## Acceptance experiment

Select four available Spotify tracks A, B, C and D and copy their 22-character track IDs. Use a new key such as `acceptance-20260909-omar`; **never reuse a state directory or playlist key from an unrelated experiment**. Create `desired.json` locally with real IDs:

```json
{"playlistKey":"acceptance-20260909-omar","revision":1,"trackIds":["<A: 22-character ID>","<B: 22-character ID>","<C: 22-character ID>"]}
```

```sh
curl -sS -X PUT http://127.0.0.1:8789/desired \
  -H "Authorization: Bearer $SPOTIFY_SPIKE_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @desired.json
```

Record the returned provider playlist ID, applied revision and URL. A successful result follows exact ordered API readback bracketed by an unchanged playlist snapshot. Have the listener open this URL **inside Spotify**, save the playlist, and record `[A,B,C]`. Then edit the same JSON to revision 2 and track IDs `[C,A,D]`, submit it again, and verify:

- The response contains the same playlist ID and applied revision 2.
- Publisher API readback has exactly `[C,A,D]`, with B removed.
- The listener's saved playlist retains the same URL/ID and shows `[C,A,D]` after refresh/reopening. Record the account's outside-allowlist status, timestamps, device/app version and observed delay.

Keep API proof and listener screenshots/observations separate. Repeat revision 2 unchanged (no provider request), revision 1 (409), a new duplicate-containing revision, and an empty revision on this same spike playlist. An empty list replaces its contents with `[]`; it does not delete the playlist.

## Experimental contract and recovery

`PUT /desired` accepts `{playlistKey, revision, trackIds}`. Revisions are positive increasing safe integers. Same revision with changed content and stale revisions return 409. Track IDs are ordered and duplicates are preserved. This spike caps a desired list at 1,000 tracks. Its state includes provider playlist ID, highest requested revision, applied revision and unresolved-create intent. Keys and provider IDs are identifiers; the control bearer token authorizes local requests, while Spotify OAuth authorizes provider access.

The API creates through `POST /me/playlists`, replaces the first 100 entries with `PUT /playlists/{id}/items`, and appends remaining batches of up to 100 using `POST .../items`. It reads pages of 50 using the current `item` response property. The documented `track` examples in field-filter prose are inconsistent with that current schema, so the spike requests the full response. [Create](https://developer.spotify.com/documentation/web-api/reference/create-playlist), [replace](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items), [append](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist), [read](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).

The existing metadata retry helper retries network failures and 5xx, so it is deliberately not reused for writes. Each provider request has a ten-second timeout. 401/403 stop without retries. 429 persists a retry deadline, returns `Retry-After`, and requires a later explicit request. Readback mismatch gets three bounded observations and never advances the applied revision.

Create intent is persisted before its POST. A network failure, 5xx, invalid response or crash can leave `createUnresolved=true`; later requests refuse another create. Inspect the publisher's Spotify app for the newly created `listen.cx SPIKE <key>` playlist. Once identified, submit its ID:

```sh
curl -sS -X POST http://127.0.0.1:8789/recover-create \
  -H "Authorization: Bearer $SPOTIFY_SPIKE_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"playlistKey":"acceptance-20260909-omar","providerPlaylistId":"<22-character playlist ID>"}'
```

Recovery reads and verifies ownership, public status and the unique description marker saved before creation. It does not mutate the playlist or mark the revision applied. Resubmit the desired state afterward. If no matching playlist can be identified, leave the create unresolved; do not erase state to retry blindly.

Ambiguous item writes stop immediately. An explicit retry starts from full replacement, never from replaying the failed append. This requires one active publisher and no manual playlist editing; it is not a transactional Spotify write. Multi-batch playlists can temporarily expose partial contents, and a timed-out provider request could still finish later. API readback proves the observed snapshot at that time, not eventual listener propagation. Regional relinking and unavailable items fail exact-ID verification instead of claiming a match.

Each destination serializes requests; a concurrent call gets 409 `busy` and must be retried. A process lock prevents two harnesses from sharing state. After an unclean exit, verify the PID recorded in `publisher.lock` is no longer running before removing only that stale lock. Preserve `destinations.json`, `binding.json` and `tokens.json`; deleting destination state removes duplicate-create protection. The private state directory is bound to one client ID and, after confirmation, one publisher ID. `appliedRevision` records the last verified revision; a failed newer multi-batch attempt can leave partial contents while that older revision remains recorded.

The spike adds no website routes, accounts, membership, queues, D1 tables or deployment configuration. The production Worker does not import it. Later integration needs durable execution and operational recovery decisions after the live acceptance gates pass.

## Live OAuth diagnostic follow-up

The callback's `publisher_verification_failed` occurs after successful token exchange but before publisher-ID comparison, when `/v1/me` returns a non-success status. The original implementation incorrectly collapsed all such failures into 403 and discarded the response. This was a diagnostic bug; it does not establish the cause of Spotify's rejection.

The harness now returns the real provider status plus bounded, credential-redacted `status`, `errorStatus`, `message` and `reason` fields. Authenticated `GET /status` retains the latest verification failure in process memory. A regression checks 401, 403, 429, 503 and plain-text errors, and verifies tokens are absent from both responses. No OAuth scope was changed speculatively. The local harness was restarted with private state intact and a fresh same-machine consent link issued to capture actual provider evidence.

## Isolated HTTPS staging deployment

Initially deployed September 9, 2026 at 22:04 PDT; updated at 22:34 PDT to reuse the registered staging callback and at 22:42 PDT to fix native browser form navigation. The service is [listen-cx-spotify-spike-staging](https://listen-cx-spotify-spike-staging.omar-alhait.workers.dev/health), version `74b12625-b8f2-4880-8d92-4ce686ee8a3b` (September 10 readback update). It has its own SQLite Durable Object. Only the isolated Worker was deployed; the website Worker, D1 database and existing `staging.listen.cx` custom-domain binding were preserved. Three narrow HTTPS routes (`/auth/invite*`, `/auth/start*`, `/auth/callback*`) on `staging.listen.cx` forward the OAuth flow to the spike. Production routes and the production callback were untouched. The local publisher state and harness remain intact.

**Existing registered dashboard callback now served by the spike:**

```text
https://staging.listen.cx/auth/callback
```

The second local consent attempt established the actual failure: `/me` returned 403 with “The user is not registered for this application.” Omar's account could grant consent but lacked access to the friend's app. We did not broaden scopes speculatively. The remote friend who owns the Premium app can now complete consent on their own machine. The callback uses `id` for comparison with Spotify playlist `owner.id`; this is not a website account-linking system.

### Friend handoff

1. The friend reports the dashboard's actual App Status and uses the intended publisher account. The callback above is already reported registered; no new callback entry is needed. The existing local 403 demonstrates why consent alone is insufficient.
2. The operator creates a fresh invitation on the staging browser origin. It expires in ten minutes. GET displays an inert page; chat/mail previews and repeat GETs do not consume it.
3. The friend opens the invitation, clicks **Continue with Spotify**, and accepts Spotify consent as the intended publisher. The HTTPS callback works on their own device. Keep using that browser through the redirect.
4. The operator checks the discovered candidate through the protected status endpoint and confirms the exact candidate ID, publisher ID, and dashboard-observed mode. Publishing stays disabled before that confirmation.

The listener test still requires a separate account outside the OAuth allowlist. That listener only saves the resulting playlist inside Spotify and never receives this publisher invitation.

### Operator controls and secret handling

The staging-only operator token and AES-GCM encryption key were generated privately and stored at `~/.local/state/songlink/spotify-publisher-staging/secrets.json`. This file also contains the Client ID injected from Doppler. Its mode is 0600 and its parent directory is 0700. Values were not printed, committed, or placed in the friend invitation. The deployment uploads them as secret bindings. Preserve the encryption key; replacing it without migrating existing envelopes makes stored credentials unreadable.

| Endpoint | Authorization and effect |
| --- | --- |
| `GET /health` | Public, static staging health only |
| `POST /control/invitations` | Operator bearer; creates a ten-minute invitation, superseding any previous pending flow/candidate |
| `GET /auth/invite?ticket=…` | Expiring capability; inert page and HttpOnly browser nonce cookie |
| `POST /auth/start` | Canonical Origin and matching cookie/form nonce; atomically consumes ticket and begins PKCE |
| `GET /auth/callback` | One-use OAuth state plus Secure HttpOnly host cookie; exchanges code, verifies `/me`, saves encrypted candidate |
| `GET /control/status` | Operator bearer; safe candidate/destination/failure metadata only |
| `GET /control/readback?playlistKey=…` | Operator bearer; fresh provider contents between matching snapshot IDs, without changing the playlist |
| `POST /control/confirm` | Operator bearer; `{candidateId,publisherId,appMode}` explicitly binds the pending publisher |
| `PUT /control/desired` | Operator bearer; same desired-state contract as the local harness |
| `POST /control/recover-create` | Operator bearer; same guarded ambiguous-create recovery as local |

The landing page has no scripts or third-party assets. Responses use `no-store` and restrictive CSP. The invitation HTML uses `Referrer-Policy: same-origin`; all other responses, including the Spotify redirect, use `no-referrer`. Its form policy permits only the same origin and `https://accounts.spotify.com`. Browser invitation/start/callback requests must use `https://staging.listen.cx`, so both host cookies remain on the callback host. Controls and health accept only the isolated `workers.dev` origin. Control endpoints provide no CORS grants and reject cross-origin requests; they are not routed through the main staging hostname. Tokens and PKCE verifiers use authenticated encryption with purpose/client binding before entering durable storage. Candidates, OAuth flows and invitation claims survive instance restarts; callbacks are transactionally consumed before external token exchange. Publisher writes and authorization changes are serialized. Invocation logging and tracing are disabled to avoid capturing OAuth query parameters.

To issue an invitation without exposing the operator secret, use a non-logging subprocess and print only the shareable invitation URL:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const secrets = JSON.parse(await readFile(join(homedir(), '.local/state/songlink/spotify-publisher-staging/secrets.json'), 'utf8'));
const response = await fetch('https://listen-cx-spotify-spike-staging.omar-alhait.workers.dev/control/invitations', {
  method: 'POST', headers: { Authorization: `Bearer ${secrets.OPERATOR_TOKEN}` },
});
if (!response.ok) throw new Error(`Invitation failed: ${response.status}`);
console.log((await response.json()).inviteUrl);
JS
```

### Staging evidence

Fifteen Worker-runtime tests pass with simulated provider responses. They cover operator authentication, missing-secret failure, HTTPS/host/origin constraints, body bounds, preview-safe invitation POST, cookie/state/PKCE binding, replay/expiry, concurrent callbacks, encrypted and tampered storage, explicit confirmation, refresh-token rotation, serialized controls, durable instance restart with stable playlist reconciliation, and path-aware browser/operator host isolation. The origin-split regression first failed against the old workers.dev invitation and permissive same-host public endpoints, then passed after the change. Initial contract tests failed against the placeholder Worker; specific security regressions were observed red before fixes. An independent security review of the Worker, config and core publisher found no blocking isolation issue and requested the preview-safe landing flow, which was added and tested before exposure.

Actual HTTPS smoke passed twenty checks at `2026-09-10T05:34:38Z`: health; unauthorized reads/writes; cross-origin controls; invalid callback/invitation; operator status; expendable invitation creation; repeated preview GET; malicious-origin POST; valid browser-bound redirect; invitation replay; missing browser; denied-consent consumption; callback replay; rejection of OAuth on the operator host; and 404 responses for all three wildcard-matched path suffixes. The smoke never followed the redirect to Spotify and made no provider writes. It consumed its expendable invitation. Before/after status and SHA-256 checks confirmed the staging homepage and `/control/status` response were unchanged; the latter remains a main-site 404. A separate fresh friend invitation was issued only after these checks passed. Authenticated provider create/readback and the second-account native Spotify test remain pending.

```sh
pnpm exec vitest run --config spikes/spotify-publisher/staging/vitest.config.ts
pnpm exec tsc -p spikes/spotify-publisher/staging/tsconfig.json
pnpm exec wrangler deploy --dry-run --config spikes/spotify-publisher/staging/wrangler.jsonc --env staging
node spikes/spotify-publisher/staging/remote-smoke.mjs
```

Add `--exercise-invitation` to the smoke command only when deliberately invalidating any pending invitation is acceptable. The default smoke makes read-only/protected-negative requests. The actual isolated deployment command is:

```sh
pnpm exec wrangler deploy --config spikes/spotify-publisher/staging/wrangler.jsonc --env staging \
  --secrets-file ~/.local/state/songlink/spotify-publisher-staging/secrets.json
```

The compatibility date matches the repository's verified `2026-07-13` runtime because its installed workerd rejects dates newer than July 15; no root dependency upgrade was introduced. The test pool's global `reset()` intermittently crashed that workerd binary with `Promise callback destroyed itself`. Tests instead clear only the test object's storage between cases, drain HTTP responses, and retain an explicit abort/restart durability test. The Worker passes bounded plain data through RPC, avoiding cross-context response-stream lifetimes.

SQLite Durable Objects are available on Cloudflare's existing plans; no plan purchase or upgrade was made. The staging config uses current declarative class exports and keeps its lifecycle isolated from the removed historical Thread DO. [Cloudflare storage guidance](https://developers.cloudflare.com/durable-objects/), [class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

Cloudflare path routes take precedence over a same-host Worker Custom Domain. We verified the existing staging OAuth endpoints returned 404 and coordinated the three reserved paths with the Threads task before adding them. Trailing wildcards are necessary for callback query strings; the application still accepts only the three exact paths and returns 404 for suffixes. [Route matching and precedence](https://developers.cloudflare.com/workers/configuration/routing/routes/).

### Native browser form regression

The first remote friend click in Arc failed before reaching Spotify. Chrome 152 reproduced the cause: `Referrer-Policy: no-referrer` makes a native form POST send `Origin: null`, which the strict origin check correctly rejects. Changing only the invitation HTML to `same-origin` restores the canonical Origin without sending a cross-origin referrer. A second test against the actual compiled Worker in isolated HTTPS Miniflare exposed CSP blocking the 302 because `form-action 'self'` excluded Spotify. Adding the exact Spotify accounts origin lets that redirect complete.

Both header regressions failed before their fixes; all fifteen staging tests and the staging typecheck then passed. The tests retain explicit rejection of null and attacker origins, missing browser cookies, and replayed invitations. Actual Chrome navigation against the fixed local Worker produced the expected Origin, a 302 POST response, and a top-level GET to Spotify without a Referer. The browser intercepted the Spotify boundary, so this check made no provider requests or changes. The post-deployment smoke passed eleven read-only/protected-negative checks at `2026-09-10T05:42:21Z`. No replacement invitation was issued and the friend's pending state was preserved. A failed origin check does not consume an invitation; the friend must reopen the original link to load the corrected headers, within its original expiry.

Manual HTTP tests that supply Origin cannot establish native-browser form behavior. Future changes to OAuth page headers should repeat a real browser form submission through the redirect, using isolated fixture state and intercepting the provider boundary.

### Two-phase live acceptance runner

`spikes/spotify-publisher/live-test.ts` captures fresh provider readback after each phase. The initial phase publishes `[A,B,C]` at revision 1. Stop there for the separate listener to save the public playlist in Spotify. The updated phase publishes `[C,A,D]` at revision 2 only when the stored destination still matches the initial receipt's playlist ID. Each receipt records observed track URIs, owner ID, snapshot ID and observation time. API verification always leaves `listenerVerification: pending`; a successful API receipt does not prove native-library propagation.

Create a private manifest after the candidate's identity and dashboard mode have been observed and explicitly confirmed through `/control/confirm`. Use the exact confirmed `publisherId` and `appMode`, a new stable `playlistKey`, and four distinct Spotify IDs in `trackIds`. Keep that manifest unchanged between phases. These public oEmbed titles were verified at `2026-09-11T05:44:23Z`; they establish catalog metadata, not publisher access or listener-market availability:

| Label | Track | Spotify ID |
| --- | --- | --- |
| A | Cataracts | `4SN5Kkig8iJ8vdwsOoP7IO` |
| B | Never Gonna Give You Up | `4uLU6hMCjMI75M1A2tKUQC` |
| C | Mr. Brightside | `3n3Ppam7vgaVa1iaRUc9Lp` |
| D | Blinding Lights | `0VjIjW4GlUZAMYd2vXMi3b` |

With a manifest saved in the existing private staging state directory:

```sh
node spikes/spotify-publisher/live-test.ts \
  --manifest ~/.local/state/songlink/spotify-publisher-staging/live-manifest.json \
  --phase initial --publish \
  --output ~/.local/state/songlink/spotify-publisher-staging/initial-readback.json
```

Before phase 2, record the listener's confirmation that their account is outside the app's OAuth allowlist, the Spotify client/platform, the saved playlist URL/ID, the visible `[A,B,C]` order, and the observation time. The listener does not authorize this app. Then run:

```sh
node spikes/spotify-publisher/live-test.ts \
  --manifest ~/.local/state/songlink/spotify-publisher-staging/live-manifest.json \
  --phase updated --publish \
  --initial ~/.local/state/songlink/spotify-publisher-staging/initial-readback.json \
  --output ~/.local/state/songlink/spotify-publisher-staging/updated-readback.json
```

Record when that same saved playlist displays `[C,A,D]`, whether reopening or refreshing was needed, and whether its native library save persisted. Capture a screenshot or direct listener observation without recording account credentials. Until both listener observations exist, outside-allowlist save and propagation remain unverified.

Omitting `--publish` performs only protected status and fresh provider reads. Output files are private and created exclusively; reuse the same manifest/phase with a new evidence filename when retrying. The runner never issues or confirms invitations, automatically retries errors, advances phases on its own, or creates a replacement key. A 429 reports its retry delay; wait before rerunning. An unknown control-write outcome requires status inspection followed by the same revision, not a new key. A persisted `create_unresolved` blocks further creation: inspect the publisher's native library, then use the existing explicit recovery endpoint only for an observed playlist ID whose owner and spike marker pass verification. Do not clear destination state to bypass uncertainty.

The readback endpoint independently fetches metadata, contents, and metadata again, accepting only an unchanged snapshot. It can report drift even when the stored revision is marked applied, without repairing that drift. Rate-limit deadlines survive restart. All 48 Node/core/harness/runner fixture tests and 15 Worker fixture tests passed; both spike typechecks and the staging dry run passed. After deployment, twelve read-only/protected-negative HTTPS checks passed at `2026-09-11T05:45:05Z`; an authorized read of an absent destination returned `destination_unavailable` without a provider request. No real playlist write or authenticated playlist readback has yet occurred.

## Spotify parity with the Apple web authorization milestone

**Subsequent September 12 clarification:** Omar wants one shared provider playlist per Thread, saved by every listener. The per-user-copy recommendation below was based on an earlier interpretation and is not required for that topology. The existing shared publisher is the relevant starting point. Authorize the publisher account; listeners who only save the public playlist inside Spotify do not need our OAuth connection. Actual publisher writes and independent saved-listener propagation remain unverified.

For the pending development-app authorization, the app owner uses Spotify Developer Dashboard → app → Settings → Users Management → Add new user, entering the intended publisher's Spotify account name and email. Inspect the actual App Status and confirm that the app owner has Premium. Keep the existing registered redirect URI `https://staging.listen.cx/auth/callback`. Then complete the spike's browser consent flow as the allowlisted account and verify `/me` before confirming the publisher. The earlier “The user is not registered for this application” 403 is consistent with Spotify's documented behavior when consent succeeds for an account absent from the allowlist. If using the friend's existing app, that friend must perform the dashboard setup unless Omar has access to manage it. This is dashboard configuration followed by user consent; additional Web API scopes do not repair an allowlist rejection. No dashboard setting or invitation changed during this research. [Current setup instructions and five-user development limit](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

Assessed September 12, 2026 against the current source and official Spotify documentation. Apple web authorization and personalized storefront access were reported proven on September 11; that milestone does not itself establish playlist writes. Spotify has more playlist mutation machinery implemented in the isolated spike, but has not yet completed the equivalent successful authenticated profile read for the intended publisher.

A read-only request to the deployed protected status endpoint returned HTTP 200 at `2026-09-12T18:55:52Z`: `authorized=false`, no candidate, `appMode=unverified`, zero destinations, and no retained verification failure. The historical local `/me` rejection remains a known allowlist failure. No invitation, browser session, provider write, deployment, or state change was performed for this assessment. The 63 fixture tests are the previous verified checkpoint, not new live Spotify evidence.

### Parity matrix

| Capability | Existing Spotify spike | Actual proof / remaining work |
| --- | --- | --- |
| Web OAuth and authenticated identity | PKCE, HTTPS callback, state/browser binding, encrypted tokens, `/me`, explicit operator confirmation | Browser submission and security boundaries proven; successful publisher `/me` and consent persistence still pending. No website user-connection flow exists. |
| User-specific catalog context | Publisher token is used for provider reads; source metadata clients are separate | No authenticated market/profile evidence. Spotify uses the token user's country for playlist-item availability; an Apple storefront value is not needed for Spotify. |
| Create a playlist | `POST /me/playlists`, public and noncollaborative, one publisher-owned destination per key | Simulated contracts only. No real created ID, owner, marker, or private destination verified. |
| Append additions | Ordered replacement plus POST batches after the first 100 entries | Batch behavior tested. No standalone append-event adapter or actual append proof. |
| Reorder, remove, clear | Full ordered replacement omits removed entries and supports an empty array | Tested `[A,B,C]` → `[C,A,D]`, duplicates and empty lists. Dedicated range-reorder and DELETE methods are not implemented; replacement provides the intended mirror behavior. |
| Reconcile and prove contents | Durable desired/applied revisions, same-ID checks, guarded ambiguous creation, fresh snapshot-bracketed readback | Tests pass; no authenticated playlist readback. Replaying an already-applied revision returns cached state; `observe()` is needed to detect later native edits, and currently reports rather than repairs them. |
| One playlist owned by each recipient | Not built; all staging traffic selects the same `publisher` Durable Object and credentials | Needs a private OAuth connection per recipient and a destination per Thread/connection. Reusing the singleton would create playlists in the shared publisher's account. |
| Update while the website is closed | Server can refresh stored access tokens when invoked | Technically supported by Spotify, but no Thread-triggered job, queue consumer, alarm, or scheduled reconciliation exists in this spike. |
| Native library visibility / propagation | Separate listener experiment and evidence runner prepared | Neither the publisher's native-library view nor outside-allowlist listener save/update has been observed. Per-user ownership and shared-playlist following are distinct tests. |

Spotify documents creation for the authenticated user, ordered append (up to 100 items), replacement or range reorder (up to 100 replacements), and explicit removal. These operations use `/me/playlists` and `/playlists/{id}/items`; they are not universally unavailable in development mode. The exact app's authorization and live endpoint behavior still need proof. [Create](https://developer.spotify.com/documentation/web-api/reference/create-playlist), [append](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist), [replace/reorder](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items), [remove](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist).

Current item-read documentation requires ownership or collaboration and describes user-country precedence over an explicit market parameter. A listener merely following a shared playlist is therefore not an appropriate token for proving its contents through that endpoint; use the publisher token for API proof and the listener's Spotify client for save/propagation proof. Per-user owned copies naturally satisfy the ownership condition. [Read playlist items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).

### Current access and token requirements

Development mode requires the **app owner** to retain Premium and normally permits five allowlisted authenticated users. A user can complete Spotify login while not allowlisted and still receive API 403s. The requirement cited here is not evidence that every tester or native listener must buy Premium. Wider distribution requires extended quota approval; current eligibility lists an organization, a launched service, at least 250,000 monthly active users, and other business requirements. This makes approval a material launch dependency, not a routine switch. Dashboard mode and grandfathered access have not been inspected for our actual app. [Quota modes and application requirements](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

Use the latest changelog rather than repeating the February one-app rule: July 2026 raised the developer app limit to **25 Client IDs**, while development quotas became shared across the developer account. Extra Client IDs do not supply independent quota buckets. Spotify also distinguishes these quotas from its rolling 30-second rate limit. The spike currently retains a retry deadline but discards the provider's `QUOTA_EXCEEDED` reason; production job scheduling should distinguish quota exhaustion from a short rate-limit delay. [July changes](https://developer.spotify.com/documentation/web-api/references/changes/july-2026), [rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).

The February migration guide preserves existing users above five, and Spotify's March 9 update postponed endpoint-access changes for existing integrations. Neither establishes an exemption for this particular Client ID. New integration work should use current `/items` endpoints and verify the actual dashboard and token, rather than infer behavior from the app's age. Development mode is positioned for personal, noncommercial experimentation, not business scaling. [Migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [updated announcement](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security).

For the present public shared-publisher test, the requested scope is `playlist-modify-public`. For a new private playlist owned by each connected user, request `playlist-modify-private` and `playlist-read-private`; add public modification only if the product supports public destinations. The existing public-only create/metadata guard and token-scope validator must change for private destinations. Do not add playback, email, or library-save scopes merely to create and maintain an owned playlist. Reusing arbitrary existing user playlists, or making Spotify-native collaborative playlists, is additional scope beyond the smallest integration. [Creation scopes](https://developer.spotify.com/documentation/web-api/reference/create-playlist), [read scope](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).

PKCE works without distributing a client secret. The existing registered callback is `https://staging.listen.cx/auth/callback`; a new website connection route would need its own exact registered HTTPS URI and OAuth state bound to that private connection. For durable account linking, store Spotify's immutable `account_id`; retain the current `id` separately for comparisons with playlist `owner.id`. The spike currently stores only that latter publisher ID. [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), [redirect requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri), [May account identifier change](https://developer.spotify.com/documentation/web-api/references/changes/may-2026).

Current Spotify documentation gives access tokens a one-hour lifetime and dashboard-app refresh tokens a **six-month lifetime starting at authorization**. Refreshing does not extend the latter. Store a returned replacement refresh token, retain the prior one when none is returned, and require reconnection on `invalid_grant` rather than repeatedly retrying. The spike implements encrypted persistence and replacement-token handling, but has no authorization-age deadline or end-user reconnect/disconnect lifecycle. Server-side jobs can therefore keep a playlist updated after the website closes while the grant remains valid; this is not indefinite authorization, and the job infrastructure is still missing. [Refresh lifecycle](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens).

### Smallest integration recommendation

First complete the existing isolated one-account proof: inspect the actual dashboard mode, owner Premium status and publisher allowlist entry; complete consent; obtain successful `/me`; confirm the observed identity/mode; then run the existing initial and updated phases with fresh same-ID readback and native Spotify inspection. This unblocks confidence in the provider primitive without implying a working per-user product. No fresh link was issued during this research-only pass.

For the requested **playlist owned by the user**, implement a private connection per consenting recipient and a newly created destination keyed by `(threadId, connectionId)`. Keep the existing shared-publisher mode separate. Start with one allowlisted tester and a Thread whose entries already have verified Spotify identities, then use the Thread's authoritative ordered revision to replace the destination contents. At the current 50-song Thread cap, the whole list fits in a single PUT, so additions, removal, reorder and clear can share that one reconciliation path. This recommendation avoids a separate append receipt protocol; it does not make ambiguous playlist creation safe to retry.

Persist the Thread change and pending publication work durably, let a server job read the newest desired revision, serialize per destination, refresh that connection's token, verify ownership, replace the contents, and advance the applied revision only after fresh ordered readback. Retain unresolved source identities and failures explicitly. Website-closed acceptance should trigger a change from another participant after the connected user's page is closed and verify the same user-owned playlist through both API readback and the native Spotify client. Include token-expiry refresh, revocation/reconnect, and a second isolated user connection in the integration gate. Public rollout remains subject to the app's access approval.
