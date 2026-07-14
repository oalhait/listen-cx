---
title: Provider Playlist Export - Plan
type: feat
date: 2026-07-13
origin: docs/plans/2026-07-13-001-feat-pass-the-aux-roadmap-plan.md
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Provider Playlist Export - Plan

## Goal Capsule

- **Objective:** Let a listener explicitly save a completed provider-neutral Pass the Aux sequence as a native playlist without adding accounts or authorization to contribution and listening.
- **Product authority:** R9-R10, F3, and AE3 from the origin roadmap and the receiver-side no-account contract remain authoritative.
- **Delivery decision:** Build an Apple Music staging spike first. Keep Spotify internal-only until both public quota and cross-service policy gates are cleared.
- **Stop conditions:** Do not store provider identities or refresh tokens, export partial/search-fallback matches as if exact, retry ambiguous playlist writes automatically, or expose a provider option that cannot serve the public audience.
- **Tail ownership:** Implementation may prepare staging code and tests; credentials, provider registration, public rollout, deployment, and legal/policy clearance require separate authority.

---

## Product Contract

### Summary

Export is a secondary action on a completed thread. The listener sees exactly how many songs can be saved, explicitly chooses a provider, authorizes only that provider, and receives a native private playlist or an honest failure state. The underlying thread and every individual song remain playable without authorization.

### Actor and Requirements

- **A3. Listener/exporter:** A listener who wants the finished sequence in their own provider library.
- **R9.** A3 can explicitly authorize a supported provider to save a completed thread as an ordered native playlist.
- **R10.** Export is post-completion and optional; it cannot alter or gate account-free creation, contribution, sharing, or receiver-side playback.
- **F3.** Preview exact coverage -> confirm provider -> authorize -> write native playlist -> show result and omissions.
- **AE3.** A listener who never authorizes a provider can still open the completed thread and every song through the existing preference flow.

## Decision

Ship Apple Music first, as a narrow post-completion export experiment. Do not promise Spotify parity in the MVP.

Apple documents playlist creation and track addition for a user's library and documents MusicKit on the Web as the user-authorization/token-management surface. Its remaining blockers are operational: Apple Developer Program access, a Media ID and Media Services key, an origin-bound developer token, and live verification of the current beta-labeled MusicKit web mutation surface.

Spotify is technically capable but not currently launchable to an ordinary public listen.cx audience. New development-mode apps are limited to five allowlisted users and require the app owner to maintain Premium. Extended quota is described as available to organizations with an active launched service and at least 250,000 MAU. Spotify's policy also prohibits products integrated with content from another service, while allowing only a narrow transfer exception for a user's personal data or playlist metadata. A provider-neutral group thread is not clearly inside that exception. Spotify may be used for an allowlisted internal alpha only after counsel/provider confirmation; public rollout remains blocked until both quota and policy gates pass.

The export feature must remain an isolated capability. Creating, contributing to, opening, and listening to a thread remain account-free and must not initialize a provider SDK, issue an authorization redirect, set an export cookie, or call a provider export API.

## Source discipline

Statements marked **Fact** are directly supported by an official provider source in the source register. Statements marked **Inference** are design conclusions from those facts and the repository contract. **Uncertainty** identifies behavior the official material does not establish. All official sources were retrieved 2026-07-14.

## Feasibility matrix

### Spotify

