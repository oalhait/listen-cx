# Automatic Apple Music ↔ Spotify matching

Research: September 12, 2026 (local date). Scope: technical viability, current API access, and a proposed matching contract. No application behavior or playlists were changed.

The documented APIs support automatic matching in both directions; only the Apple catalog/ISRC path has been verified live. Neither provider needs priority. The recommended path is authenticated catalog metadata, ISRC candidate lookup, and conservative recording/version checks. The proposed approach would reserve manual selection for conflicting or missing evidence. Coverage and precision have not yet been measured on a representative sample.

## Available interfaces

| Direction | Source metadata | Destination candidates |
| --- | --- | --- |
| Apple Music → Spotify | Apple catalog song: ISRC, title, artist, album, duration, content rating | Spotify `GET /v1/search?type=track&q=isrc:CODE`, followed by candidate validation |
| Spotify → Apple Music | Spotify `GET /v1/tracks/{id}`: `external_ids.isrc`, title, artists, album, duration, explicit flag | Apple `GET /v1/catalog/{storefront}/songs?filter[isrc]=CODE` |

These are documented provider APIs. Apple explicitly allows multiple results for one ISRC. Spotify's February announcement initially removed external IDs, but its March changelog reversed that removal; ISRC remains available. Sources: [Apple ISRC lookup](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc), [Apple song attributes](https://developer.apple.com/documentation/applemusicapi/songs/attributes-data.dictionary), [Spotify track](https://developer.spotify.com/documentation/web-api/reference/get-track), [Spotify search](https://developer.spotify.com/documentation/web-api/reference/search), [March correction](https://developer.spotify.com/documentation/web-api/references/changes/march-2026).

Catalog matching does not inherently require every contributor to connect both accounts. Apple catalog requests use our developer token. Spotify supports server-side client credentials for non-user endpoints; our checked Doppler `listen-cx/dev_personal` configuration has the client ID but no `SPOTIFY_CLIENT_SECRET`. Existing authorized-user tokens provide another catalog access path for a bounded pilot. Server-side client-credentials access still needs a live check with this app and does not remove Spotify quotas. [Spotify client credentials](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow).

