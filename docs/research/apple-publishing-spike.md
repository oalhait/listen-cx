# Apple shared publisher spike

September 9, 2026. Branch: `omar/apple-publishing-spike`. Experimental developer harness; no deployment. The spike has not executed MusicKit playlist writes. A separate Mac Music UI experiment created and added songs to one disposable playlist, as recorded below.

Mac Music testing proves playlist creation, public sharing, and an added song appearing at the same logged-out public URL. The native publisher also builds, passes its local reconciliation tests, and receives changed desired revisions in the iOS simulator. Whether our publisher-side companion can serve listeners who never install it remains **unproven**: our MusicKit execution, app ownership, and second-account saved-playlist propagation have not been demonstrated.

## Evidence and remaining gates

| Layer | Actual result |
| --- | --- |
| Mocked reconciliation | 17 Swift tests pass: identity, remove/reorder, repeat/stale/conflict handling, duplicates, empty requests, unavailable tracks, delayed ordered readback, interrupted create/edit, relaunch, persistence/corruption, concurrent-call rejection, readback identity and URL constraints |
| HTTP contract | Node test opens a real loopback socket; reads revision 1 and changed revision 2; verifies no-store, read-only routes, unavailable/invalid fixture handling |
| Native build | Xcode 26.2 / Swift 6.2.3: simulator arm64 + x86_64 build and unsigned arm64 iPhoneOS build succeeded |
| Native local handoff | iPhone 17 Pro simulator, iOS 26.2: app installed and launched; clicking Fetch displayed “Desired JSON fetched; no provider write performed.” Changing the fixture and fetching again displayed revision 2 and `[C,A,D]` |
| Authenticated catalog | Existing Doppler `listen-cx` / `dev_personal` Apple developer credentials signed a short-lived ES256 token. Read-only US catalog request returned HTTP 200 and both configured track IDs (2/2). No secret values in this document |
| Mac Music creation / sharing / addition | **Verified through Apple’s Mac UI and logged-out web**: one disposable playlist, same public URL before and after adding its fourth song |
| Mac Music removal / reordering | **Not verified**: removal attempts left rows unchanged; reorder automation failed twice with `noWindowsAvailable` |
| Spike MusicKit user-library readback / edit | **Not run**: no discoverable physical device; iOS-on-Mac attempt is blocked by a missing app provisioning profile |
| Spike app ownership / app-created sharing | **Not run**: the Mac playlist was created by Apple’s Music app, not our publisher |
| No-cable native route | Xcode exposes the existing iOS app as “Designed for iPad/iPhone” on this Mac; build reaches a missing iOS development provisioning-profile error. MusicKit runtime support on this route remains unverified |
| Second-account saved-playlist propagation | **Not run**: logged-out web visibility does not demonstrate a saved reference updating for a subscriber |
| Foreground/background timing | HTTP handoff observed in the foreground; no provider timing measured. No background scheduling implemented or tested |

`xcrun devicectl list devices` still returns “No devices found.” The initial signing check found zero valid identities; the later no-cable investigation found one valid Apple Development identity for Omar. That resolves the missing-certificate finding, but no compatible provisioning profile exists for the spike bundle ID. The Doppler Apple private key remains a separate developer-token credential, not iOS application signing or Music User Token authorization.

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

Native MusicKit can manage API tokens after the app's explicit bundle ID enables the [MusicKit App Service](https://developer.apple.com/documentation/musickit/using-automatic-token-generation-for-apple-music-api). The harness uses this mechanism and requests native user consent. It does not copy Doppler private keys into the app.

Readback uses MusicKit's authenticated `MusicDataRequest` against library playlist tracks. Catalog song resources use their catalog ID; library-song resources require `attributes.playParams.catalogId`, as shown in Apple's [library songs example](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-songs). Missing identity fails verification rather than guessing from titles, ISRCs, or library IDs. Every page must belong to the original playlist-tracks endpoint. This mapping and the relationship between native and REST playlist IDs still require real-account verification.