| Area | Official fact | Product implication | Readiness |
|---|---|---|---|
| Create playlist | `POST /me/playlists`; private playlists require `playlist-modify-private`; response is `201` and includes playlist ID and `snapshot_id`. [S1] | Create an explicitly private, non-collaborative playlist. No user-profile read is needed. | Technically feasible |
| Add ordered items | `POST /playlists/{playlist_id}/items`; accepts items in request order, maximum 100 per request, and returns a snapshot ID. [S2] | A finite thread normally fits one ordered add. Chunk at 100 without reordering if future thread length grows. | Technically feasible |
| Authorization | Spotify recommends Authorization Code for a secure long-running server and PKCE when a client secret cannot be stored. Redirect URI must match the allowlist; `state` is strongly recommended. [S3, S4] | Use server-side Authorization Code, a one-time state, and a Worker secret. Do not put a client secret or provider token in browser storage. | Feasible after app registration |
| Scopes | Private creation/modification uses `playlist-modify-private`; public modification is a separate scope. [S1, S2] | Request only `playlist-modify-private`; always set `public: false`. | Feasible |
| Token lifetime | Access tokens last one hour. Refresh tokens issued to dashboard apps last six months and refreshing does not extend that lifetime. [S5] | Finish one export in the callback invocation and discard both tokens. No refresh-token or connected-account table is needed for v0. | Feasible |
| Rate limits | Calls are limited over a rolling 30-second window; `429` normally includes `Retry-After`. [S6] | Respect `Retry-After`; do not retry ambiguous non-idempotent writes. | Feasible with safeguards |
| Development access | New development apps: one client ID per developer, five users per app, owner must have Premium; non-allowlisted API calls return `403`. [S7, S8] | Staging/internal alpha only, with named allowlisted testers. | Public launch blocked |
| Extended quota | Spotify says new extension applicants must be organizations with an active launched service, at least 250,000 MAU, key-market availability, commercial viability, and terms compliance. [S7] | listen.cx must not plan on a public Spotify export until eligibility is independently established and approval is obtained. | Blocked prerequisite |
| Cross-service policy | Spotify prohibits an SDA integrated with streams/content from another service and generally prohibits transfers to another service except a user's personal data or playlist metadata. It also requires transparency, a privacy policy, data minimization, and a disconnect mechanism. [S9] | A provider-neutral group thread is policy-ambiguous. Obtain written provider/counsel confirmation before any external Spotify export. Never use Spotify API metadata to enrich/export to Apple. | Policy blocked |
| Browser/platform | OAuth redirect is browser based; secure HTTPS redirect URIs are required, with loopback exceptions for local development. [S4, S10] | Standard top-level browser redirect; no popup dependency. Test Safari iOS/macOS and Chrome. | Feasible, live verification required |

### Apple Music

| Area | Official fact | Product implication | Readiness |
|---|---|---|---|
| Create playlist | `POST /v1/me/library/playlists`; requires a Music User Token; an optional tracks relationship can be included; success is `201`. Apple warns the new resource may take time to appear. [A1] | Prefer a single create-with-tracks call, explicitly request `isPublic: false`, and verify order/visibility live. Do not treat immediate library visibility as a failure. | Technically feasible |
| Add tracks | `POST /v1/me/library/playlists/{id}/tracks`; appends tracks; requires a Music User Token; success is `204`. [A2] | Reserve for a known created-playlist resume path or future >request-limit support; do not use by default. | Technically feasible |
| User authorization | Personalized `/me` requests require a Music User Token. MusicKit automatically manages it for web apps; its passthrough API decorates Apple Music API requests after `authorize()`. [A3, A4] | Run authorization and the personalized write through MusicKit on the Web. listen.cx should not extract, transmit, or persist the Music User Token. | Feasible, current web API must be spiked |
| Developer authorization | Every API request needs an ES256 developer token signed with a Media Services private key. `exp` may be at most 15,777,000 seconds (six months) from current server time; the `origin` claim is recommended for web clients. [A5] | Keep the private key as a Worker secret and mint a short-lived, exact-origin token for the export page. | Feasible after credentials |
| Registration | Apple requires a Media ID and Media Services private key; the Media ID description is shown to users. Account Holder or Admin is required, and the private key is downloadable only once. [A6, A7] | Explicit staging prerequisite and rotation runbook; do not fabricate credentials. | Unavailable prerequisite |
| Catalog/storefront | Catalog availability varies by storefront; library IDs differ from catalog IDs. [A8, A9] | Export only target-storefront catalog song IDs. Preflight exact IDs against the authorized user's storefront and omit unavailable entries. | Feasible |
| Subscription | Apple states that an authorized user with a valid Apple Music subscription receives full access and that apps should inspect subscription capability. [A10, A11] | Treat no subscription/restricted capability as a provider-unavailable outcome, not a listen.cx account failure. | Feasible, test required |
| Rate limits | Apple applies an unspecified per-developer-token request limit and returns temporary `429` responses; no numeric quota is published in the cited documentation. [A5] | Instrument `429`; avoid fan-out; do not promise capacity based on an invented number. | Feasible with unknown capacity |
| Browser/platform | Apple documents a web SDK and passthrough API, but the current MusicKit on the Web documentation is labeled beta and does not state browser/cookie support guarantees for this write flow. [A4] | A real-browser spike is a release gate on Safari iOS/macOS and Chrome. | Verification blocked, not design blocked |
| Policy | The official API documentation authorizes playlist create/modify with user permission. The planning pass did not find a current public Apple policy page explicitly addressing cross-provider playlist transfer. | Privacy/terms review is still required, but there is no discovered Spotify-like public prohibition to treat as a fact. | Legal review required |

