# Apple shared publisher spike

September 9, 2026. Branch: `omar/apple-publishing-spike`. Experimental developer harness; no deployment. The spike attempted one native playlist creation on iOS-on-Mac and crashed inside Apple’s framework; no successful native creation or readback was established. A separate Mac Music UI experiment created and added songs to one disposable playlist, as recorded below.

Mac Music testing proves playlist creation, public sharing, and an added song appearing at the same logged-out public URL. The native publisher also builds, passes its local reconciliation tests, and receives changed desired revisions in the iOS simulator. Whether our publisher-side companion can serve listeners who never install it remains **unproven**: native creation fails on the tested Mac route, while physical-iOS app ownership and second-account saved-playlist propagation have not been demonstrated.

## Evidence and remaining gates

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

## Mac Music UI experiment

This completed behavior test used Apple Music on the Mac and required no iPhone/iPad. It did not execute the spike’s native MusicKit adapter or create a playlist owned by our app.

The disposable playlist is **listen.cx Mac publishing test 2026-09-09**, with this [public Apple Music URL](https://music.apple.com/us/playlist/listen-cx-mac-publishing-test-2026-09-09/pl.u-oZylKN9IRE7MA62). Its initial ordered rows were:

1. Raid (feat. MED) — Madvillain
2. Lonesome Town — Ricky Nelson
3. Zombies — Childish Gambino

The sharing URL opened while logged out. After adding **Sleepwalk (Remastered 2010) — Santo & Johnny** through Mac Music, refreshing that same URL showed all four rows in the order above, with Sleepwalk fourth. This verifies public sharing and addition propagation for this playlist without changing its public URL. No propagation latency was measured.

Explicit **Remove from Playlist** attempts did not change the visible rows, so removal was not established. BackSpace produced a broader Cloud Music Library deletion warning; that operation was **cancelled**. Drag/reorder attempts were blocked twice by the UI automation server’s `noWindowsAvailable` error despite readable screenshots and accessibility state. That is an automation limitation, not evidence that Apple Music cannot reorder playlists.

The observed final playlist therefore contains the four songs above. There was no successful removal/reorder result, second-account save, follower propagation observation, our-app ownership proof, or native MusicKit publisher execution. A logged-out visitor seeing updated public rows is a narrower result than a subscriber’s previously saved playlist updating. The Mac result also does not prove that our native app can edit this Apple Music-created playlist.

## Current Apple constraints

Apple documents native playlist rebuilding through [`MusicLibrary.edit(..., items:)`](https://developer.apple.com/documentation/musickit/musiclibrary/edit(_:name:description:authordisplayname:items:)) and restricts edits to playlists the app created. The installed iPhoneOS 26.2 SDK explicitly marks the creation and edit methods unavailable on macOS and Mac Catalyst. The spike targets iOS APIs and has no macOS or Mac Catalyst port. Running that iOS binary through “Designed for iPad/iPhone” is a separate candidate, investigated below.

Native MusicKit can manage API tokens after the app's explicit bundle ID enables the [MusicKit App Service](https://developer.apple.com/documentation/musickit/using-automatic-token-generation-for-apple-music-api). The harness defaults to this mechanism and requests native user consent. An explicit local developer-token override is available for the observed automatic-token failure; it does not copy Doppler private keys into the app.

Readback uses MusicKit's authenticated `MusicDataRequest` against library playlist tracks. Catalog song resources use their catalog ID; library-song resources require `attributes.playParams.catalogId`, as shown in Apple's [library songs example](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-songs). Missing identity fails verification rather than guessing from titles, ISRCs, or library IDs. Every page must belong to the original playlist-tracks endpoint. This mapping and the relationship between native and REST playlist IDs still require real-account verification.

Apple describes sharing playlists and updates appearing for followers in its [iPhone sharing guide](https://support.apple.com/en-gb/guide/iphone/iphe5a418a82/ios). That supports the experiment; it does not establish that this app-created playlist can be shared or subscribed to successfully. The app only offers the provider-returned URL when present; it never fabricates a public URL or marks a playlist public. The manual Music app share step is part of acceptance.

[Background notification delivery is not guaranteed](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app). This console fetches/publishes only on button presses. It has no background modes, periodic job, push registration, or latency promise. Scene transitions print timestamps for a future device experiment; successful publisher readback reports elapsed time.

## No-cable native execution investigation

The existing iOS app now builds, installs, and launches on this Mac without a cable. MusicKit authorization and read-only preflight succeed with an explicit developer-token override, but the first native playlist creation aborts in an unavailable Apple framework class. Setup created a development provisioning profile after Omar registered this Mac; no library mutations occurred during setup.

| Route | Evidence | Current boundary |
| --- | --- | --- |
| Previously paired wireless iPhone/iPad | `devicectl` found no devices; `xctrace` listed only this Mac and simulators; Xcode listed no concrete physical iOS destination | No wireless device is currently discoverable. This does not prove that none was ever paired |
| iOS Simulator | The installed SDK compiles the required signatures, and the app’s HTTP handoff runs. Apple’s [MusicKit library sample](https://developer.apple.com/documentation/musickit/explore-more-content-with-musickit) explicitly does not work in Simulator; its [newer integration sample](https://developer.apple.com/documentation/musickit/integrating-musickit-into-your-app) carries the same restriction | No authenticated MusicKit library execution established. SDK compilation and simulated UI are not provider capability evidence |
| iOS app on Apple silicon Mac | `xcodebuild -showdestinations` exposes **My Mac**, arm64, variant **Designed for [iPad,iPhone]**, for this unchanged target | Signed launch and overridden-token preflight verified; native creation aborts because `MPModelLibraryPlaylistEditChangeRequest` is absent |
| Native macOS / Mac Catalyst port | The installed SDK marks `MusicLibrary.createPlaylist` and playlist `edit` unavailable for those targets | Not a supported implementation of the required native edit API; no port added |

Apple documents [running an unmodified iOS app natively on Apple silicon](https://developer.apple.com/documentation/apple-silicon/running-your-ios-apps-in-macos). It is not Simulator and does not require recompiling the app as Mac Catalyst. Apple also warns that feature availability must be tested on the actual platform. The shared underlying framework infrastructure, or the presence of the iOS method at compile time, does not establish that playlist rebuilding works in this execution environment. The first native creation attempt now establishes an API-specific runtime failure on the tested macOS 26.5.2 / iOS SDK 26.2 combination; it does not prove that every OS release behaves the same way.

### Signing and installation completed

The valid Apple Development certificate belongs to team `ZW4CL8J474`. The initial profile failures were resolved by reusing the existing explicit `listen-cx` App ID rather than creating `cx.listen.ApplePublisherSpike`. Omar completed the annual device review and registered this Mac. The agent then created **listen-cx Apple Publisher Mac Development**, using the existing development certificate and only this Mac as the provisioned device, downloaded it, and installed it in Xcode's user provisioning-profile directory. No device was removed or reset by the agent.

The profile's application identifier is `ZW4CL8J474.listen-cx`, `get-task-allow` is true, and the profile expires September 10, 2027. Its device identifier matches Xcode's Mac provisioning UDID, which differs from the hardware UUID. Apple documents the required identifier in its [Apple silicon device registration guide](https://developer.apple.com/help/account/devices/register-a-single-device).

This signed command succeeded without modifying the repository's project settings:

```sh
xcodebuild -project spikes/apple-publisher/ApplePublisherSpike.xcodeproj -scheme ApplePublisherSpike -destination 'platform=macOS,name=My Mac' -derivedDataPath spikes/apple-publisher/.local/DesignedForIPad DEVELOPMENT_TEAM=ZW4CL8J474 PRODUCT_BUNDLE_IDENTIFIER=listen-cx CODE_SIGN_STYLE=Manual PROVISIONING_PROFILE_SPECIFIER='listen-cx Apple Publisher Mac Development' build
```

Direct LaunchServices opening of the raw `Debug-iphoneos` app failed with `-10661` (no compatible executable). Xcode's **My Mac (Designed for iPad)** Run action successfully installed the iOS wrapper and launched the app. For this GUI run, an ignored `.local/MacRun/` project references the same source files with local signing overrides; the checked-in project remains unchanged. Before launch, no matching installed app or existing `listen-cx` container was found. The running app fetched the real revision-1 fixture and displayed MusicKit authorization `.authorized`. No authorization prompt was captured or clicked by the agent.

### Automatic MusicKit token failure

The new **Check MusicKit access** action runs read-only storefront, subscription, and catalog preflight without calling the publisher or writing a journal. At `2026-09-10T05:11:25Z`, `MusicDataRequest.currentCountryCode` failed with `.developerTokenRequestFailed`. Process logs showed `ICError -8200`, token-service HTTP 404, and payload `Client not found`, status `40402`, identifying `listen-cx` as the unrecognized client. No native catalog request or subscription check succeeded in this attempt; authorization alone does not prove either.

Authenticated read-only portal reinspection confirmed the explicit App ID `listen-cx`, team `ZW4CL8J474`, and **MusicKit checked** in App Services. The built app's `CFBundleIdentifier` also equals `listen-cx`. No service was toggled, App ID recreated, or credential reset. Apple's [automatic-token setup guide](https://developer.apple.com/documentation/musickit/using-automatic-token-generation-for-apple-music-api) requires that matching registration. An [Apple engineer's explanation of this exact error](https://developer.apple.com/forums/thread/705056) recommends checking the bundle-ID match. Those checks pass here, so the remaining failure is unresolved; it does not establish an iOS-on-Mac create/edit limitation.

### Supported token override and first native creation

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

The minimum next capability test is the same signed iOS harness on a physical iPhone/iPad with the publisher subscription, first running read-only preflight. Preserve this Mac's ambiguous journal; inspect the uniquely named playlist before any separately coordinated disposable create, and do not assume a new installation can resume this pending destination. A successful physical-iOS create must return and persist an ID, verify `[A,B,C]`, then rebuild that same ID to `[C,A,D]`. Saved-subscriber propagation remains a later independent test.

For a physical-device fallback, first try making an already paired, unlocked device available on the same network and selecting it in Xcode. If it was never paired, initial trust/pairing and Developer Mode setup may require a one-time cable connection; that is a future user action, not something performed during this investigation.

### Useful evidence still available without iOS execution

A second subscriber can open the earlier Music-app-created public playlist in Apple Music on their own Mac, save it there without installing this spike, and later check the saved entry after an authorized publisher edit. Record the original URL and saved entry, track order before/after, refresh behavior, and elapsed time. This can establish saved-reference propagation independently of our app’s execution. No account switching on Omar’s Mac or additional playlist edit was attempted here. Removal/reorder testing remains open; the previously blocked Mac UI automation was not repeated.

## Files and experimental contract

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

## Reproduce local checks

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

## Unlock the physical-device experiment

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

## Prepared local device session

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
