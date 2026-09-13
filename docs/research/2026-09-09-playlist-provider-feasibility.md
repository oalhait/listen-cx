# Collaborative playlist provider feasibility

Research date: September 9, 2026. Documentation analysis, not authenticated runtime proof.

Native MusicKit documents the track-editing operation needed for mirroring; reliable automatic sync still needs device testing. Apple's documented REST API does not expose the same editing operation. Spotify's development allowlist constrains personal OAuth integrations; it does not describe a limit on listeners saving a public playlist inside Spotify. These distinctions create workable paths, with different ownership and execution requirements.

The requested product remains a website-owned collaborative playlist with live provider mirrors. The alternatives below are proposals, not accepted changes to that requirement.

## Apple API coverage

The audit fetched the Apple Music API root, its top-level topic pages, and their endpoint references: 179 pages including the root, with 138 endpoint documentation entries (119 distinct HTTP method/path combinations; some entries differ by query parameters). The [endpoint inventory](apple-music-endpoint-inventory.md) records those entries. This is a survey of the published API surface, not a claim to have tested every endpoint or inspected every nested schema. MusicKit for Swift, MusicKit JS v3, Apple sharing documentation, and background-execution documentation were examined separately.

| Surface | Capabilities | Consequence for this product |
| --- | --- | --- |
| Catalog: songs, albums, artists, music videos | Resource lookup, relationships, views, batch queries; song lookup by ISRC and album lookup by UPC | Track intake and catalog identity |
| Search | Catalog/library search, search hints and suggestions | Find candidates; search results alone do not verify a recording |
| Storefronts and equivalencies | User storefront, supported languages, equivalent catalog recordings in another storefront | Resolve for the listener's region |
| Library | Read library songs, albums, artists, videos and playlists; add catalog resources | Inspect destination state and add content |
| Playlists | Read catalog/library playlists and tracks; create library playlists; append tracks | Initial export and additions through REST |
| Playlist folders | Read folders and relationships; create folders | Organization, not track reconciliation |
| Ratings and favorites | Read/write/delete ratings; add favorites | Deleting a playlist rating does not delete the playlist or its tracks |
| Discovery | Genres, charts, activities, curators, record labels and stations | Optional discovery; no additional playlist write path |
| Personalization | Recommendations, recent history, heavy rotation and Replay summaries | Optional personalized experiences; no additional playlist write path |
| Transport/authentication | Developer tokens, Music User Tokens, pagination, status codes and rate limits | Authorization and reliable reconciliation prerequisites |