## Provider order and alternatives

1. **Apple Music private staging spike.** Validate MusicKit authorization, the passthrough mutation call, storefront behavior, create-with-tracks ordering, cancellation, subscription failure, and delayed appearance.
2. **Apple Music limited production rollout.** Release behind `APPLE_EXPORT_ENABLED`, initially to a small percentage, after observability and privacy gates.
3. **Spotify internal alpha only.** Use an allowlisted development app after the policy interpretation is cleared. This is useful for technical verification, not a public promise.
4. **Spotify public rollout only after two independent gates:** written policy clearance for provider-neutral group-thread export and approved usable quota.

Parity is not viable at MVP because the Spotify blockers are external and material. Hiding the five-user limit behind a client-side PKCE implementation would not change the quota. Generating a file or search links would not satisfy R9's native-playlist outcome and must not be labeled export.

### Auth architecture alternatives

- **Chosen Spotify shape:** server-side Authorization Code. It matches Spotify's guidance for a secure backend and keeps the secret and tokens off the browser. It also permits a callback-bound export without a user profile.
- **Rejected Spotify shape:** browser PKCE with tokens in local/session storage. PKCE is valid, but it expands XSS exposure, complicates recovery, and does not solve quota or policy.
- **Chosen Apple shape:** MusicKit on the Web authorization and passthrough API in the browser, configured with a short-lived origin-bound developer token supplied by listen.cx. This follows Apple's documented automatic Music User Token management.
- **Not yet justified Apple shape:** proxying personalized writes through the Worker. The official web documentation reviewed does not establish a supported Music User Token extraction/forwarding contract. Do not design around undocumented token access.

## Product and security contract

### Negative contract

- No account, provider authorization, provider SDK load, export session, or export API call is required for thread creation, contribution, completion, sharing, or per-song playback.
- Export is rendered only for a completed read-only thread. An incomplete/closed-but-not-complete thread returns `409` from any export-start route.
- Playback provider preference remains the existing one-year `pref` cookie. Export state uses a distinct, short-lived cookie and never changes `pref`.
- No long-lived listen.cx user profile, provider identity row, email, display name, library contents, or refresh token is created.
- No background/repeated library writes. Each playlist creation follows a current, explicit user click and confirmation.
- No add-to-library/save action outside the named playlist export.

### Export manifest

Before authorization, derive an immutable manifest from the completed thread snapshot:

- `thread_id`, completion version/hash, title, ordered slot IDs;
- target provider;
- for each slot: target provider catalog ID/URI, `match_kind`, and display metadata already stored by listen.cx;
- `match_kind` is one of `exact`, `partial`, `search_fallback`, or `unavailable` for each destination independently;
- manifest hash over the ordered target IDs plus omission reasons.

Only `exact` target-provider catalog identifiers are eligible. `partial` and `search_fallback` destinations remain valid for the existing best-effort playback handoff but are excluded from a durable playlist write. Availability preflight may downgrade `exact` to `unavailable` for the authorized storefront/market. Never run a new fuzzy search inside the export callback.

The preview must say, before authorization, “Save N of M songs” and list omitted titles/reasons. If N is zero, disable export. If N is less than M, require an explicit “Continue with N songs” confirmation. Preserve the relative order of included songs and preserve duplicate contributions; a duplicate slot is editorial sequence, not an accidental duplicate.

The current `links.complete` flag is not sufficient: all resolver paths currently produce `complete: false`, and a present URL may still be a best-effort candidate. The thread dependency must persist per-provider catalog ID and provenance. Export must not infer exactness from URL presence.

### Session and callback model

Use an export attempt, not a user account:

