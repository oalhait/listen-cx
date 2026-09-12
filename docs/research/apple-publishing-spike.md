# Apple Music web playlist sync research

Research checked September 12, 2026 (UTC); latest live authorization proof is September 11. Branch: `omar/apple-publishing-spike`. This decision supersedes the native publisher investigation below. **The product is web-only:** people collaborate on an ordered Thread on our website, then listen in their existing Spotify or Apple Music app. No companion app, device provisioning, or native publisher runtime is part of the proposed product.

## Recommendation

**Do not promise full Apple Music sync yet.** The public Apple web/server surface supports creating library playlists and appending tracks, but the current documentation exposes no operation that removes tracks or replaces their order on an existing playlist. A stable provider ID and public link across `[A,B,C]` → `[C,A,D]` therefore have no established web implementation. This is a conclusion about the reviewed supported surfaces, not proof that no private commercial agreement could provide one. [Apple playlist API](https://developer.apple.com/documentation/applemusicapi/playlists-api)

**Recreating the entire playlist per revision is technically supported and has an isolated experiment prepared.** A website pointer could select the newest verified playlist for fresh opens. This changes provider identity; it does not update an already-saved Apple reference. Product adoption remains undecided. Keep the website's ordered revision authoritative and continue the separate Spotify route. The broader partner search closes the strongest apparent lead: TuneMyMusic's current compatibility table explicitly limits Apple sync to **Add Only**, contradicting its older blog's removal claim. MusicAPI.com's enterprise API also explicitly lacks the required Apple edits. Apple publishing remains blocked under the current product scope; playlist export is not being restored. The copy/export alternatives below are research comparisons that would require a separate product decision. A separate commercial agreement could reopen full sync only with evidence of capabilities beyond these published restrictions. [TuneMyMusic compatibility](https://www.tunemymusic.com/features/supported), [MusicAPI compatibility](https://musicapi.com/docs/api-basics/supported-features/)

The native spike is stopped regardless of whether its Mac crash could be fixed. Its runtime dependency already violates the web-only requirement. The web experiment below starts fresh browser authorization; native execution remains stopped.

## Thread additions to a connected Apple library, September 12

**Apple documents the operations needed for an additions-only mirror: create a playlist in the consenting user's library, then append songs to that same playlist.** This is the smallest candidate for the new Thread request. The September 11 proof establishes browser authorization and storefront read access only. It does not yet establish any playlist write or updates while the owner is away. The two-playlist recreation experiment remains a separate option for non-append revisions; it is not required merely to add songs.

| Operation | Current official contract | What remains to prove |
| --- | --- | --- |
| Create destination | `POST /v1/me/library/playlists`, with optional initial track relationships; success `201` returns the library resource. | Persist the actual returned ID and verify its initial contents. [Create](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist) |
| Append songs | `POST /v1/me/library/playlists/{id}/tracks`, body `{"data":[{"id":"<catalog ID>","type":"songs"}]}`; success `204`, no response body. The operation adds at the end. | Verify within-batch order and duplicate behavior; neither a positional insertion nor idempotency-key contract is exposed. [Append](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist), [request](https://developer.apple.com/documentation/applemusicapi/libraryplaylisttracksrequest) |
| Verify destination | Read the library playlist and its `tracks` relationship. Follow every `next` page. | Compare the complete sequence, including repeated tracks, using verified catalog identities. Apple warns that writes may take time to appear. [Relationship read](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5l22w), [pagination](https://developer.apple.com/documentation/applemusicapi/fetching-resources-by-page) |
| Remove or reorder | The reviewed REST playlist collection exposes creation and append, with no documented same-ID remove, clear, or reorder operation. | An append adapter must block when the actual playlist is not a prefix of the desired sequence. Recreation changes identity and preserves old copies. [Playlist operations](https://developer.apple.com/documentation/applemusicapi/playlists-api) |

A successful write response is not ordered readback. After an uncertain POST, reread before doing anything else; do not blindly repeat it. The reviewed API supplies no exactly-once write guarantee, and delayed visibility means a still-old read cannot alone prove the POST failed. These are integration requirements, not claims that the current spike implements an append publisher.

### Updates while the owner's browser is closed

**This is the first research gate for the requested behavior.** A foreground MusicKit implementation can catch up while the authorized page runs, but cannot perform work after that page closes. It would not satisfy other people adding songs while the owner is away.

Apple's current authentication guide documents direct HTTP requests carrying both a developer token and a Music User Token; its web guidance delegates user-token management to MusicKit. It does not explicitly establish persistent backend use of a web-issued token. Apple's WWDC explanation describes user tokens as specific to the app and authenticating device, warns against sharing them across devices, and says they may expire or become invalid after subscription, password, or permission changes. Reauthentication can require user interaction. Neither reviewed source supplies a fixed user-token lifetime or unattended refresh-token exchange. The six-month maximum for developer JWTs is a different credential. These sources leave the trusted-backend scope unresolved; they do not justify a categorical claim that all server relays are prohibited. [Authentication](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit), [Apple's token explanation](https://developer.apple.com/videos/play/wwdc2022/10148/)

The next proposed experiment should first test a personalized **read** from a narrowly scoped same-app backend after the owner closes the browser, using consent obtained normally through MusicKit and a deliberate secure token handoff. Also test a refreshed developer JWT and backend restart. Preserve only status, storefront, destination IDs, and readback evidence in the report. This would test technical viability and persistence; a successful HTTP response would not establish indefinite access or resolve Apple's device-scope guidance. Explicit Apple documentation covering this architecture would resolve the support question. No token handoff, server experiment, or outreach was performed for this research.

### Destination and identity boundaries

A library playlist belongs to the user whose Music User Token authorizes the request. For a playlist in each listener's library, each listener needs a separate consented destination; one publisher's playlist is a different product shape. A shared destination also needs independently proven sharing and saved-listener updates. The creation example includes `isPublic`, but the request attribute schema lists only name and description. A returned `isPublic`, `hasCatalog`, or library ID alone does not prove a usable public link. [Creation attributes](https://developer.apple.com/documentation/applemusicapi/libraryplaylistcreationrequest/attributes-data.dictionary), [library attributes](https://developer.apple.com/documentation/applemusicapi/libraryplaylists/attributes-data.dictionary)

The repo's `desiredState()` already exports ordered contributions and a revision, while `thread_publications` currently has one row per Thread/provider. That is not per-user destination state. Its source-only verification correctly leaves Spotify and legacy contributions unresolved for Apple. Start the proof with Apple catalog songs verified in the destination's storefront. Apple's equivalent-ID lookup can resolve cross-storefront Apple availability; ISRC lookup can produce multiple Apple candidates and is not automatic proof of a Spotify match. Preserve ambiguity instead of publishing guessed tracks. [Equivalent Apple songs](https://developer.apple.com/documentation/applemusicapi/get-equivalent-ids-for-the-albums-3ce20), [ISRC lookup](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc)

After the backend gate, the smallest live write proof is one disposable destination: create `[A,B]`, read it, close the owner browser, add `C` through the Thread, and verify `[A,B,C]` on the same Apple ID through complete API readback and the Music app. Replay the same Thread request and verify that no second append occurs. Then test uncertain-write reconciliation and an unsupported reorder without claiming synchronization. Reuse the recreation spike's reservation-before-write and exact-readback discipline; its current reader rejects pagination rather than traversing it, and its two-creation journal does not implement append receipts. These are proposed steps only; no implementation, deployment, invitation, or provider write occurred on September 12.

## Full resync: three different operations

| Meaning of full resync | Supported web operation found | Result |
| --- | --- | --- |
| Replace every track on the same ID | None in the reviewed Apple REST or MusicKit JS documentation | Same-ID removal and reorder remain blocked |
| Clear the same ID, then append the whole revision | Append exists; clear/remove does not | Cannot implement this sequence through the reviewed supported surface |
| Create a new playlist with the whole revision, then switch the website pointer | `POST /v1/me/library/playlists` with initial track relationships | Feasible recreation model; distinct provider identity for every revision |

The [MusicKit JS generic API](https://js-cdn.music.apple.com/musickit/v3/docs/index.html?path=/story/reference-javascript-api--page) accepts `music(path, queryParameters, { fetchOptions })`, so documented POST operations are available even without a convenience helper. It automatically supplies subscriber authorization for personalized requests. The limitation is the absence of a documented replace/clear endpoint, not the absence of generic HTTP access.

Recreation preserves website order by publishing a complete new snapshot and moving the pointer only after readback. That pointer behavior is a design inference, not an implemented Threads feature. A listener reopening the website could reach the newest revision, provided a usable Apple destination URL is available. A listener who already saved the old provider ID has no documented automatic migration path. Saved-listener continuity has not been independently tested. Each revision also leaves another playlist in the publisher's library; no cleanup/delete operation is used or assumed.

### Bounded browser recreation experiment

`spikes/apple-publisher/web-recreate*` is isolated from the Worker, Threads, and native code. It uses the existing ignored four-song fixtures for `[A,B,C]` and `[C,A,D]`, checks catalog availability in the authorized subscriber's storefront, and allows at most two clearly named `DISPOSABLE listen.cx web <run> R<n>` playlists. It requests `isPublic: true` because Apple's [creation example](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist) documents it, but the request attribute schema omits that field and the example response is private. A request flag therefore does not prove public sharing works.

The harness records a reservation before each provider POST, persists returned IDs, and refuses retries after an uncertain creation, including across reloads and server restarts. It rereads actual library contents, compares exact catalog IDs and order, keeps unresolved IDs explicit, and records public/catalog/URL fields. It creates revision 2 only after revision 1 reads correctly and rereads revision 1 afterward. Existing playlists are preserved. A public URL, if returned, must still receive independent public readback before a shareability claim. No saved-follower claim follows from this two-playlist test.

```sh
doppler run --project listen-cx --config dev_personal -- node spikes/apple-publisher/web-recreate-server.mjs
```

Open `http://127.0.0.1:8794` in a normal browser, choose **Authorize Apple Music**, and complete Apple's own sign-in and consent. The two creation buttons remain separate from authorization. **Local harness status:** MusicKit v3 initialized successfully and normal Chrome opened Apple's sign-in popup, but local authorization did not complete. The separate HTTPS direct control subsequently completed authorization and storefront readback, as recorded below; that does not transfer authorization to this local harness. No provider playlist has been created by the web experiment, and ordered/public readback has not run. The Codex in-app browser initialized MusicKit but did not expose its authorization popup; normal Chrome did.

The local server mints 15-minute developer JWTs from the existing Doppler environment and restricts its token route to same-origin browser requests. Private keys stay in the local server; Music User Tokens stay with MusicKit and are not copied into the journal or logs. Same-machine processes are trusted in this local spike. The ignored `.local/web-recreate-journal.json` stores reservations, IDs, and readback evidence. Preserve that file: removing it would remove the two-creation fence.

Validation: nine focused Node tests pass, covering creation request shape, the two-revision limit, duplicate/uncertain IDs, persistence across restart and competing tabs, returned order/unresolved IDs, truncated readback, token isolation, and same-origin restrictions. These fixture tests prove harness behavior only; live playlist creation and ordered/public readback remain pending. No product export flow, Threads publication adapter, native runtime change, deployment, or vendor outreach is included.

### Authorization failure diagnosis, September 11

Repeated authorization failures exposed two harness defects: every rejection was hidden behind the same message, and a resolved `authorize()` call was treated as success without checking `isAuthorized`. Both are corrected. A page left open beyond the developer token's lifetime now reports that condition before attempting consent. Fresh signing validation returned HTTP 200 from the official catalog API with the local Origin header; the new token had approximately 899 seconds remaining. Apple's [token guide](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens) makes the origin claim optional, so its absence alone does not explain the failure.

A fresh in-app-browser reproduction recorded a secure context, 897 seconds of token lifetime, and an active user gesture. The SDK stayed pending and no popup appeared in that browser's tab inventory. The current [official MusicKit v3 distribution](https://js-cdn.music.apple.com/musickit/v3/musickit.js) explains a concrete failure case: when `window.open` returns no window, its authorization promise has neither a close poll nor a rejection path. A regression test reproduced that indefinitely pending promise. The harness now observes the return value during the original synchronous authorization call, immediately restores `window.open`, and rejects with `POPUP_BLOCKED` when no popup was returned. It preserves the original popup arguments and result; it does not disable browser protections or implement a substitute Apple authentication flow.

The page and local `/authorization-diagnostics` endpoint expose only allowlisted error reasons, HTTP/status numbers, token lifetime, user-gesture state, popup outcomes, and trusted Apple callback method names. They never copy callback parameters, token values, raw SDK error messages, credential fields, or authorization URLs. Server observations are bounded and kept in memory, separate from the recreation journal. Tests cover both secret filtering and preservation of `POPUP_BLOCKED` through the local endpoint.

This fixes the harness's pending-popup failure handling; it does not establish that all reported failures had that cause. A normal Chrome attempt opened Apple's popup, but its final outcome could not be read from the available browser surface. Browser authorization and live playlist creation remain unproven. Reload the local page once to load the fix and fresh diagnostics; a normal browser is required if the recorded outcome is `POPUP_BLOCKED`. Sixteen focused authorization, server, and recreation tests pass, plus browser-module syntax and diff checks. No playlist creation or change to Threads occurred during this diagnosis.

### Follow-up: popup opened, then authorization failed

The actual September 11 attempt at 07:10:43.886 UTC returned a popup handle. At 07:11:08.491, 24.605 seconds later, it recorded authorization status `0` and `AUTHORIZATION_ERROR`, with 874 seconds remaining on the developer token. No trusted Apple callback was recorded. This attempt therefore was not the blocked-popup or expired-token case.

The diagnostic listener matches the current SDK's transport: `window` message events from `https://authorize.music.apple.com`, object payloads with `jsonrpc: "2.0"`, and every request method that can resolve or reject authorization. MusicKit collapses rejection details and calls `unauthorize()`, which emits `NOT_DETERMINED` (`0`). That status is not evidence that the user denied permission. Without a callback, the SDK's popup-closed polling path is the strongest explanation. This remains an inference: a [severed window context](https://developer.mozilla.org/en-US/docs/Web/API/Window/open#return_value) can also report `closed: true` while a popup still exists.

Live local headers contain no COOP, COEP, or sandbox policy. The harness preserves the SDK's popup features and adds no `noopener` or `noreferrer`; its Referrer-Policy does not itself sever the opener, and MusicKit explicitly passes the local URL as its referrer query. CSP and localhost request-origin checks do not filter `postMessage`. These checks missed Apple's separate requirement for a browser referrer, established below. Omar subsequently confirmed that the popup closed when he clicked **Allow**. He completed visible consent; this was not a cancellation. At this stage, delivery of that consent result to MusicKit remained unresolved. No further authorization attempt, browser manipulation, or provider creation was performed for this source/code diagnosis.

### Controlled HTTPS-origin experiment

`spikes/apple-publisher/https-auth/` now provides an isolated authorization-only Worker at [the dev probe host](https://listen-cx-apple-auth-spike-dev.omar-alhait.workers.dev). Initially, it used the same developer signing credentials, 15-minute token claims, MusicKit v3 distribution, MusicKit app configuration, and CSP/referrer policy as the local harness. That experiment changed its HTTPS origin and browser session; the later referrer-policy correction is described below. It checks `isAuthorized` after consent, then verifies only `GET /v1/me/storefront`; it has no playlist creation, recreation journal, provider proxy, or local-control routes.

Access requires a short-lived invitation. The private local invitation HTML carries an opaque fragment capability; the probe removes that fragment before loading MusicKit and exchanges it for an HttpOnly, Secure, SameSite=Strict cookie. Token delivery requires that cookie and a same-origin browser request. Other origins, expired sessions, and unknown paths are rejected. The Apple signing key remains local. The Worker receives only an expiring developer JWT and invitation digest as secret bindings; Music User Tokens remain in the browser and never reach this Worker. Diagnostics remain in the browser, including popup-closed and opener-match booleans observed at opening and settlement, never popup URLs or credential content.

The dedicated config has only `env.dev`, an empty route list, disabled preview URLs and observability, seven allowlisted static assets including the direct control, and no database, Durable Object, service binding, or production configuration. It does not use `staging.listen.cx` or alter the Spotify spike. Its compatibility date matches the installed project runtime (`2026-07-13`); the initially selected September date exceeded the local runtime's supported date, so no dependency upgrade was introduced.

Preparation and deployment commands, run from the repository root:

```sh
node spikes/apple-publisher/https-auth/build.mjs
pnpm exec vitest run --config spikes/apple-publisher/https-auth/vitest.config.ts
pnpm exec tsc --project spikes/apple-publisher/https-auth/tsconfig.json
pnpm exec wrangler deploy --config spikes/apple-publisher/https-auth/wrangler.jsonc --env dev --dry-run
doppler run --project listen-cx --config dev_personal -- node spikes/apple-publisher/https-auth/prepare-session.mjs
pnpm exec wrangler deploy --config spikes/apple-publisher/https-auth/wrangler.jsonc --env dev --secrets-file spikes/apple-publisher/.local/https-secrets.json
node spikes/apple-publisher/https-auth/remote-smoke.mjs
```

The private invitation is `spikes/apple-publisher/.local/https-invitation.html`; all session files and generated assets are ignored by Git. It expires with the test token. An expired session requires a newly prepared and redeployed session, not repeated consent against the expired one.

Initial validation: 18 focused Node tests and five Workers-runtime tests passed, alongside the affected TypeScript check and deployment dry run. Tests include no-popup and false-success regressions, opener observation privacy, actual storefront response validation, invitation and cookie gating, expiry, cross-origin isolation, and cross-site landing navigation without cross-site token access. Deployment version `d1a558a2-2685-430a-aaff-541b4c7317ec` served only `listen-cx-apple-auth-spike-dev`. Remote checks at September 11 07:35:22 UTC returned landing **200**, unauthenticated token **401**, foreign-origin session **403**, local publishing-control path **404**, protected session **204**, and protected token **200** with `no-store`. These verified hosting and isolation, not Apple consent.

Both subsequent HTTPS attempts failed with `AUTHORIZATION_ERROR` after the popup closed and without an observed SDK callback. The 07:36:20 UTC attempt opened with 738 seconds of token lifetime remaining. Omar confirmed the 15:23:18 UTC attempt ran in standalone Chrome; it had 690 seconds remaining. Both began with an active user gesture and a popup whose opener matched the host. This rules out a localhost-only or Codex-only explanation. The opener mismatch observed after closure does not establish what caused closure. Neither attempt reached storefront readback.

The `/control` experiment calls `music.authorize()` directly without replacing or inspecting `window.open`. It retains the same SDK, app configuration, token claims, origin, and response headers. Before loading MusicKit, it strips the invitation and restores the same bare-root referrer as the original page. Passive diagnostics classify message origins and distinguish objects from bounded JSON strings, exposing only fixed categories and recognized method names. They do not change the SDK's callback checks or retain payload parameters. The original observer would miss string callbacks and callbacks from alternate Apple origins; their occurrence remains unproven. Tests exercise the actual control module with success, incomplete authorization, and rejection, verify that it leaves browser opening intact, and prevent storefront requests before authorization.

Use `prepare-session.mjs --direct` to prepare the control invitation, followed by the same isolated dev deployment and remote smoke commands above. The remote smoke checks the control's cross-site entry and deployed assets against the checked source. Preserve the failed page's diagnostics before opening a new invitation in a separate standalone-browser tab. Apple's [Media ID setup instructions](https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key) require the signing key to be associated with a Media ID with the required service enabled. No provider playlist has been created by either HTTPS probe.

The direct control also failed: consent started September 11 at 15:36:35.346 UTC and rejected at 15:37:09.124 with `AUTHORIZATION_ERROR`, status `0`, and no window-message events of any recorded shape or origin category. The token had 743 seconds remaining; the page was top-level, secure, had no opener, and did not use MusicKit's reserved service-window name. The popup wrapper is therefore not the sole cause, and no alternative callback transport was observed. Private metadata comparison confirmed that this token's signing key and issuer match the configured key and team, with ES256 and a 900-second lifetime. Catalog readback succeeded with that signer. Portal inspection was initially unavailable, so the key association was unverified at that point. The subsequent evidence below confirms the association was already configured; it does not explain or resolve the missing callback. No key or account configuration was changed by this audit.

### Consent callback requires a browser referrer

The September 11 attempt starting at 16:49:16.823 UTC paused inside the parent SDK's `requestUserToken()` rejection handler before cleanup. Its rejection was numeric `0`, the popup reference reported closed, and the capture listener had recorded no window messages. In the current SDK, callback-based rejection would pass that listener; the evidence therefore supports the popup-close polling path, not an explicit denial. The preserved logout 403 belonged to an earlier attempt and does not explain this rejection.

Apple's live [consent-page bundle](https://authorize.music.apple.com/assets/index.08057262.js) initializes its callback destination from `document.referrer`. It accepts the SDK's explicit referrer query only when a browser referrer already exists with the same origin. Its [bundled StoreKit](https://authorize.music.apple.com/assets/vendor.c5b156fd.js) requires that stored destination to establish messaging. Without it, consent can store the result locally and close the popup without sending the parent an authorization callback. An isolated evaluation of Apple's actual initializer with dummy data confirmed that an empty browser referrer leaves the destination unset despite the query; supplying the matching origin stores it.

The HTTPS probe previously sent `Referrer-Policy: no-referrer`, suppressing the browser referrer Apple needs. It now serves only its two authorization HTML pages with `strict-origin`, which sends the HTTPS origin without paths, queries, or fragments. The invitation, scripts, token/session responses, and errors retain `no-referrer`; neither HTML page contains a referrer meta override. The Worker regression test failed under the old policy and passed after the correction. Remote smoke also checks the page and protected endpoint policies. The local harness and production application did not receive this header change.

The corrected live attempt on September 11 at 19:41:08.412 UTC restored `thirdPartyInfo`, `authorize`, and `close` callbacks from Apple's expected origin. MusicKit briefly emitted authorization status `3`, then its internal `GET /v1/me/storefront` returned HTTP **403**, code **40300**, with `Invalid authentication`. MusicKit reset authorization and rejected before the probe's explicit storefront readback. The following logout 403 was cleanup. This verifies callback delivery, but neither completed authorization nor an accepted user token. Status `3` alone only confirms that the SDK received a nonempty token string.

Both required request headers were present. The request's developer-token key, team, issuance time, and expiry matched the prepared session. At 19:45:01.959 UTC, that session's developer token returned HTTP **200** with catalog data using the same probe Origin. The SDK passes the callback token directly into its user-token header. These checks do not identify why Apple rejects the user authorization; an account/grant problem and a user-token/developer binding problem remain unresolved. A controlled second-subscriber comparison with the same app/key would help distinguish account-specific failure from a shared failure. No further consent, key rotation, or provider write was attempted during this inspection.

The direct control now includes a passive credential-pairing observer installed before loading MusicKit. During one authorization attempt it compares the first internal storefront request's developer token with the configured token and its user token with the fresh Apple callback. Comparisons use transient in-memory SHA-256 digests; diagnostics contain only match booleans, callback presence, HTTP status, and the fixed Apple error code `40300` when present in a bounded response copy. It forwards fetch arguments and the returned promise unchanged, does not alter popup handling, and sends no extra provider requests. This checks transport pairing; it does not establish that Apple issued a valid user grant or prove the popup received the configured developer token at runtime. The successful live comparison is recorded below.

The diagnostic normalizer now recognizes the SDK's exact plain-string storefront rejection as `STOREFRONT_READBACK_FAILED`, preserving a null HTTP status because the SDK discards it. A regression test verifies both that classification and continued redaction of arbitrary strings. The normalizer is deployed in the isolated dev probe; the earlier live 403 response code above came from the preserved browser Network entry.

### Successful web authorization and storefront readback

On September 11 at **23:34:50 UTC**, Omar's supplied safe diagnostics from the isolated HTTPS direct control confirmed completed authorization on deployment `6d354fca-fae4-4d19-9b72-108fa00eafb7`:

| Evidence | UTC time | Result |
| --- | --- | --- |
| Fresh Apple authorization callback | 23:34:50.114 | Callback received; SDK status `3` followed |
| Credential pairing | 23:34:50.116 | Fresh callback observed; outgoing developer token matched configuration; outgoing user token matched the callback |
| SDK's internal storefront request | 23:34:50.382 | HTTP **200** |
| `authorize()` completed | 23:34:50.383 | Authorization succeeded; final `isAuthorized` was `true` |
| Explicit storefront readback | 23:34:50.609 | Succeeded with storefront **`us`** |

The referrer-policy correction is proven to restore Apple callback delivery. The subsequent `40300` rejection also cleared, but its exact cause remains unknown: the successful attempt used an unchanged instrumented probe with a refreshed short-lived session. The passive observer verifies credential pairing; it is not an authorization fix. This result proves web authorization and personalized read access for this session. Playlist creation, exact ordered readback, public sharing, and any Threads publishing integration remain unverified. No provider write was performed during this authorization test.

### Verified Apple identifier mapping

Omar's September 11 portal screenshots show the key's existing selection as `listen cx media (ZW4CL8J474.media.cx.listen.web)` and the separate Media ID detail page as `media.cx.listen.web` with MusicKit checked. Omar confirmed this selection was already present. Subsequent read-only computer inspection independently confirmed key `MQD54KX5GH` under team `ZW4CL8J474`, its association with that Media ID, and the Media ID's checked MusicKit setting. A read-only comparison against Doppler `listen-cx / dev_personal` found the same bare Media ID already stored in `APPLE_MUSIC_MEDIA_ID`; it was not added during this investigation. The probe token's key ID and issuer also match the configured values below.

| Identifier | Verified value | Storage and use |
| --- | --- | --- |
| Web Media ID | `media.cx.listen.web` | Apple portal and existing Doppler `APPLE_MUSIC_MEDIA_ID`; associated with the Media Services signing key. The isolated web harness does not read this variable or send it as a JWT claim. |
| Developer team | `ZW4CL8J474` | Existing Doppler `APPLE_MUSIC_TEAM_ID`; used as developer-token `iss`. The portal displays it as the prefix before the Media ID. |
| Media Services signing key ID | `MQD54KX5GH` | Existing Doppler `APPLE_MUSIC_KEY_ID`; used as JWT header `kid`. The private `.p8` signing material is stored separately and is not recorded here. |
| Native experiment App ID / bundle ID | `listen-cx` | Existing App ID reused by the earlier native experiment through a local build override. It identifies that signed app and is not supplied to the web authorization flow. |

The checked-in Xcode project defaults `PRODUCT_BUNDLE_IDENTIFIER` to `cx.listen.ApplePublisherSpike`; its `Native/Info.plist` reads that build setting. The earlier signed experiment overrode it with `listen-cx`. This dormant native setup is distinct from the web Media ID, and the native publisher remains stopped.

`token-helper.mjs` creates only the ES256 header fields `alg` and `kid`, and payload fields `iss`, `iat`, and `exp`. Both HTTPS pages configure MusicKit with that developer token plus `app.name` and `app.build`; neither supplies a native bundle ID or substitutes one for a Media ID. The Media ID association exists in Apple's key configuration. These checks establish no missing Media ID configuration or need for an additional JWT claim; the authorization failure remains unresolved. This mapping is now documented here; no runtime, Doppler value, or signing configuration changed.

The same Doppler config already contains `APPLE_MUSIC_ALLOWED_ORIGINS`, currently one origin: `https://staging.listen.cx`. It includes neither the dev probe origin nor localhost. The isolated token helper does not read that variable, and the actual probe JWT has no `origin` claim, so this list is not applied to the probe's token. Apple's [developer-token guide](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens) makes that claim optional. The unused list therefore does not establish an origin-restriction failure; no origin setting or token claim was changed during this audit.

## What the supported Apple surfaces provide

| Surface | Documented behavior | Consequence for this product |
| --- | --- | --- |
| Library playlist creation | Create a new playlist with initial track relationships | Suitable starting point for a revision export; it creates a new identity |
| Add tracks | Append to the end of an existing library playlist | Cannot remove B or move C before A in the example |
| Add a resource to a library | Add catalog resources to the subscriber's library | Does not replace an owned playlist's track list |
| MusicKit JS v3 | Authorized access to Apple Music API and web playback | No additional documented full-playlist edit surface; playback queue edits are not saved playlist edits |
| Catalog/shared playlists | Read playlist resources and expose provider sharing semantics | A readable catalog ID or public URL does not confer edit permission |
| Apple-native collaboration | Participants edit through Apple's product | Does not expose the required website writer; also changes where collaboration happens |

The fresh [playlist topic index](https://developer.apple.com/documentation/applemusicapi/playlists-api) still lists creation, track addition, and adding resources under its create/modify group. The [create endpoint](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist) accepts initial tracks; the [track endpoint](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist) specifically appends them. Both require subscriber authorization. Creation and additions need subsequent readback before we can claim a revision is present. The [library resource-add endpoint](https://developer.apple.com/documentation/applemusicapi/add-a-resource-to-a-library) is not a playlist replacement operation.

This check builds on the [existing endpoint inventory](apple-music-endpoint-inventory.md), rather than inferring capability from generic HTTP methods. The current [MusicKit JS v3 reference](https://js-cdn.music.apple.com/musickit/v3/docs/index.html?path=/story/reference-javascript-api--page) and its public documentation bundle demonstrate `music.api.music(...)` calls into Apple Music API and authorize access to Cloud Library. Supplying a different fetch method does not establish a supported endpoint. The reviewed [WWDC26 MusicKit session](https://developer.apple.com/videos/play/wwdc2026/254/) covers native integration, authorization, music selection, catalog requests, playback, and sharing; it supplies no web/server replacement or removal operation.

For an approved export implementation, a server would sign developer tokens and keep the private key server-side. MusicKit JS handles subscriber authorization and decorates personalized requests with the Music User Token. Neither our site's login nor possession of a developer JWT grants library access. Any later server-side subscriber operation would need its own token handling and reauthorization behavior; this research establishes no permanent background authorization guarantee. [Developer tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens), [subscriber authentication](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit)

### Sharing and collaboration do not supply a writer

Apple documents participants adding, removing, and reordering songs in [collaborative playlists](https://support.apple.com/en-us/118494). However, an Apple DTS engineer's October 2025 [API clarification](https://developer.apple.com/forums/thread/798693) says collaborative playlists have `canEdit=false` in those APIs and requests an enhancement for editing support. No newer public operation resolving that restriction was found in this review. A normal playlist's `canEdit=true` should likewise not be interpreted as permission to call undocumented removal or reorder routes.

Apple's [sharing guide](https://support.apple.com/en-gb/guide/iphone/iphe5a418a82/ios) describes shared-playlist updates reaching followers. Our earlier Mac UI experiment observed one added song at the same public URL. Neither fact provides a web writer, and our experiment did not check a second subscriber's previously saved entry. A saved shared reference, a newly copied personal playlist, and an Apple collaborative playlist must remain distinct in the design.

Editorial, external, and user-shared catalog [playlist types](https://developer.apple.com/documentation/applemusicapi/playlists/attributes-data.dictionary) are resource classifications, not a documented self-service publishing permission. No catalog/curator API granting arbitrary websites full edits was found. Changing the redirect behind a stable `listen.cx` URL also cannot move an Apple subscriber's existing saved reference to a different provider playlist.

## Existing services and integration availability

| Service | Actual integration surface found | Apple removal / order / identity / followers | Decision |
| --- | --- | --- | --- |
| Soundiiz | Public import links, beta User API, business partner program | Explicitly disallows Apple track removal and sorting; no full-mirror path established | Possible export handoff, not full sync |
| TuneMyMusic | Consumer web transfer and scheduled sync; business inquiry channel | Current compatibility table says Apple sync is Add Only; older removal claim contradicted | Published product does not meet full sync |
| MusicAPI.com | Enterprise API with provider-specific feature matrix | Apple playlist update, delete, track removal, and movement explicitly unsupported | Embeddable API exists, required Apple capability does not |
| SongShift / Apple's built-in transfer | SongShift's consumer iPhone/iPad app; Apple now also offers transfer in its existing apps and on the web | Import workflow documented; no continuous same-ID publishing or public integration contract established | Useful migration option, not website-driven mirroring |
| Parachord | Open-source player and sync implementation | Its current published Apple behavior is add-only; no removal or reorder | Evidence of the same limitation, not a web publishing solution |

**Soundiiz:** its support article updated September 4, 2026 explicitly says Apple playlists cannot have tracks removed or be sorted through Soundiiz. Its generic Replace sync needs removal permission; Add mode retains existing tracks. Thus its general platform read/write labels and sync marketing do not satisfy our edit contract. [Current restrictions](https://support.soundiiz.com/hc/en-us/articles/8493033465746-Soundiiz-Error-104-Can-t-Delete-Rename-or-Remove-Duplicates-on-Some-Platforms), [sync semantics](https://support.soundiiz.com/hc/en-us/articles/360010006193-How-Soundiiz-Playlist-Sync-Works-Direction-Add-vs-Replace-and-Frequency)

Soundiiz does have real developer surfaces. Its [User API](https://soundiiz.com/api/doc) uses a Creator account's personal API key; the inspected playlist CRUD operates on **Soundiiz playlists**, not direct Apple playlists. Sync endpoints list, retrieve, delete, and trigger existing eligible syncs; no sync-creation operation was present in the inspected specification. Its [public import API](https://soundiiz.com/api/doc/public_import) accepts a tracklist and returns a temporary import URL, suitable for a user-completed export flow. Its [partner program](https://soundiiz.com/partners) is a real contact route, but does not document an exemption from the Apple restrictions. Personal API access should not be assumed to license a multi-user embedded product.

**TuneMyMusic — lead resolved:** its current [Supported Music Services table](https://www.tunemymusic.com/features/supported) labels the Apple row's Sync column **Add Only**. This provider-specific restriction is decisive over the generic [Mirror sync page](https://www.tunemymusic.com/features/sync) and the [Spotify-to-Apple guide](https://blog.tunemymusic.com/how-to-transfer-spotify-playlist-to-apple-music/), last updated October 24, 2024, which claims Apple destination removals. The published product cannot satisfy the example revision change. Full order replacement, stable-ID mirror edits, and saved-follower propagation were not demonstrated.

The expanded search covered API, business, white-label, partnership, same-playlist, Apple removal, and order terms, plus the official homepage, help, compatibility, sharing, sync, contact, and terms pages. No public developer integration specification was found. Its [published terms](https://www.tunemymusic.com/terms-of-use) say, “This service cannot be used to develop a third party site.” The [business inquiry form](https://www.tunemymusic.com/contact-us) exists, but a separate agreement and extra Apple capabilities remain hypothetical. No inquiry was sent. Its [sharing flow](https://www.tunemymusic.com/features/share) lets recipients open the original playlist or import a copy into their library; that is not a guarantee that an imported copy follows later edits.

The topology `website Thread → our Spotify playlist → TuneMyMusic → Apple playlist` therefore also fails full sync under the published Add Only restriction. It adds a replication step, matching, and scheduled delay without supplying removal. Generic homepage claims about official APIs and order preservation do not override the platform-specific table or establish an embeddable Apple writer.

**MusicAPI.com:** this is an actual enterprise integration API, but its [feature matrix](https://musicapi.com/docs/api-basics/supported-features/) marks Apple playlist updates, playlist deletion, track removal, and track movement unsupported. A generic update endpoint must be read with this service matrix; its existence is not proof of Apple support. This rules out the documented API for our required full sync.

**Parachord:** the author's June 25, 2026 [sync account and capability table](https://parachord.com/blog/2026/06/25/keeping-playlists-in-sync/) explicitly describes Apple mirrors as add-only, without removal or reorder. The current repository guide additionally records a failed Apple `PUT` path falling back to appending, leaving removals remote. This corroborates a degraded implementation, not successful full sync. [Repository behavior notes](https://github.com/Parachord/parachord-mobile/blob/main/CLAUDE.md)

**SongShift and built-in transfer:** SongShift's [FAQ](https://www.songshift.com/faq) describes its iPhone/iPad application and points to Apple's transfer feature. Apple's [March 31, 2026 guide](https://support.apple.com/en-us/118249) supports transfers through existing Apple Music apps and `music.apple.com`, with user selection and review of alternate matches. Only user-created playlists transfer. This avoids installing our app for a migration, but the guide supplies neither a continuous sync contract nor an API for our arbitrary Thread revisions. An established Apple integration does not imply that SongShift exposes equivalent rights to another website.

## Explicit compromises

These are alternatives for Omar to choose, not accepted replacements for full sync.

| Option | What the user gets | What changes from the requested contract |
| --- | --- | --- |
| Export the current revision as a new Apple playlist | A copy playable in the existing Apple Music app | Subsequent website edits do not update it; exporting again creates a different playlist |
| Append-only destination | One stable playlist accumulating new songs | Removals, reorder, and insertion before existing tracks diverge from the Thread |
| Create a new published playlist per revision | A newly verified snapshot behind the website's current link | Old public IDs and subscribers' saved references remain on old revisions |
| Collaborate directly in Apple Music | Apple's own playlist editing experience | Website no longer owns those edits; does not unify the Spotify audience |
| Play the Thread through MusicKit JS | Website can present its current playback order | Listening happens in the website rather than the requested existing provider app |
| Open individual Apple song links | Existing-app access to selected songs | No synchronized playlist |

If a future product decision allows this compromise, snapshot export could authorize on the website, resolve and confirm Apple catalog entries, create a playlist for one explicit revision, then verify the ordered returned contents before showing success. It would expose unmatched/unavailable songs instead of silently substituting recordings. Existing cross-provider catalog candidates remain candidates until verified. This is an out-of-scope alternative, not a completed live export test; exact order, duplicates, empty lists, storefront behavior, and app-opening behavior would need focused validation.

## What would reopen the commercial path

### Follow-up investigation: additional routes checked September 10

The resumed investigation checked routes beyond the already excluded Soundiiz, TuneMyMusic, and MusicAPI products. None supplied a documented web writer ready for an authorized mutation experiment. No browser consent, native execution, provider write, or change to Threads was needed for these checks.

| Newly examined route | Primary evidence | Remaining unknown or reason it does not qualify |
| --- | --- | --- |
| Playlisty Replace Mode | The vendor describes removal/reorder mirroring using new iOS 16/iPadOS 16 playlist APIs, with app-created-playlist restrictions and no Mac support | Real native capability; requires an excluded publisher runtime. No supported server/browser replacement API established |
| Linkfire partner API | Limited-partner API documents campaign links, marketing assets, properties, and cross-service scans | Real API and Apple partnership, but published operations do not write Apple playlist contents. Extra commercial capability is unknown |
| SongShift commercial integration | Current homepage describes syncing additions; the consumer offering and Apple import integration are established | No public server API, same-ID replace operation, or saved-follower contract found. A commercial offering remains a qualification question |
| Apple Music for Artists Set Lists | Apple's web tool creates and orders playlists for an artist's actual shows/tours | Restricted artist workflow and repertoire purpose; no arbitrary Thread publishing API established |
| Tuned Global playlisting | Business playlist tools use its licensed repertoire, CMS, apps, and APIs | Controls playlists in a separate music service, not the listener's existing Apple Music library |

[Playlisty's explanation](https://obdura.com/home/support/playlisty/replace-mode/) is particularly useful because it distinguishes a real replacement feature from a web implementation: the feature comes from native iOS APIs and works on playlists created through its new mode. This is supporting documentation only; no app was installed or run.

Apple confirms its [Linkfire partnership](https://artists.apple.com/support/3395-value-linkfire-links) is for smart links and landing pages. Linkfire's [developer introduction](https://developer.linkfire.com/docs/introduction) and [endpoint categories](https://developer.linkfire.com/) match that scope. Marketing-link updates and scans do not establish writes to the destination playlist. The documented access contact is `api@linkfire.com`; documentation support is `api-support@linkfire.com`.

SongShift's current [homepage](https://www.songshift.com/) describes its ongoing sync as additions and lists `support@songshift.com`. Its partnership does not establish that another website can use an equivalent integration. The [Apple Set Lists guide](https://artists.apple.com/support/5466-promote-shows-set-lists) limits tracks to songs performed at the artist's show or tour. Neither that tool nor Linkfire should be repurposed as a generic playlist-publishing permission. [Tuned Global's business playlist tool](https://www.tunedglobal.com/streaming-services/playlisting-tool-for-business) instead describes its own licensed playback environment, which changes the listening product.

Broad API/white-label searches also surfaced Welele's indexed enterprise API-access claim, but its public site returned HTTP 403 to direct inspection and no readable API specification or same-ID edit contract was found. That lead is **unqualified**, not evidence of a working route or a recommendation to buy access. [Vendor site](https://flowelele.com/)

### Browser MusicKit: the apparent replacement methods change playback

The fresh [MusicKit JS v3 instance reference](https://js-cdn.music.apple.com/musickit/v3/docs/iframe.html?path=%2Fstory%2Freference-javascript-musickit-instance--page) documents `setQueue`, `clearQueue`, `playAt`, `playNext`, and `playLater`. Their return values and state are the current playback `Queue`; `setQueue` accepts songs or a catalog resource. `clearQueue` even leaves the current item playing. These operations can change a browser's playback sequence but provide no documented persistent playlist ID or saved-follower update operation.

The v3 documentation's Cloud Library section directs calls through the Apple Music web service using `v1/me/library` paths. No additional playlist removal/reorder entry point was found. A browser demo that changes its local queue from `[A,B,C]` to `[C,A,D]` would prove playback behavior only. It would not meet this spike's acceptance criteria, so no such playback substitute demo was run. The separate recreation experiment above tests a deliberately different provider-identity model. No undocumented HTTP methods were probed.

### Commercial outreach is not being pursued

Omar explicitly ruled out contacting Apple or SongShift. The previous unsent outreach drafts have been removed; no message was sent and no new draft is planned. The active work is the supported browser recreation experiment above. Same-ID commercial acceptance criteria below remain a reference if independently obtained capabilities ever change the evidence.

### Qualification and acceptance after a positive answer

Require a written answer distinguishing current Apple support from generic sync features. Establish whether the integration accepts exact catalog IDs or rematches tracks, whether a Spotify source is required, whether we can trigger and observe jobs, and how revocation, retries, rate limits, stale jobs, and ambiguous creation are reported. The mechanism must be a supported commercial API; private endpoint replay, copied first-party sessions, user credentials, or UI automation are outside this design.

Acceptance must independently establish:

1. A web-authorized initial `[A,B,C]` destination with recorded provider ID, public URL, full ordered readback, and a saved reference on a second independent Apple subscriber account.
2. Browser closure and no custom native runtime; the next website revision `[C,A,D]` reaches **that same** destination. Verify B absent, D present, and C before A both through publisher readback and the second account's previously saved entry.
3. Actual propagation delay and required refresh behavior. A new playlist with the same name, updated website redirect, logged-out page alone, or publisher-only success does not pass.
4. Repeated revisions, duplicates, empty lists, missing tracks/storefront mismatches, authorization revocation, and interrupted operations. Failure must remain visible and must not silently create replacement destinations or claim a partial revision is synchronized.

Without that evidence, keep Apple full-sync capability unavailable. This document changes research guidance only; it does not alter the Worker, storage, UI, provider clients, or existing playlists.

## Historical native publisher investigation — stopped

Everything below records the earlier developer experiment. Its device instructions are archived reproduction notes, **not current next steps**. Do not resume native setup, run the publisher, reset its ambiguous creation journal, or perform playlist writes under this web-only research task.

September 9, 2026. Branch: `omar/apple-publishing-spike`. Experimental developer harness; no deployment. The spike attempted one native playlist creation on iOS-on-Mac and crashed inside Apple’s framework; no successful native creation or readback was established. A separate Mac Music UI experiment created and added songs to one disposable playlist, as recorded below.

Mac Music testing proves playlist creation, public sharing, and an added song appearing at the same logged-out public URL. The native publisher also builds, passes its local reconciliation tests, and receives changed desired revisions in the iOS simulator. Whether our publisher-side companion can serve listeners who never install it remains **unproven**: native creation fails on the tested Mac route, while physical-iOS app ownership and second-account saved-playlist propagation have not been demonstrated.

### Evidence and remaining gates

| Layer | Actual result |
| --- | --- |
| Mocked reconciliation | 17 Swift tests pass: identity, remove/reorder, repeat/stale/conflict handling, duplicates, empty requests, unavailable tracks, delayed ordered readback, interrupted create/edit, relaunch, persistence/corruption, concurrent-call rejection, readback identity and URL constraints |
| HTTP contract | Node test opens a real loopback socket; reads revision 1 and changed revision 2; verifies no-store, read-only routes, unavailable/invalid fixture handling |
| Native build | Xcode 26.2 / Swift 6.2.3: simulator arm64 + x86_64, unsigned arm64 iPhoneOS, and signed Designed for iPad Mac builds succeeded |
| Native local handoff | iPhone 17 Pro simulator, iOS 26.2: app installed and launched; clicking Fetch displayed “Desired JSON fetched; no provider write performed.” Changing the fixture and fetching again displayed revision 2 and `[C,A,D]` |
| Authenticated catalog | Existing Doppler `listen-cx` / `dev_personal` Apple developer credentials signed a short-lived ES256 token. Read-only US catalog request returned HTTP 200 and both configured track IDs (2/2). No secret values in this document |
| Mac Music creation / sharing / addition | **Verified through Apple’s Mac UI and logged-out web**: one disposable playlist, same public URL before and after adding its fourth song |
| Mac Music removal / reordering | **Not verified**: removal attempts left rows unchanged; reorder automation failed twice with `noWindowsAvailable` |
| Spike MusicKit create / readback / edit | **Create attempted once and crashed** in a missing Apple framework class; pending revision 1 has no ID. Readback and revision-2 edit were not reached |
| Spike app ownership / app-created sharing | **Not verified**: native creation returned no ID; the earlier public playlist belongs to the Music-app experiment |
| No-cable native route | **Launch and preflight verified** through Xcode My Mac (Designed for iPad); native create aborts on macOS 26.5.2. Automatic tokens fail; an explicit short-lived developer-token override enables US storefront/subscription/catalog access |
| Second-account saved-playlist propagation | **Not run**: logged-out web visibility does not demonstrate a saved reference updating for a subscriber |
| Foreground/background timing | Foreground HTTP handoff and native preflight observed; creation crashed, so no successful mutation timing. No background scheduling implemented or tested |

`xcrun devicectl list devices` still returns “No devices found,” but the Mac destination works through Xcode. Omar registered the Mac, and an iOS development profile was created and installed for the existing MusicKit-enabled `listen-cx` App ID and valid Apple Development identity. The Doppler Apple private key is a separate developer-token credential, not application signing or Music User Token authorization.

### Mac Music UI experiment

This completed behavior test used Apple Music on the Mac and required no iPhone/iPad. It did not execute the spike’s native MusicKit adapter or create a playlist owned by our app.

The disposable playlist is **listen.cx Mac publishing test 2026-09-09**, with this [public Apple Music URL](https://music.apple.com/us/playlist/listen-cx-mac-publishing-test-2026-09-09/pl.u-oZylKN9IRE7MA62). Its initial ordered rows were:

1. Raid (feat. MED) — Madvillain
2. Lonesome Town — Ricky Nelson
3. Zombies — Childish Gambino

The sharing URL opened while logged out. After adding **Sleepwalk (Remastered 2010) — Santo & Johnny** through Mac Music, refreshing that same URL showed all four rows in the order above, with Sleepwalk fourth. This verifies public sharing and addition propagation for this playlist without changing its public URL. No propagation latency was measured.

Explicit **Remove from Playlist** attempts did not change the visible rows, so removal was not established. BackSpace produced a broader Cloud Music Library deletion warning; that operation was **cancelled**. Drag/reorder attempts were blocked twice by the UI automation server’s `noWindowsAvailable` error despite readable screenshots and accessibility state. That is an automation limitation, not evidence that Apple Music cannot reorder playlists.

The observed final playlist therefore contains the four songs above. There was no successful removal/reorder result, second-account save, follower propagation observation, our-app ownership proof, or native MusicKit publisher execution. A logged-out visitor seeing updated public rows is a narrower result than a subscriber’s previously saved playlist updating. The Mac result also does not prove that our native app can edit this Apple Music-created playlist.

### Current Apple constraints

Apple documents native playlist rebuilding through [`MusicLibrary.edit(..., items:)`](https://developer.apple.com/documentation/musickit/musiclibrary/edit(_:name:description:authordisplayname:items:)) and restricts edits to playlists the app created. The installed iPhoneOS 26.2 SDK explicitly marks the creation and edit methods unavailable on macOS and Mac Catalyst. The spike targets iOS APIs and has no macOS or Mac Catalyst port. Running that iOS binary through “Designed for iPad/iPhone” is a separate candidate, investigated below.

Native MusicKit can manage API tokens after the app's explicit bundle ID enables the [MusicKit App Service](https://developer.apple.com/documentation/musickit/using-automatic-token-generation-for-apple-music-api). The harness defaults to this mechanism and requests native user consent. An explicit local developer-token override is available for the observed automatic-token failure; it does not copy Doppler private keys into the app.

Readback uses MusicKit's authenticated `MusicDataRequest` against library playlist tracks. Catalog song resources use their catalog ID; library-song resources require `attributes.playParams.catalogId`, as shown in Apple's [library songs example](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-songs). Missing identity fails verification rather than guessing from titles, ISRCs, or library IDs. Every page must belong to the original playlist-tracks endpoint. This mapping and the relationship between native and REST playlist IDs still require real-account verification.

Apple describes sharing playlists and updates appearing for followers in its [iPhone sharing guide](https://support.apple.com/en-gb/guide/iphone/iphe5a418a82/ios). That supports the experiment; it does not establish that this app-created playlist can be shared or subscribed to successfully. The app only offers the provider-returned URL when present; it never fabricates a public URL or marks a playlist public. The manual Music app share step is part of acceptance.

[Background notification delivery is not guaranteed](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app). This console fetches/publishes only on button presses. It has no background modes, periodic job, push registration, or latency promise. Scene transitions print timestamps for a future device experiment; successful publisher readback reports elapsed time.

### No-cable native execution investigation

The existing iOS app now builds, installs, and launches on this Mac without a cable. MusicKit authorization and read-only preflight succeed with an explicit developer-token override, but the first native playlist creation aborts in an unavailable Apple framework class. Setup created a development provisioning profile after Omar registered this Mac; no library mutations occurred during setup.

| Route | Evidence | Current boundary |
| --- | --- | --- |
| Previously paired wireless iPhone/iPad | `devicectl` found no devices; `xctrace` listed only this Mac and simulators; Xcode listed no concrete physical iOS destination | No wireless device is currently discoverable. This does not prove that none was ever paired |
| iOS Simulator | The installed SDK compiles the required signatures, and the app’s HTTP handoff runs. Apple’s [MusicKit library sample](https://developer.apple.com/documentation/musickit/explore-more-content-with-musickit) explicitly does not work in Simulator; its [newer integration sample](https://developer.apple.com/documentation/musickit/integrating-musickit-into-your-app) carries the same restriction | No authenticated MusicKit library execution established. SDK compilation and simulated UI are not provider capability evidence |
| iOS app on Apple silicon Mac | `xcodebuild -showdestinations` exposes **My Mac**, arm64, variant **Designed for [iPad,iPhone]**, for this unchanged target | Signed launch and overridden-token preflight verified; native creation aborts because `MPModelLibraryPlaylistEditChangeRequest` is absent |
| Native macOS / Mac Catalyst port | The installed SDK marks `MusicLibrary.createPlaylist` and playlist `edit` unavailable for those targets | Not a supported implementation of the required native edit API; no port added |

Apple documents [running an unmodified iOS app natively on Apple silicon](https://developer.apple.com/documentation/apple-silicon/running-your-ios-apps-in-macos). It is not Simulator and does not require recompiling the app as Mac Catalyst. Apple also warns that feature availability must be tested on the actual platform. The shared underlying framework infrastructure, or the presence of the iOS method at compile time, does not establish that playlist rebuilding works in this execution environment. The first native creation attempt now establishes an API-specific runtime failure on the tested macOS 26.5.2 / iOS SDK 26.2 combination; it does not prove that every OS release behaves the same way.

#### Signing and installation completed

The valid Apple Development certificate belongs to team `ZW4CL8J474`. The initial profile failures were resolved by reusing the existing explicit `listen-cx` App ID rather than creating `cx.listen.ApplePublisherSpike`. Omar completed the annual device review and registered this Mac. The agent then created **listen-cx Apple Publisher Mac Development**, using the existing development certificate and only this Mac as the provisioned device, downloaded it, and installed it in Xcode's user provisioning-profile directory. No device was removed or reset by the agent.

The profile's application identifier is `ZW4CL8J474.listen-cx`, `get-task-allow` is true, and the profile expires September 10, 2027. Its device identifier matches Xcode's Mac provisioning UDID, which differs from the hardware UUID. Apple documents the required identifier in its [Apple silicon device registration guide](https://developer.apple.com/help/account/devices/register-a-single-device).

This signed command succeeded without modifying the repository's project settings:

```sh
xcodebuild -project spikes/apple-publisher/ApplePublisherSpike.xcodeproj -scheme ApplePublisherSpike -destination 'platform=macOS,name=My Mac' -derivedDataPath spikes/apple-publisher/.local/DesignedForIPad DEVELOPMENT_TEAM=ZW4CL8J474 PRODUCT_BUNDLE_IDENTIFIER=listen-cx CODE_SIGN_STYLE=Manual PROVISIONING_PROFILE_SPECIFIER='listen-cx Apple Publisher Mac Development' build
```

Direct LaunchServices opening of the raw `Debug-iphoneos` app failed with `-10661` (no compatible executable). Xcode's **My Mac (Designed for iPad)** Run action successfully installed the iOS wrapper and launched the app. For this GUI run, an ignored `.local/MacRun/` project references the same source files with local signing overrides; the checked-in project remains unchanged. Before launch, no matching installed app or existing `listen-cx` container was found. The running app fetched the real revision-1 fixture and displayed MusicKit authorization `.authorized`. No authorization prompt was captured or clicked by the agent.

#### Automatic MusicKit token failure

The new **Check MusicKit access** action runs read-only storefront, subscription, and catalog preflight without calling the publisher or writing a journal. At `2026-09-10T05:11:25Z`, `MusicDataRequest.currentCountryCode` failed with `.developerTokenRequestFailed`. Process logs showed `ICError -8200`, token-service HTTP 404, and payload `Client not found`, status `40402`, identifying `listen-cx` as the unrecognized client. No native catalog request or subscription check succeeded in this attempt; authorization alone does not prove either.

Authenticated read-only portal reinspection confirmed the explicit App ID `listen-cx`, team `ZW4CL8J474`, and **MusicKit checked** in App Services. The built app's `CFBundleIdentifier` also equals `listen-cx`. No service was toggled, App ID recreated, or credential reset. Apple's [automatic-token setup guide](https://developer.apple.com/documentation/musickit/using-automatic-token-generation-for-apple-music-api) requires that matching registration. An [Apple engineer's explanation of this exact error](https://developer.apple.com/forums/thread/705056) recommends checking the bundle-ID match. Those checks pass here, so the remaining failure is unresolved; it does not establish an iOS-on-Mac create/edit limitation.

#### Supported token override and first native creation

Apple exposes [`MusicDataRequest.tokenProvider`](https://developer.apple.com/documentation/musickit/musicdatarequest/tokenprovider) and [`MusicDeveloperTokenProvider`](https://developer.apple.com/documentation/musickit/musicdevelopertokenprovider). The explicit **Use local developer token** button installs a provider that inherits Apple's `MusicUserTokenProvider` for user authorization and obtains only the developer JWT from `127.0.0.1:8791`. This selection applies to the current process; automatic mode remains the default after relaunch. The SDK's shared token-provider property lacks Swift concurrency annotations, so this console imports MusicKit with `@preconcurrency`; selection happens on the main actor and the button is disabled while another console action is running.

`token-helper.mjs` uses the existing Doppler Apple signing environment to mint one ES256 JWT valid for 15 minutes. It keeps the token in memory, serves no private key, writes no token file, disables caching, rejects browser-origin/fetch-metadata requests and non-loopback Host headers, and refuses the token after expiry. Any process on this Mac can make the native loopback request while the helper runs; this is a local developer experiment, not a production credential service. Starting the helper again mints a new short-lived token. The helper was stopped after this experiment.

```sh
doppler run --project listen-cx --config dev_personal -- node spikes/apple-publisher/token-helper.mjs
node --test spikes/apple-publisher/token-helper.test.mjs spikes/apple-publisher/server.test.mjs
```

On the signed Mac app, selecting the override and then **Check MusicKit access** displayed: `MusicKit storefront us, subscription and 3 catalog entries verified; no provider write performed.` This verifies `canPlayCatalogContent` and native catalog lookup for revision 1's three songs. It does not verify a library mutation or user-library REST readback.

The coordinated experiment then clicked **Publish spike revision exactly once** for key `apple-spike-2026-09-10-a23981e6`, revision 1 `[A,B,C]`. Xcode paused the process on `SIGABRT` with this console message:

```text
Unable to find class MPModelLibraryPlaylistEditChangeRequest
```

The crashed stack included `getMPModelLibraryPlaylistEditChangeRequestClass` and `-[MusicKit_SoftLinking_MPModelLibraryPlaylistEditChangeRequest initWithPlaylistEntries:playlistName:playlistDescription:authorDisplayName:]`. The native adapter's `create(key:)` was the operation in progress: no destination ID existed, so the application's `replace(id:)` branch was not taken. The private class name includes “Edit,” but this was the initial `MusicLibrary.shared.createPlaylist` call. The environment was **macOS 26.5.2 (25F84), Xcode 26.2, iOS SDK 26.2**, executing as Designed for iPad.

The durable journal contains pending revision 1, the original key, and ordered IDs `[704790294,6782695839,617154366]`; it has no `playlistID` and no `applied` snapshot. Its actual container is `~/Library/Containers/FF9F3E3C-A66B-4B72-ADBB-97BD6073AA82/Data/Library/Application Support/apple-spike-destination.json`. iOS-on-Mac uses this UUID container, so looking only under `~/Library/Containers/listen-cx` incorrectly suggests no journal exists. The original journal and signing profile were preserved. Non-secret copies and stack evidence are in the ignored `.local/live-experiment/native-pending-after-crash.json` and `native-mac-runtime-evidence.json`.

A subsequent read-only Music app search scoped to **Your Library** returned **No results found** for the exact unique key. That is an observed absence in the local library view, not proof that no backend side effect occurred. Creation remains unverified and fenced by the pending-without-ID journal. No automatic create retry, journal reset, revision-2 attempt, public link, app-owned readback, or second-account propagation result followed. The same journal's next identical publish would reject with `unresolvedCreation` before calling the provider, as covered by the reconciliation tests.

Before the web-only decision, the proposed next capability test was the same signed iOS harness on a physical iPhone/iPad with the publisher subscription, first running read-only preflight. That proposal is now superseded and must not be resumed under this task. Preserve this Mac's ambiguous journal; inspect the uniquely named playlist before any separately coordinated disposable create, and do not assume a new installation can resume this pending destination. A successful physical-iOS create must return and persist an ID, verify `[A,B,C]`, then rebuild that same ID to `[C,A,D]`. Saved-subscriber propagation remains a later independent test.

The archived physical-device fallback was to try making an already paired, unlocked device available on the same network and selecting it in Xcode. If it was never paired, initial trust/pairing and Developer Mode setup may require a one-time cable connection; that is a future user action, not something performed during this investigation.

#### Useful evidence still available without iOS execution

A second subscriber can open the earlier Music-app-created public playlist in Apple Music on their own Mac, save it there without installing this spike, and later check the saved entry after an authorized publisher edit. Record the original URL and saved entry, track order before/after, refresh behavior, and elapsed time. This can establish saved-reference propagation independently of our app’s execution. No account switching on Omar’s Mac or additional playlist edit was attempted here. Removal/reorder testing remains open; the previously blocked Mac UI automation was not repeated.

### Files and experimental contract

All implementation is under `spikes/apple-publisher/`:

- `Core/Publisher.swift` and its co-located test: provider-neutral revision reconciliation, disk journal, ordered readback decoding.
- `Native/MusicKitProvider.swift`: authenticated catalog preflight, native create/rebuild, bounded complete REST readback.
- `Native/SpikeApp.swift`, `Native/Info.plist`, and `ApplePublisherSpike.xcodeproj`: developer console, JSON import/fetch, authorization, explicit publish action.
- `server.mjs`, `server.test.mjs`, and `Fixtures/desired.json`: minimal read-only backend handoff.
- `token-helper.mjs` and its co-located test: optional in-memory short-lived developer JWT service for the Mac experiment.

```json
{"playlistKey":"apple-publisher-spike-01","revision":1,"trackIDs":["A","B","C"]}
```

Replace placeholders with real Apple catalog song IDs available in the publisher's storefront. The opaque key is not a provider ID or permission. Revisions are positive safe integers; order and duplicate occurrences are significant. The spike bounds requests to 100 entries and a single destination per app container. It is not a public API or queue design. No website, account, membership, attribution, shared Worker, metadata client, or D1 files changed.

The app stores `playlistKey`, its created `playlistID`, the last readback-verified `applied` snapshot, and an optional `pending` snapshot in `Library/Application Support/apple-spike-destination.json` inside its sandbox. `applied.revision` is the destination's applied revision; a stored prior applied snapshot is historical evidence, not a claim that a failed newer attempt succeeded. Atomic writes precede mutations. Existing IDs cannot be supplied in desired JSON. Native consent, library lookup, the spike name prefix, and MusicKit's app-ownership enforcement remain necessary; a stored ID is not authorization.

Repeated identical revisions reread without writing. Stale revisions and a different payload at the same revision fail. A pending revision must resolve before a newer revision is accepted. Readback compares the entire ordered list, including duplicate occurrences, for up to four attempts separated by two seconds after successful reads that mismatch. Provider/network errors stop the attempt and preserve pending work; re-run the same revision after resolving the cause. If the new playlist is not yet visible to library lookup, that also requires retrying the same revision.

An interrupted edit can be read back on relaunch and, if still mismatched, rebuilt on the same destination. An ambiguous create with no durably recorded ID is deliberately fenced as `unresolvedCreation`: it never blindly creates a duplicate or adopts a similarly named playlist. A human must inspect the publisher library and app container before resetting a disposable experiment. There is no automatic adoption, rollback, deletion, or recovery of a lost app container. One app installation is the only writer; multi-device coordination and provider requests completing late after an interruption are not solved by this spike.

### Reproduce local checks

Run from the repository root:

```sh
swift test --package-path spikes/apple-publisher
node --test spikes/apple-publisher/server.test.mjs spikes/apple-publisher/token-helper.test.mjs
xcodebuild -project spikes/apple-publisher/ApplePublisherSpike.xcodeproj -scheme ApplePublisherSpike -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath spikes/apple-publisher/DerivedData CODE_SIGNING_ALLOWED=NO build
xcodebuild -project spikes/apple-publisher/ApplePublisherSpike.xcodeproj -scheme ApplePublisherSpike -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath spikes/apple-publisher/DerivedData CODE_SIGNING_ALLOWED=NO build
node spikes/apple-publisher/server.mjs spikes/apple-publisher/Fixtures/desired.json
```

The server listens on `127.0.0.1:8790`; `GET /desired` serves the current file. It never talks to Apple. The simulator can fetch `http://127.0.0.1:8790/desired`. Change the JSON to revision 2 with `[C,A,D]`, fetch again, and observe the new payload. Fetch does not authorize MusicKit or publish. Restore the placeholder fixture afterward. A real device needs the Mac's LAN address or JSON file import. To expose only the disposable fixture to your LAN, supply the Mac's LAN IP as the third server argument and use that address in the console; this server has no authentication and must not carry secrets or real private playlist data. HTTP is enabled only in this spike app's ATS configuration for this local handoff.

Test-first evidence: the initial 11-test core suite ran against a throwing stub and failed with 14 expectation/caught-error issues, then all 11 passed after implementation. Five adapter/persistence tests first failed compilation on the missing symbols, then the 16-test suite passed. A later encoded playlist-ID regression test failed on percent-encoded IDs, then passed after comparing decoded endpoint paths; the final suite has 17 tests. The HTTP test first failed because `server.mjs` did not exist, then passed against the actual loopback server. The token-helper tests first failed on a missing module, then passed for cryptographic signature/lifetime and real loopback origin/Host/method/expiry behavior; the combined Node suite has three passing tests. Native override and preflight code compiled in a signed Mac build, and the running preflight succeeded. These local contracts do not establish provider mutation behavior.

### Archived physical-device experiment procedure

1. Connect an iPhone/iPad with Developer Mode enabled, unlock it, and trust this Mac. Sign in to a publisher Apple Music subscription and enable Sync Library. The Mac needs an Apple Development signing identity and provisioning profile for a MusicKit-enabled explicit App ID. The checked-in signing settings remain unchanged; local Mac signing setup is documented above.
2. Open `spikes/apple-publisher/ApplePublisherSpike.xcodeproj` in Xcode. Select the publisher team under Signing & Capabilities and a unique registered bundle ID. Enable MusicKit under that App ID's App Services in the developer portal. Use the same team/bundle ID for subsequent revisions; do not recreate the app between revisions. Build and run on the connected device. The unsigned build above cannot be installed as a signed device app.
3. Choose four distinct playable catalog songs A, B, C, D in the publisher storefront. The two configured Doppler test songs were verified only in the US catalog and are insufficient for the four-song experiment. Put real IDs in a local desired JSON file. Use a clearly disposable opaque key, import it or fetch it, tap Authorize MusicKit and grant access, then tap Publish spike revision.
4. For revision 1 `[A,B,C]`, require the console to report publisher verification. Record the native playlist ID, name, ordered publisher readback, timestamp, and provider URL if any. Inspect Apple Music itself for the same three entries. If native creation/readback IDs disagree, or app ownership fails on later edit, stop and record the actual error; do not switch to REST creation as a substitute.
5. In Apple Music, open only the newly created `listen.cx Apple spike · <key>` playlist, use its supported Share Playlist action, and copy the public link. If sharing is unavailable, record subscription/profile/Sync Library state and the missing action. Do not conclude the shared-publisher design works until this succeeds.
6. Open that link on a second independent Apple Music subscriber account that has **never installed this harness**, and save the playlist in Apple Music. Do not copy its tracks into a new owned playlist or enable provider-native collaboration. Record the link, saved entry, track order, account/storefront labels (no credentials), and timestamp.
7. On the original publisher installation, submit revision 2 `[C,A,D]`. Require exact ordered readback and unchanged playlist ID. Open the original URL and the second account's previously saved entry; verify B was removed, D added, order changed, and identity remained stable. Observe at roughly 5s, 30s, 2min, and 10min. Record actual observed times and whether app reopening/refresh was necessary. Publisher success alone does not satisfy this step.
8. Repeat revision 2 unchanged; attempt stale revision 1 and conflicting revision 2 payloads; then use increasing revisions for duplicates `[C,C,A]`, empty `[]`, and an unavailable ID. Record provider acceptance and subscriber results. Mock preservation of duplicates/empty requests is not evidence that Apple preserves them.
9. Interrupt a pending edit, relaunch, and submit that identical pending revision before a newer one. Inspect readback and identity. An uncertain create may fence the experiment for manual inspection; never retry under a new key just to hide it. Preserve existing playlists and user data.
10. Repeat once with the publisher foregrounded, then background or lock it during a pending operation. Record lifecycle timestamps and when progress resumes. Fetching a new server revision while the app is suspended does not schedule any work in this harness. A scheduled/background publisher is a later operational decision, not a result of this experiment.

The Mac experiment established a stable public URL across one addition. Second-account saved-playlist propagation, removal/reorder, duplicate/empty provider semantics, background latency, and our native MusicKit mutation remain unverified. A second account can test the Mac-created shared playlist without an iPhone/iPad. Executing our publisher remains a separate gate requiring a signed, authorized destination. The no-cable iOS-on-Mac route launches and passes overridden-token preflight, but the first native creation crashes in an unavailable Apple framework class. No verified native destination exists to rebuild.

### Prepared local device session

A follow-up preparation verified four distinct US catalog songs with playback parameters (HTTP 200, 4/4), using the existing Doppler developer credentials. Real IDs, titles, and verification timestamp live only in the ignored `spikes/apple-publisher/.local/live-experiment/` directory. This is US catalog availability, not the connected publisher's storefront or native library proof. No key or token is stored in these fixtures.

- `catalog-verification.json`: A/B/C/D mapping, names, catalog IDs, storefront, and check timestamp.
- `revision-1.json`: `[A,B,C]` at revision 1.
- `revision-2.json`: `[C,A,D]` at revision 2, with the same disposable opaque key.
- `desired.json`: the current served revision, initially revision 1.

```sh
node spikes/apple-publisher/server.mjs spikes/apple-publisher/.local/live-experiment/desired.json
```

After revision 1 is verified on the real publisher and saved by the second account, advance the handoff file with:

```sh
cp spikes/apple-publisher/.local/live-experiment/revision-2.json spikes/apple-publisher/.local/live-experiment/desired.json
```

Copying the file changes the read-only handoff response; only an explicit native Publish action writes the provider playlist. Confirm the publisher storefront before using these prepared IDs. Keep the saved app container and signing identity intact across both revisions.

The target's effective settings are automatic signing, `Apple Development`, and bundle ID `cx.listen.ApplePublisherSpike`, with no configured `DEVELOPMENT_TEAM` or provisioning-profile selection. Later authenticated portal inspection confirmed that this default bundle ID is absent, while the existing explicit `listen-cx` App ID already has MusicKit enabled. Mac registration and the development profile are now complete. The signed Mac experiment uses `listen-cx` and team `ZW4CL8J474` through local overrides; the checked-in target settings remain unchanged.