Source: [Apple Music API index](https://developer.apple.com/documentation/applemusicapi) and the linked endpoint inventory.

### The exact playlist-write distinction

The REST mutation inventory contains playlist creation, playlist-folder creation, appending tracks, library additions, favorites, and ratings. All nine documented DELETE entries in the surveyed surface delete ratings. None deletes a playlist or removes its entries.

The relevant playlist operations are:

- `POST /v1/me/library/playlists`: create, optionally supplying initial tracks.
- `POST /v1/me/library/playlists/{id}/tracks`: append tracks to the end.
- `POST /v1/me/library`: add catalog resources to the library; this does not replace a playlist's track list.

Apple warns that library changes may take time to become visible. Library additions can return 202 and silently ignore IDs that cannot be added. Our sync state therefore needs readback rather than treating an accepted request as a completed mirror. Sources: [creation](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist), [append](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist), [library additions](https://developer.apple.com/documentation/applemusicapi/add-a-resource-to-a-library).

MusicKit JS v3 provides `api.music(...)`, a passthrough to Apple Music API that attaches authentication and resolves storefronts. Its ability to pass fetch options is not evidence of an undocumented REST editing endpoint. Playback-queue editing is also separate from editing a saved library playlist. [MusicKit JS API reference](https://js-cdn.music.apple.com/musickit/v3/docs/index.html?path=/story/reference-javascript-api--page).

Native MusicKit exposes `MusicLibrary.shared.edit(_:name:description:authorDisplayName:items:)`, which rebuilds the entries of a playlist our app created. We can supply the desired ordered tracks to express additions, removals and reordering. This is a documented capability; duplicates, empty lists, large lists, propagation and recovery still need device tests. Apple explicitly rejects edits to playlists created by another app. Create the mirror through our native app initially; do not assume a playlist created using web credentials will have the required native ownership. The method is documented from iOS/iPadOS 16, with other Apple-platform availability; do not assume a macOS or Linux server implementation. [Native playlist editing](https://developer.apple.com/documentation/musickit/musiclibrary/edit(_:name:description:authordisplayname:items:)).

### Paths we can build

| Approach | What it delivers | What remains |
| --- | --- | --- |
| Personal mirror with an iOS companion | Native app creates and reconciles each user's playlist; website remains authoritative | Installation and authorization per listener; foreground catch-up and opportunistic background sync |
| One shared Apple playlist per website playlist | A publisher-side native app updates its own playlist; listeners save a shared reference in Apple Music rather than independently owned copies | Prove app-created playlist sharing, stable links, follower propagation and operational execution |
| REST-only export/appending | Website creates a copy and appends new songs | Does not fulfill removals/reordering; not a full mirror |
| New playlist for each revision | Each new export can contain the desired tracks | Old copies remain and subscribers do not automatically move to the new playlist; not a transparent mirror |

Apple documents that edits to shared music appear on followers' devices. This makes the shared-publisher design a supported-behavior hypothesis worth testing, not proof that app-created playlists can be automatically published end to end. A one-time sharing step in Apple's UI may be necessary. [Apple playlist sharing](https://support.apple.com/en-gb/guide/iphone/iphe5a418a82/ios).

A companion app can fetch the latest website revision and reconcile when it runs. Background notifications cannot provide a guaranteed latency: Apple says their delivery is not guaranteed. A publisher device that must remain running also becomes an operational dependency. [Background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).

Catalog requests need an Apple developer token; personal library operations also need user authorization. Apple's WWDC guidance describes Music User Tokens as app/device-specific and subject to revocation or expiry. Do not assume one captured token is a permanent, portable server credential. Keep native mirror writes on the authorized device; validate any proposed server-side personalized flow separately. [Token generation](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens), [user authentication](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit), [Apple's authentication explanation](https://developer.apple.com/videos/play/wwdc2022/10148/).

For matching, use Apple ISRC lookup when source recording identifiers are available, followed by version/explicitness checks and storefront resolution. ISRC lookup is a candidate-generation tool, not a guarantee of identical editions. Apple's equivalency API maps Apple catalog content between storefronts; it does not accept Spotify IDs. Existing public metadata primitives do not supply verified cross-provider identity. [ISRC lookup](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc), [equivalencies](https://developer.apple.com/documentation/applemusicapi/managing-content-ratings-alternate-versions-and-equivalencies).

The [September 12 automatic-matching follow-up](2026-09-12-cross-platform-auto-linking.md) examines both directions, records a live Apple ISRC lookup, and proposes automatic acceptance based on recording evidence. It also checks current Spotify identifier availability and Odesli's public API retirement.

## Spotify: what the limit actually blocks

New development apps allow five authenticated Spotify users, require Premium for the app owner, and require users to be allowlisted. Non-allowlisted users may complete login but their API requests receive 403. This is account authorization enforcement, separate from request-rate throttling. Lower sync frequency, PKCE, a native app or moving requests to a backend does not remove it. Existing apps may retain already-added users above five; the actual app's status has not been inspected. [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).

Spotify documents creating playlists with `POST /me/playlists` and replacing/reordering tracks with `PUT /playlists/{id}/items`. Thus the personal-mirror operation exists; broad authorization is the constraint. [Create playlist](https://developer.spotify.com/documentation/web-api/reference/create-playlist), [update playlist](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items).

### Practical routes

1. **Shared publisher playlist.** Authorize one publisher account and sync a public playlist owned by it. Website collaborators use our own account/invite system. Listeners open the Spotify link and save it in Spotify, without authorizing our OAuth app. This avoids requiring an OAuth slot per listener; normal API quotas still apply to publisher writes. It creates a saved reference to the live playlist, not a listener-owned copy. This is an architectural inference from the allowlist rule and Spotify's native save behavior, not a blanket production approval. [Saving playlists](https://support.spotify.com/us/article/save-recover-playlists/).
2. **Personal mirrors for a bounded pilot.** Works within the app's actual allowlist, followed by a real-account mutation test. Useful if independent ownership is essential.
3. **Extended quota access.** The published application criteria include an organization, a launched service and at least 250,000 monthly active users. Approval is not automatic. This is a difficult route for a new small product, not a paid upgrade we can simply enable. [Eligibility](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
4. **An approved integration partner.** Potential commercial route, but no partner was vetted here. Its approved use case must cover the integration; borrowing an approved client ID is not equivalent. Spotify limits extra quota to the reviewed use case. [Developer terms](https://developer.spotify.com/terms).

Bring-your-own developer credentials could support independent personal/self-hosted installations, but impose Premium/developer setup on each owner and are not a verified mass-market authorization route. Splitting our hosted app across client IDs or replaying private web-client credentials is not a supported solution established by this research.

## Smallest decisive runtime experiment

No provider accounts, credentials or remote playlists were changed during this research.

1. Create an app-owned Apple playlist through native MusicKit containing `[A, B, C]`; rebuild it as `[C, A, D]`; confirm the same playlist ID now has the correct order and removal in Apple Music.
2. Repeat an identical revision, then test duplicates, an empty list, unavailable regional tracks, interruption and relaunch. Verify readback after propagation delay.
3. Share that Apple playlist, save it from a second account, and repeat the edit. Measure whether the shared URL and subscriber library entry remain stable.
4. Using an allowlisted Spotify publisher account, create and update a public playlist. Save it in Spotify using a listener account outside the app allowlist and verify that edits appear without authorizing our app.

The first experiment proves personal Apple reconciliation. The second-account experiments decide whether shared provider subscriptions can deliver the desired listening experience with substantially less listener setup. Neither alternative has been accepted as the product contract yet.