- Random 128-bit `export_attempt_id` plus a separate random browser-binding nonce.
- D1 stores only the nonce hash, thread/provider, manifest hash/counts, state, provider playlist ID after creation, classified error, and timestamps.
- Browser receives `export_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, narrow path, 10-minute max age. Apple also receives an in-page attempt token bound to the same attempt and protected by same-origin CSRF checks.
- State machine: `prepared -> authorizing -> creating -> succeeded`; recovery states `playlist_created`, `known_failed`, `ambiguous`, `cancelled`, `expired`.
- Every transition uses compare-and-set and verifies provider, thread, manifest hash, expiry, and browser binding.
- Successful, cancelled, and expired attempts reject replay. Retain non-token outcome rows for a short defined telemetry window (recommended 30 days), then delete them.

Spotify authorization adds a one-time random OAuth `state` hash to the attempt. The callback requires an exact state match, matching cookie, unexpired attempt, exact configured redirect URI, and an atomic unused-to-used transition before exchanging the code. Error callbacks (`access_denied`) become `cancelled` without token exchange. Token responses exist only in Worker memory and are never logged or written to D1. The returned refresh token is discarded.

Apple has no listen.cx OAuth callback in the chosen model. A user click calls MusicKit `authorize()`, then the documented passthrough API. listen.cx receives only a same-origin completion receipt containing the attempt ID and provider playlist ID/result classification. Treat this receipt as telemetry and recovery state, not proof of provider identity. The Music User Token remains managed by MusicKit. A user-facing “Forget Apple Music authorization on this browser” action should call MusicKit `unauthorize()` and clear local export state; server attempts are already token-free.

### Secrets and tokens

| Secret/token | Location | Retention | Logging |
|---|---|---|---|
| Spotify client ID | Worker configuration | Until rotated | Safe identifier, but do not emit routinely |
| Spotify client secret | Wrangler secret | Until rotated | Never |
| Spotify auth code | Callback memory | One exchange | Never |
| Spotify access/refresh tokens | Callback memory | One export; discard immediately | Never |
| Apple Team ID / key ID / Media ID | Worker configuration | Until rotated | Do not emit routinely |
| Apple Media Services private key | Wrangler secret | Until rotation/revocation | Never |
| Apple developer token | Browser memory | 5–15 minutes, exact origin | Never |
| Apple Music User Token | MusicKit-managed browser state | Provider controlled | Never visible to listen.cx |
| Export session nonce | Cookie; hash in D1 | 10 minutes | Never |

Do not place any of these values in URLs except provider-required OAuth `code` and `state`; callback responses must immediately redirect to a clean result URL and set `Referrer-Policy: no-referrer` plus `Cache-Control: no-store`.

---

## Planning Contract

### Idempotency, retries, and failure UX

Provider playlist creation endpoints are non-idempotent. The local attempt state prevents ordinary double-click and callback replay, but it cannot prove whether a provider committed a request when the network response is lost.

- Disable the action after the first click; duplicate requests with the same attempt return the existing status.
- Spotify: create an empty private playlist, persist the returned playlist ID, then add the manifest in ordered chunks of at most 100. A known add failure may resume against that stored playlist after reauthorization. Never create a second playlist for that attempt.
- Apple: send `isPublic: false` and the tracks relationship in the create request so creation and initial population are one provider call. Persist the returned playlist ID immediately on success.
- `401`/`403`: do not loop. Classify expired/denied/configuration/subscription where possible and offer a fresh explicit authorization only when appropriate.
- `429`: show “Provider is busy.” Honor a documented `Retry-After` for Spotify, with one bounded retry only when the response conclusively indicates the write was rejected. Apple publishes no retry timing; require a later explicit retry.
- Network loss or `5xx` after dispatch: state becomes `ambiguous`. Do not automatically repeat a create or add POST because that may duplicate a playlist or tracks. Tell the user to check the provider library; a new attempt must explicitly warn about the possible duplicate.
- Known validation failure before dispatch is safely retryable with the same attempt after correction.
- Delayed Apple library visibility is shown as “Saved; it may take a moment to appear,” not failure.
- A successful partial export states exactly which songs were omitted and keeps a “Listen here” path for every original contribution.

No provider offers a client-supplied idempotency key in the cited create/add documentation. Any stronger guarantee requires a provider read-back flow and broader read scopes; defer that until duplicate rates justify the privacy cost.

### Export UX

1. Completed thread page shows a secondary “Save as playlist” action after the listening sequence; no modal or provider SDK loads on page view.
2. Export sheet shows provider availability, private playlist default, exact included count, omitted songs, and a plain-language authorization statement.
3. The user chooses Apple Music and confirms. Only then load/configure MusicKit and request authorization.
4. Display explicit states: `Connecting`, `Saving N songs`, `Saved`, `Authorization cancelled`, `Subscription required`, `Some songs unavailable`, `Provider busy`, or `Could not confirm—check your library before retrying`.
5. Success names the created playlist. An “Open playlist” link is included only if the provider response or verified SDK surface supplies a supported URL; do not construct an undocumented Apple library URL.
6. The thread and all individual listen actions remain usable throughout and after every failure.

For Apple-first production, omit the Spotify button or label it clearly as unavailable; do not send users into a five-user dead end. For an internal alpha, render Spotify only to an environment/allowlist feature flag.

---

## Implementation Units

Paths are repo-relative. IDs are stable and dependency-ordered; they describe work and tests, not implementation code.

### U-EXP-001 — Provider match provenance contract

**Depends on:** completed-thread storage.  
**Files:** future thread row/types plus `migrations/0002_pass_the_aux.sql` (or the migration number assigned by the thread plan), `src/resolve.ts`, `src/db.ts`.  
**Change:** persist target-provider catalog IDs and `match_kind` independently for each immutable contribution. Preserve current best-effort playback URLs. Provide an ordered completed-thread snapshot/version to export.  
**Tests:** co-located resolver/storage tests plus `test/resolve.test.ts`; prove inbound exact ID, cross-provider partial candidate, search fallback, immutable provenance, and no inference from URL presence.

### U-EXP-002 — Pure manifest builder

**Depends on:** U-EXP-001.  
**Files:** `src/export/manifest.ts`, `src/export/manifest.test.ts`.  
**Change:** build the ordered manifest and stable hash; include exact IDs; omit partial/fallback/unavailable; preserve duplicates and relative order; reject incomplete or mutated threads.  
**Tests:** all-exact, mixed provenance, zero exact, unavailable storefront, duplicate songs, 100/101 ordering, changed completion version, deterministic hash.

### U-EXP-003 — Export attempt store and migration

**Depends on:** U-EXP-002.  
**Files:** `migrations/0003_provider_exports.sql` (renumber as necessary), `src/export/store.ts`, `src/export/store.test.ts`, `test/apply-migrations.ts`.  
**Change:** token-free attempt schema, hashed browser binding, expiry, compare-and-set transitions, provider playlist result, error class, cleanup query. No provider-user table.  
**Tests:** transition matrix, replay rejection, expiry, concurrent double-start, manifest mismatch, resume from `playlist_created`, ambiguous terminal behavior, migration against a populated local D1.

### U-EXP-004 — Provider-neutral export routes and page

**Depends on:** U-EXP-003.  
**Files:** `src/export/routes.ts`, `src/export/page.ts`, `src/export/routes.test.ts`, integration in `src/app.ts` and `src/worker.ts`.  
**Change:** preview/start/status/receipt/forget routes; completed-thread guard; cookie/CSRF/cache/referrer headers; feature flags; dependency injection. Export routes remain outside the existing catch-all slug semantics.  
**Tests:** no export on incomplete thread, no auth side effect on thread GET, explicit confirmation for omissions, cookie attributes, CSRF/state failures, replay, bot/unfurl isolation, existing `pref` behavior unchanged.

### U-EXP-005 — Apple developer-token signer

**Depends on:** U-EXP-004 and Apple credentials.  
**Files:** `src/export/apple-token.ts`, `src/export/apple-token.test.ts`, environment types/config wiring in `src/worker.ts` and `wrangler.jsonc` without secret values.  
**Change:** ES256 JWT with Team ID, key ID, issued/expiry times, exact staging/production origin, short lifetime, key-rotation support.  
**Tests:** header/claims, maximum local lifetime, exact allowed origin, expired token, wrong key, staging/production separation, no key/token in errors.

### U-EXP-006 — Apple MusicKit export adapter and UI state

**Depends on:** U-EXP-002, U-EXP-004, U-EXP-005, successful real-browser spike.  
**Files:** `src/export/apple-client.ts`, `src/export/apple-client.test.ts`, `src/export/page.ts`.  
**Change:** lazy-load MusicKit only after click, authorize, inspect storefront/subscription capability, preflight exact catalog IDs, create playlist with ordered tracks, send outcome receipt, unauthorize action. Choose the repository's build/serve strategy explicitly before coding; do not place raw tokens in generated HTML snapshots or logs.  
**Tests:** adapter with fake MusicKit for authorize success/cancel/deny, subscription unavailable, storefront omissions, ordered request body, `201`, delayed visibility copy, `401/403/429/5xx/network ambiguous`, double-click. Real SDK behavior is a staging gate, not a mocked proof.

### U-EXP-007 — Spotify OAuth boundary (deferred public path)

**Depends on:** U-EXP-004, policy clearance, app registration.  
**Files:** `src/export/spotify-auth.ts`, `src/export/spotify-auth.test.ts`, routes in `src/export/routes.ts`, env wiring.  
**Change:** server Authorization Code start/callback, exact redirect URI, least scope, state/browser binding, one-shot exchange, memory-only tokens, clean redirect.  
**Tests:** authorization URL scope, state entropy/hash, callback accept/deny/mismatch/expiry/replay, exact redirect URI, token response without refresh token, refresh token never persisted, redacted logs.

### U-EXP-008 — Spotify playlist adapter (deferred public path)

**Depends on:** U-EXP-007.  
**Files:** `src/export/spotify-export.ts`, `src/export/spotify-export.test.ts`.  
**Change:** explicit private creation, persist playlist ID, ordered add chunks up to 100, known-failure resume, rate-limit and ambiguous-write classification.  
**Tests:** create request privacy, exact URI-only payload, 100/101 chunk order, snapshot capture, `401/403/429`, known add failure resume without new create, network/5xx ambiguity without retry.

### U-EXP-009 — Privacy, observability, and cleanup

**Depends on:** U-EXP-004; provider-specific fields added with U-EXP-006/U-EXP-008.  
**Files:** `src/export/telemetry.ts`, `src/export/telemetry.test.ts`, privacy/help content location selected by product plan, scheduled cleanup wiring if adopted.  
**Change:** structured outcome events, redaction, privacy disclosure, transient-state deletion/forget flow, retention job, operational dashboard queries.  
**Tests:** secrets/auth codes/tokens/provider playlist IDs never logged; retention deletion; disconnect/forget clears browser state; metrics use counts/classes only.

### U-EXP-010 — Regression and real-surface verification

**Depends on:** all enabled provider units.  
**Files:** `test/app.test.ts`, `test/worker.test.ts`, a future browser/E2E spec co-located with the thread flow per the selected harness, release checklist in the eventual implementation plan/PR.  
**Change:** negative-contract regression suite and staging verification record.  
**Tests:** see the next section.

---

## Verification Contract

### Static and Worker-runtime

- `pnpm typecheck` has zero errors.
- `pnpm test` passes existing and new tests.
- Existing `/`, `/create`, `/:slug`, `?to=`, `?choose=1`, bot/unfurl, provider preference, and fallback search behavior remain unchanged.
- A completed thread GET with no export action produces no request to Spotify Accounts/API, Apple MusicKit CDN/API, or an export route and sets no export cookie.
- Contribution accepts Spotify/Apple links without any provider authorization or export configuration.
- Feature flag off removes export UI/routes without affecting completion/listening.

### Real Apple staging gate

Using real credentials and disposable test playlists:

1. Safari on current iOS and macOS plus current Chrome desktop: authorize from a user click; cancel; deny; reauthorize; unauthorize.
2. Active subscriber and non-subscriber/restricted capability.
3. All-exact and mixed exact/partial threads; verify omitted copy before authorization.
4. Cross-storefront unavailable song; verify preserved order of remaining songs.
5. Playlist name/description, private/default visibility, exact track order, duplicates, and delayed library appearance.
6. Refresh/navigation and double-click during create; verify only one local attempt and classify any ambiguous provider result.
7. Verify developer-token origin enforcement on staging and rejection from another origin.
8. Inspect browser/network/Worker/D1: no Music User Token or Media Services private key reaches listen.cx storage/logs.
9. Confirm the current MusicKit passthrough mutation request options are supported. If not, Apple implementation is blocked; do not fall back to undocumented token extraction.

### Real Spotify staging gate (after policy clearance)

1. Owner Premium active; one named allowlisted tester; non-allowlisted user returns the expected `403` and sees useful copy.
2. OAuth accept/deny/state mismatch/expired state/replay on Safari iOS/macOS and Chrome.
3. Verify only `playlist-modify-private` is requested and playlist is private.
4. All-exact and mixed manifests, preserved order, duplicates, 100/101 chunk boundary.
5. Known add failure resumes the same playlist; ambiguous failure never silently retries.
6. `429` respects `Retry-After`; logs contain no code/token/playlist ID.
7. Revoke access and exercise the documented disconnect/forget path.

### Observability

Emit one structured event per state transition with: `export_attempt_id` (random, not user identity), hashed thread ID, provider, manifest version, total/included/omitted counts, state, error class, provider HTTP class, attempt age, and latency. Never log authorization codes, OAuth state, cookies, access/refresh/user/developer tokens, raw provider response bodies, provider user IDs, or playlist IDs.

Track:

- preview-to-confirm and confirm-to-success rates;
- authorization cancel/deny rate;
- omission rate by reason and provider;
- `401/403`, `429`, provider `5xx`, and ambiguous-write rates;
- Apple subscriber/capability unavailable rate;
- time from success response to user-confirmed appearance during staging only.

Alert on sustained configuration failures (`401/403`), rate limiting, ambiguous writes, and a sudden drop in successful export. Sampling must never sample secrets; redaction happens before emission.

### Staging prerequisites and rollout gates

| Gate | Required evidence | Owner/action | Status now |
|---|---|---|---|
| G0 thread contract | Completed immutable ordered thread plus per-provider ID/provenance | Pass the Aux implementation | Dependency unavailable |
| G1 privacy | Export-only privacy disclosure, retention, forget/disconnect behavior | Product/legal | Unavailable |
| G2 Apple credentials | Apple Developer Program team, Media ID, displayed app name, two-key rotation plan, Media Services key, Team ID/key ID | Account Holder/Admin; requires user confirmation | Unavailable |
| G3 Apple web proof | U-EXP-006 real-browser checklist, current passthrough POST support, subscription/storefront behavior | Engineering staging | Unavailable credentials |
| G4 Apple canary | Feature flag, dashboards/alerts, support copy, disposable playlist cleanup process | Engineering/product | Not started |
| G5 Spotify policy | Written assessment/confirmation that neutral thread export is permitted by S9 | Legal/provider | Blocked |
| G6 Spotify credentials/quota | Registered app, secure redirect URIs, owner Premium, tester allowlist; extended quota approval before public use | Provider/account owner; requires user confirmation | Unavailable/public blocked |
| G7 regression | Review, typecheck, all tests, negative-contract network proof, E2E record | Engineering | Not started |

Roll out Apple at 0%/internal, then a small canary, then expand only if success, omission, ambiguous-write, and support metrics are acceptable. A kill switch must remove export entry points without changing the core thread or per-song listening routes. Spotify stays off in production until G5 and G6 pass regardless of implementation completeness.

### Traceability and acceptance scenarios

| Requirement | Plan proof |
|---|---|
| R9 | Explicit provider choice/confirmation, scoped authorization, exact-only manifest, native playlist write, success/failure UI; U-EXP-002 through U-EXP-008 |
| R10 | Completed-thread guard, export-only routes/cookies/tokens, feature flag/kill switch, no accounts/profiles, negative regression suite |
| F3 | Preview -> explicit provider authorization -> native playlist -> result path, with omissions visible before auth |
| AE3 | Negative contract and U-EXP-004/U-EXP-010 tests prove an unauthorized listener still opens every song via the existing preference/handoff flow |

Acceptance scenarios:

- **Unauthenticated listening:** Given no provider authorization, when a listener opens a completed thread and any song, then the existing preference/choice handoff works and no export state is created.
- **Apple exact export:** Given a completed thread with five Apple exact IDs, when the listener confirms and authorizes, then one native playlist contains those five songs in thread order.
- **Partial export:** Given five contributions with three exact target IDs and two partial/fallback destinations, when previewed, then authorization is not requested until the listener confirms “3 of 5,” and the result lists both omissions.
- **Zero exact:** Given no exact target IDs, export is disabled and individual listening remains available.
- **Cancellation:** Given an export preview, when authorization is cancelled, then no playlist write occurs and the thread remains usable.
- **Replay:** Given a completed callback/attempt, when it is replayed, then no provider write occurs.
- **Ambiguous write:** Given a dispatched create loses its response, when the user returns, then listen.cx does not automatically retry and warns them to inspect the provider library.
- **Feature disabled:** Given the export kill switch is off, when any user loads or contributes to a thread, then all core behavior is unchanged.

---

## Risks and Dependencies

- **Spotify policy:** public provider-neutral export may be prohibited; do not interpret the playlist-transfer exception without provider/legal review.
- **Spotify viability:** the published 250,000-MAU extension criterion makes public support unrealistic for an early product unless Spotify grants another path.
- **Apple web API maturity:** current MusicKit web documentation is beta-labeled; mutation signature/browser behavior needs live proof.
- **Apple Music User Token lifetime:** no explicit lifetime was found in the reviewed official documentation. The design delegates it to MusicKit and stores none.
- **Apple numeric quota/request size:** no numeric rate limit or playlist-creation track-count limit was found. Keep finite threads small; verify payload size live.
- **Provider idempotency:** cited create/add endpoints publish no client idempotency key. Ambiguous writes cannot be made perfectly safe without broader read-back permissions.
- **Catalog availability:** exact identity does not guarantee availability in the authorized user's market/storefront.
- **Success URL:** Apple create response documentation does not promise a web URL. Do not synthesize one without live supported evidence.

---

## Definition of Done

- R9-R10, F3, and AE3 trace to enabled implementation units and passing tests.
- Completed-thread export builds an immutable exact-only manifest, preserves sequence and duplicates, and discloses omissions before authorization.
- Apple Music real-browser staging proof passes on Safari iOS/macOS and Chrome using disposable playlists; no Music User Token or private key enters D1, logs, or generated HTML.
- Playlist creation is locally replay-safe and treats lost responses as ambiguous instead of silently duplicating provider writes.
- Core thread creation, contribution, playback, unfurl, preference, and choose-override flows make no export request and remain green with export disabled.
- Spotify remains hidden from public production until policy clearance and usable quota are documented; an allowlisted alpha is not called public support.
- Privacy disclosure, transient-attempt retention, redaction, observability, feature flags, and kill switch are verified before rollout.

---

## Official Source Register

All retrieved 2026-07-14.

- **S1:** Spotify, “Create Playlist” — `https://developer.spotify.com/documentation/web-api/reference/create-playlist`
- **S2:** Spotify, “Add Items to Playlist” — `https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist`
- **S3:** Spotify, “Authorization” — `https://developer.spotify.com/documentation/web-api/concepts/authorization`
- **S4:** Spotify, “Authorization Code with PKCE Flow” — `https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow`
- **S5:** Spotify, “Refreshing tokens” — `https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens`
- **S6:** Spotify, “Rate Limits” — `https://developer.spotify.com/documentation/web-api/concepts/rate-limits`
- **S7:** Spotify, “Quota modes” — `https://developer.spotify.com/documentation/web-api/concepts/quota-modes`
- **S8:** Spotify, “February 2026 Web API Dev Mode Changes — Migration Guide” — `https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide`
- **S9:** Spotify, “Developer Policy,” effective 2025-05-15 — `https://developer.spotify.com/policy`
- **S10:** Spotify, “Redirect URIs” — `https://developer.spotify.com/documentation/web-api/concepts/redirect_uri`
- **A1:** Apple, “Create a New Library Playlist” — `https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist`
- **A2:** Apple, “Add Tracks to a Library Playlist” — `https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist`
- **A3:** Apple, “User Authentication for MusicKit” — `https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit`
- **A4:** Apple, “Accessing Music Content via the Apple Music API,” MusicKit on the Web — `https://js-cdn.music.apple.com/musickit/v3/docs/iframe.html?path=%2Fstory%2Faccessing-music-content--page`
- **A5:** Apple, “Generating Developer Tokens” — `https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens`
- **A6:** Apple, “Create a media identifier and private key” — `https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key`
- **A7:** Apple, “Create a private key to access a service” — `https://developer.apple.com/help/account/keys/create-a-private-key/`
- **A8:** Apple, “Storefronts and Localization” — `https://developer.apple.com/documentation/applemusicapi/storefronts-and-localization`
- **A9:** Apple, “Handling Requests and Responses” — `https://developer.apple.com/documentation/applemusicapi/handling-requests-and-responses`
- **A10:** Apple, “MusicKit” — `https://developer.apple.com/musickit/`
- **A11:** Apple, “MusicKit Instance,” MusicKit on the Web — `https://js-cdn.music.apple.com/musickit/v3/docs/iframe.html?path=%2Fstory%2Freference-javascript-musickit-instance--page`

## Repository evidence

- `docs/plans/2026-07-13-001-feat-pass-the-aux-roadmap-plan.md`: R9, R10, F3, AE3 and the account-free negative contract.
- `src/resolve.ts`: current destination representation exposes URLs plus a single `complete` boolean; both resolver directions currently return `complete: false`, so export needs richer provenance.
- `src/db.ts` and `migrations/0001_initial.sql`: immutable link rows currently store provider URLs but no provider-specific match kind/catalog ID.
- `src/app.ts`: provider preference is an independent one-year `pref` cookie; handoff falls back to provider search URLs; export must not alter this behavior.
- `src/worker.ts` and `wrangler.jsonc`: Worker/D1 dependency injection, separate staging/production D1 bindings, and existing observability support the proposed isolated adapters and rollout flag.