Resolve availability for the destination listener. Apple's equivalent-song lookup maps Apple IDs between storefronts; it is not a Spotify-ID converter. Spotify's market and relinking behavior also matters. Development-mode responses no longer promise `available_markets` or `linked_from`, so do not depend on those fields. Preserve the requested and returned identities when available. [Apple equivalencies](https://developer.apple.com/documentation/applemusicapi/get-equivalent-ids-for-the-albums-3ce20), [Spotify relinking](https://developer.spotify.com/documentation/web-api/concepts/track-relinking), [development-mode changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026).

## Read-only runtime evidence

Using the existing MusicKit app credentials, the source lookup for Apple song `1440865792` returned HTTP 200:

- Chet Baker, “Time After Time,” *Chet Baker Sings*.
- ISRC `USBN28900129`; duration 165,580 ms.
- A subsequent US Apple ISRC lookup returned HTTP 200 and 16 catalog entries, including the original ID and compilation releases. Several returned entries were 166,255 ms and labeled “Time After Time (Vocal Version).”

This proves the configured Apple catalog/ISRC path works and demonstrates why “more than one result” should not automatically require a person. It does not prove every returned entry is the desired edition, or establish cross-platform accuracy. A second ID taken from Apple's documentation (`1613600188`) was absent from the successful batch response: successful HTTP status does not establish that every requested catalog item still exists.

No authenticated Spotify search was performed in this research. That remains the first runtime check for the next spike; documentation alone is not an end-to-end match proof.

## Proposed decision rules

1. Fetch source catalog metadata and retain its provider identity. Normalize ISRC syntax, Unicode, spacing, and punctuation. Keep meaningful version qualifiers such as live, remix, acoustic, instrumental, karaoke, edit, and remaster.
2. Search the destination by ISRC first. If the source lacks an ISRC or the destination ISRC lookup returns no candidates, use bounded artist/title searches to generate candidates. Candidate discovery is separate from accepting a match.
3. Compare ISRC, artist identity/credit, core title, duration, explicitness, version qualifiers, and destination playability. Treat contradictory live/remix/clean evidence as a rejection, not something outweighed by a high title score. Apple's missing content rating means unknown, not necessarily clean.
4. Group apparently equivalent catalog releases before deciding ambiguity. Same recording on an original album and a compilation need not prompt the user. Prefer the matching album/edition and a playable destination ID; persist that choice so subsequent syncs do not oscillate between releases.
5. After the benchmark validates the acceptance rule, automatically accept strong, consistent ISRC matches. For metadata-only matches, initially suggest the best candidates; enable automatic acceptance only after a reviewed benchmark establishes a suitable threshold and separation from the next candidate. Duration tolerance also needs calibration; small encoding differences are expected, but an arbitrary cutoff is not a measured guarantee.
6. Show a concise choice only for real ambiguity. Distinguish a missing destination recording from a temporary API failure, and retry the latter without demanding a link from the user.

An ISRC identifies a recording rather than a composition or album release. It is strong evidence, not a perfect universal primary key: IFPI permits many remasters to retain the original code. Never infer that equal codes prove identical mastering or that different codes prove different performances. [IFPI FAQ](https://isrc.ifpi.org/faqs).

Use deterministic comparisons for the first implementation. Spotify's policy prohibits ingesting its content into AI/ML models; an LLM should not be the matching engine. The policy also describes a user playlist-metadata transfer exception, which is relevant to this product but is not blanket approval for a general metadata redistribution service. [Spotify policy](https://developer.spotify.com/policy).

## Third-party route

Songlink/Odesli is not a dependable default dependency now. Its [official API notice](https://linktree.notion.site/API-d0ebe08a5e304a55928405eb682f6741) announced retirement of `v1-alpha.1` on July 31, 2026, stopped ordinary key issuance, and directs sustained use cases to an allowlisting request. Public landing pages are separate.

A live request to `api.song.link/v1-alpha.1/links` with a public Apple track URL returned **401 `PUBLIC_API_ACCESS_DEPRECATED`**. The notice describes 410 after sunset; the observed response differed but still rejected public access. A commercial/allowlisted adapter could be evaluated later, with independent destination checks. Do not substitute undocumented scraping of landing pages. MusicBrainz can supply supplementary recording/ISRC evidence, but its API does not establish complete current Apple/Spotify catalog availability. [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API).

## Fit with the current repository

`src/resolve.ts` currently types `isrc` as `null` and always returns `complete: false`. `src/spotify.ts` uses public embed metadata, and Apple intake uses iTunes lookup. `desiredState()` only accepts source identity or an explicitly confirmed counterpart. These are implementation choices, not a platform limitation requiring manual matching.

The following changes are proposed and have not been implemented. Add a provider-neutral matching service after source resolution. Store source and destination IDs, target market, evidence, matcher version, decision status, and verification time. Distinguish automatic evidence from human confirmation rather than fabricating `confirmed: true`. Preserve manual choices and legacy unresolved rows. Cache per recording/provider/market with bounded retries and negative-result expiry; do not search again for every subscriber or polling tick.

Recording identity and a market-specific playable catalog ID are separate concerns. The current single immutable counterpart is insufficient for durable per-market mappings and later corrections. Introduce those mappings without rewriting existing publication journals. A completed automatic match should advance the durable revision and wake affected subscriptions; playlist readback remains a separate final check. The publisher currently requires every song in the ordered list to have a destination identity, so a genuinely unresolved song can still pause that provider's copy.

Spotify development-mode access remains suitable for the current bounded pilot, not evidence of unrestricted launch access. It requires an eligible app owner and allowlisted users, and API quotas are shared across the developer's development apps. Cache and coalesce requests; handle quota exhaustion separately from a short rate-limit retry. [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [July quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates).

## Next decisive experiment

Build a read-only benchmark of 100 source-track cases with human-reviewed expected outcomes: 50 starting from each provider, with a verified counterpart or a verified no-available-match result. Include normal studio tracks, same-recording compilation releases, remasters, clean/explicit versions, live/acoustic/remix tracks, non-Latin credits, missing ISRCs, unavailable regions, and delisted IDs. Test at least two destination markets.

Measure exact-recording precision, automatic acceptance coverage, manual-review rate, unavailable rate, request count, and cold/warm latency separately by direction. Count equivalent album releases separately from wrong recordings. Review all accepted matches and all ambiguous cases. The acceptance rule should be calibrated from this evidence; there is no defensible accuracy percentage yet. Then implement automatic acceptance for the supported evidence class, keeping explicit exception states and existing provider readback.