Apple describes sharing playlists and updates appearing for followers in its [iPhone sharing guide](https://support.apple.com/en-gb/guide/iphone/iphe5a418a82/ios). That supports the experiment; it does not establish that this app-created playlist can be shared or subscribed to successfully. The app only offers the provider-returned URL when present; it never fabricates a public URL or marks a playlist public. The manual Music app share step is part of acceptance.

[Background notification delivery is not guaranteed](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app). This console fetches/publishes only on button presses. It has no background modes, periodic job, push registration, or latency promise. Scene transitions print timestamps for a future device experiment; successful publisher readback reports elapsed time.

## No-cable native execution investigation

The existing app has a possible iOS-on-Mac destination, but there is **no demonstrated no-cable route to actual playlist rebuilding yet**. This investigation made no account changes, portal registrations, MusicKit permission grants, or library mutations.

| Route | Evidence | Current boundary |
| --- | --- | --- |
| Previously paired wireless iPhone/iPad | `devicectl` found no devices; `xctrace` listed only this Mac and simulators; Xcode listed no concrete physical iOS destination | No wireless device is currently discoverable. This does not prove that none was ever paired |
| iOS Simulator | The installed SDK compiles the required signatures, and the app’s HTTP handoff runs. Apple’s [MusicKit library sample](https://developer.apple.com/documentation/musickit/explore-more-content-with-musickit) explicitly does not work in Simulator; its [newer integration sample](https://developer.apple.com/documentation/musickit/integrating-musickit-into-your-app) carries the same restriction | No authenticated MusicKit library execution established. SDK compilation and simulated UI are not provider capability evidence |
| iOS app on Apple silicon Mac | `xcodebuild -showdestinations` exposes **My Mac**, arm64, variant **Designed for [iPad,iPhone]**, for this unchanged target | Signed build is blocked by the missing app provisioning profile; no launch or native authorization occurred |
| Native macOS / Mac Catalyst port | The installed SDK marks `MusicLibrary.createPlaylist` and playlist `edit` unavailable for those targets | Not a supported implementation of the required native edit API; no port added |

Apple documents [running an unmodified iOS app natively on Apple silicon](https://developer.apple.com/documentation/apple-silicon/running-your-ios-apps-in-macos). It is not Simulator and does not require recompiling the app as Mac Catalyst. Apple also warns that feature availability must be tested on the actual platform. The shared underlying framework infrastructure, or the presence of the iOS method at compile time, does not establish that playlist rebuilding works in this execution environment. We have not established either success or an API-specific runtime failure there.

### Exact build blocker

The installed Apple Development certificate belongs to team `ZW4CL8J474`. Local provisioning-profile inspection found no profile for `cx.listen.ApplePublisherSpike`; cached profiles belonged to unrelated apps and were expired. No private key material was exported.

The first build against the observed My Mac destination stopped because `DEVELOPMENT_TEAM` was unset. A second build supplied `DEVELOPMENT_TEAM=ZW4CL8J474` only on the command line, without changing project settings or allowing provisioning updates. Xcode then reported:

```text
No profiles for 'cx.listen.ApplePublisherSpike' were found:
Xcode couldn't find any iOS App Development provisioning profiles matching 'cx.listen.ApplePublisherSpike'.
```

Ignored local evidence is in `.local/designed-for-ipad-build.log`, `.local/designed-for-ipad-team-build.log`, and `.local/signing-metadata.json` under the spike directory. The logs retain the exact discovered destination used. This is a signing/setup failure before app launch, not a source compile failure or a MusicKit runtime result.

```sh
xcodebuild -project spikes/apple-publisher/ApplePublisherSpike.xcodeproj -scheme ApplePublisherSpike -showdestinations
xcodebuild -project spikes/apple-publisher/ApplePublisherSpike.xcodeproj -scheme ApplePublisherSpike -destination 'platform=macOS,name=My Mac' -derivedDataPath spikes/apple-publisher/.local/DesignedForIPad DEVELOPMENT_TEAM=ZW4CL8J474 build
```

### Authenticated portal findings

After Omar completed the developer portal sign-in, the account page confirmed team `ZW4CL8J474`. Read-only inspection established:

- The App IDs list does **not** contain `cx.listen.ApplePublisherSpike`.
- An existing explicit App ID **`listen-cx`** is registered. Its App Services tab has **MusicKit checked**; no checkbox or Save action was changed during inspection.
- Devices, with All Types selected, contains two older iPhones and **no registered Mac** matching this development destination. The annual device-list review banner is present and Add is inactive; the review has not been completed.
- Profiles, with All Types and All Platforms selected, contains only an **invalid App Store profile for an unrelated app**. There is no compatible existing development profile to download.
- Xcode’s existing-team **Download Manual Profiles** action downloaded only an old nonmatching profile; local reinspection still found no usable profile for either the spike bundle or `listen-cx`.

These are portal observations, not conclusions drawn only from missing local files. No App ID, device, profile, service permission, or account was created or modified. No reset/removal flow was entered.

The minimum no-cable setup is now concrete: reuse the existing MusicKit-enabled `listen-cx` bundle ID, retain all current devices through the annual list review, register this Mac for iOS-on-Mac development, then issue and install an iOS development profile covering that bundle, team, certificate, and Mac. The Mac’s provisioning UDID was verified against Xcode’s destination; Apple requires that identifier for [Apple silicon device registration](https://developer.apple.com/help/account/devices/register-a-single-device), rather than its hardware UUID. A local bundle override avoids creating a new App ID; keeping `cx.listen.ApplePublisherSpike` would additionally require registering and enabling that new identifier. Registration and profile creation have not been completed. The portal’s annual device-list review currently disables Add; the next setup action is to inspect that review and preserve every existing device before registering this Mac. No device removal or reset has been submitted.

Once the app can launch, test authorization and read-only subscription/catalog access first; playlist writes remain a separate authorized disposable experiment. Even that read-only success would not prove native create/edit support.

For a physical-device fallback, first try making an already paired, unlocked device available on the same network and selecting it in Xcode. If it was never paired, initial trust/pairing and Developer Mode setup may require a one-time cable connection; that is a future user action, not something performed during this investigation.

### Useful evidence still available without iOS execution

A second subscriber can open the existing Mac-created public playlist in Apple Music on their own Mac, save it there without installing this spike, and later check the saved entry after an authorized publisher edit. Record the original URL and saved entry, track order before/after, refresh behavior, and elapsed time. This can establish saved-reference propagation independently of our app’s execution. No account switching on Omar’s Mac or additional playlist edit was attempted here. Removal/reorder testing remains open; the previously blocked Mac UI automation was not repeated.

## Files and experimental contract

All implementation is under `spikes/apple-publisher/`:

- `Core/Publisher.swift` and its co-located test: provider-neutral revision reconciliation, disk journal, ordered readback decoding.
- `Native/MusicKitProvider.swift`: authenticated catalog preflight, native create/rebuild, bounded complete REST readback.
- `Native/SpikeApp.swift`, `Native/Info.plist`, and `ApplePublisherSpike.xcodeproj`: developer console, JSON import/fetch, authorization, explicit publish action.
- `server.mjs`, `server.test.mjs`, and `Fixtures/desired.json`: minimal read-only backend handoff.

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
node --test spikes/apple-publisher/server.test.mjs
xcodebuild -project spikes/apple-publisher/ApplePublisherSpike.xcodeproj -scheme ApplePublisherSpike -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath spikes/apple-publisher/DerivedData CODE_SIGNING_ALLOWED=NO build
xcodebuild -project spikes/apple-publisher/ApplePublisherSpike.xcodeproj -scheme ApplePublisherSpike -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath spikes/apple-publisher/DerivedData CODE_SIGNING_ALLOWED=NO build
node spikes/apple-publisher/server.mjs spikes/apple-publisher/Fixtures/desired.json
```

The server listens on `127.0.0.1:8790`; `GET /desired` serves the current file. It never talks to Apple. The simulator can fetch `http://127.0.0.1:8790/desired`. Change the JSON to revision 2 with `[C,A,D]`, fetch again, and observe the new payload. Fetch does not authorize MusicKit or publish. Restore the placeholder fixture afterward. A real device needs the Mac's LAN address or JSON file import. To expose only the disposable fixture to your LAN, supply the Mac's LAN IP as the third server argument and use that address in the console; this server has no authentication and must not carry secrets or real private playlist data. HTTP is enabled only in this spike app's ATS configuration for this local handoff.

Test-first evidence: the initial 11-test core suite ran against a throwing stub and failed with 14 expectation/caught-error issues, then all 11 passed after implementation. Five adapter/persistence tests first failed compilation on the missing symbols, then the 16-test suite passed. A later encoded playlist-ID regression test failed on percent-encoded IDs, then passed after comparing decoded endpoint paths; the final suite has 17 tests. The HTTP test first failed because `server.mjs` did not exist, then passed against the actual loopback server. These are local contract checks, not live provider behavior.

## Unlock the physical-device experiment

1. Connect an iPhone/iPad with Developer Mode enabled, unlock it, and trust this Mac. Sign in to a publisher Apple Music subscription and enable Sync Library. The Mac needs an Apple Development signing identity and provisioning profile for a MusicKit-enabled explicit App ID. No signing settings were changed here.
2. Open `spikes/apple-publisher/ApplePublisherSpike.xcodeproj` in Xcode. Select the publisher team under Signing & Capabilities and a unique registered bundle ID. Enable MusicKit under that App ID's App Services in the developer portal. Use the same team/bundle ID for subsequent revisions; do not recreate the app between revisions. Build and run on the connected device. The unsigned build above cannot be installed as a signed device app.
3. Choose four distinct playable catalog songs A, B, C, D in the publisher storefront. The two configured Doppler test songs were verified only in the US catalog and are insufficient for the four-song experiment. Put real IDs in a local desired JSON file. Use a clearly disposable opaque key, import it or fetch it, tap Authorize MusicKit and grant access, then tap Publish spike revision.
4. For revision 1 `[A,B,C]`, require the console to report publisher verification. Record the native playlist ID, name, ordered publisher readback, timestamp, and provider URL if any. Inspect Apple Music itself for the same three entries. If native creation/readback IDs disagree, or app ownership fails on later edit, stop and record the actual error; do not switch to REST creation as a substitute.
5. In Apple Music, open only the newly created `listen.cx Apple spike · <key>` playlist, use its supported Share Playlist action, and copy the public link. If sharing is unavailable, record subscription/profile/Sync Library state and the missing action. Do not conclude the shared-publisher design works until this succeeds.
6. Open that link on a second independent Apple Music subscriber account that has **never installed this harness**, and save the playlist in Apple Music. Do not copy its tracks into a new owned playlist or enable provider-native collaboration. Record the link, saved entry, track order, account/storefront labels (no credentials), and timestamp.
7. On the original publisher installation, submit revision 2 `[C,A,D]`. Require exact ordered readback and unchanged playlist ID. Open the original URL and the second account's previously saved entry; verify B was removed, D added, order changed, and identity remained stable. Observe at roughly 5s, 30s, 2min, and 10min. Record actual observed times and whether app reopening/refresh was necessary. Publisher success alone does not satisfy this step.
8. Repeat revision 2 unchanged; attempt stale revision 1 and conflicting revision 2 payloads; then use increasing revisions for duplicates `[C,C,A]`, empty `[]`, and an unavailable ID. Record provider acceptance and subscriber results. Mock preservation of duplicates/empty requests is not evidence that Apple preserves them.
9. Interrupt a pending edit, relaunch, and submit that identical pending revision before a newer one. Inspect readback and identity. An uncertain create may fence the experiment for manual inspection; never retry under a new key just to hide it. Preserve existing playlists and user data.
10. Repeat once with the publisher foregrounded, then background or lock it during a pending operation. Record lifecycle timestamps and when progress resumes. Fetching a new server revision while the app is suspended does not schedule any work in this harness. A scheduled/background publisher is a later operational decision, not a result of this experiment.

The Mac experiment established a stable public URL across one addition. Second-account saved-playlist propagation, removal/reorder, duplicate/empty provider semantics, background latency, and our native MusicKit mutation remain unverified. A second account can test the Mac-created shared playlist without an iPhone/iPad. Executing our publisher remains a separate gate requiring a signed, authorized destination. The no-cable iOS-on-Mac candidate above is currently blocked by provisioning and has not established MusicKit edit support.

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

The target's effective settings are automatic signing, `Apple Development`, and bundle ID `cx.listen.ApplePublisherSpike`, with no configured `DEVELOPMENT_TEAM` or provisioning-profile selection. Later authenticated portal inspection confirmed that this default bundle ID is absent, while the existing explicit `listen-cx` App ID already has MusicKit enabled. See the no-cable investigation above for the missing Mac registration and development profile. Target settings remain unchanged; coordinate bundle/team selection and provisioning before further signing work.
