---
title: Provider Playlist Export - Plan
type: feat
date: 2026-07-13
origin: docs/plans/2026-07-13-001-feat-pass-the-aux-roadmap-plan.md
topic: provider-playlist-export
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Provider Playlist Export - Plan

## Goal Capsule

- **Objective:** Let any Thread participant copy the current ordered songs into their own Spotify or Apple Music library without adding accounts or synchronization to listen.cx.
- **Product authority:** Export is an explicit snapshot action. Individual songs and the source Thread remain usable without export authorization.
- **Staging decision:** Prove both adapters. Spotify is limited to the five-person development allowlist; Apple Music still requires live credential and browser verification.
- **Public blockers:** Spotify quota and cross-service policy clearance; Apple Developer credentials and successful MusicKit web mutation proof.

---

## Product Contract

### Summary

Playlist export copies the current Thread into a new provider playlist. The participant chooses a destination, sees what can be copied, authorizes that provider, and receives a stable snapshot that never claims to follow later Thread changes.

### Problem Frame

Individual provider handoff makes every song accessible, but listening to a sequence one handoff at a time is cumbersome. Native playlists provide continuous provider-managed playback. That benefit should not introduce accounts or connected-provider state into the collaboration loop.

### Key Decisions

- **Every export is a snapshot.** (session-settled: user-directed — chosen over finish-before-export and continuous synchronization: participants should be able to copy an open Thread immediately without creating a long-lived provider relationship.) Later additions or removals affect only future exports.
- **Every participant may export.** Export is not a creator privilege and does not close or otherwise mutate the source Thread.
- **Authorization is per destination action.** listen.cx does not introduce a connected-account surface, background writes, or provider identity into ordinary Thread use.
- **Coverage is honest before authorization.** The participant sees how many current songs can be written exactly to the chosen provider and which songs will be omitted.
- **Both adapters ship to staging.** (session-settled: user-directed — chosen over Apple-first-only dogfood or blocking on public parity: staging should prove the intended cross-provider product while Spotify remains cohort-limited.) Production provider availability may differ until external gates clear.

### Actors

- A1. **Participant/exporter:** Holds a Thread link and wants its current sequence in their own provider library.

### Requirements

**Snapshot contract**

- R1. A1 can start an export from an open or closed Thread when at least one song is eligible, and the export captures the ordered songs present at that moment.
- R2. Later Thread additions, removals, or closure do not update, delete, or relabel an earlier provider playlist.
- R3. Repeating export creates another independent snapshot rather than finding or updating a prior export.
- R4. A song is a pre-authorization candidate only when listen.cx stores its source provider, destination catalog identifier, and exact-match provenance; heuristic URLs and search fallbacks are ineligible. Export preserves candidate order and intentional repeats when the provider permits them.

**Authorization and provider writes**

- R5. A1 chooses Apple Music or Spotify before any provider authorization or export SDK is requested.
- R6. A1 sees candidate included and omitted counts before authorization and must explicitly accept a partial export; zero candidates never request authorization or create a playlist. After authorization, destination availability is revalidated for A1's storefront or market, and any changed included set requires a fresh confirmation before writing.
- R7. A successful export creates a native playlist in A1's chosen provider and presents an honest success result.
- R8. Cancellation, denial, subscription limits, unavailable tracks, provider errors, and ambiguous writes produce distinct outcomes that do not mutate the Thread.
- R9. Export uses only the provider access needed for the requested playlist write and does not create a listen.cx account or persistent connected-provider identity. listen.cx never persists refresh tokens or provider access credentials and never places credentials in URLs, logs, or analytics; provider-managed browser authorization may remain under provider control.

**Availability**

- R10. Staging supports Apple Music export after MusicKit credential and browser proof.
- R11. Staging supports Spotify export for the development-mode allowlist after OAuth registration and policy review.
- R12. Production exposes a provider only after its credentials, operational behavior, quota, and policy requirements are satisfied.
- R13. Before an adapter passes staging, a fixed 50-track mixed-origin corpus must produce no incorrect included songs and at least 80% eligible destination coverage in each source-to-destination direction.

**Negative contract**

- R14. Viewing, contributing to, sharing, closing, and opening or copying individual songs from a Thread never require export authorization.
- R15. Loading a Thread performs no provider authorization, provider playlist write, or export-specific identity operation until A1 selects export.

### Key Flows

- F1. **Copy the current Thread**
  - **Trigger:** A1 wants provider-native sequence playback.
  - **Actors:** A1.
  - **Steps:** A1 selects export, chooses a provider, reviews exact coverage, accepts any omissions, authorizes the provider, and requests playlist creation from the captured order.
  - **Outcome:** A1 receives a native playlist snapshot and the source Thread remains unchanged.
  - **Covered by:** R1, R4-R9.
- F2. **Export again after the Thread changes**
  - **Trigger:** The source Thread changed after A1's earlier export.
  - **Actors:** A1.
  - **Steps:** A1 starts another export from the current Thread state and authorizes the destination action again if required.
  - **Outcome:** A1 receives a second independent snapshot; listen.cx never silently updates the earlier playlist.
  - **Covered by:** R2-R3.
- F3. **Keep using the Thread after failure**
  - **Trigger:** Authorization or playlist creation does not succeed.
  - **Actors:** A1.
  - **Steps:** A1 receives a classified failure and returns to the source Thread.
  - **Outcome:** All Thread contribution, management, sharing, and individual handoff behavior remains intact.
  - **Covered by:** R8, R13-R14.

### Acceptance Examples

- AE1. **An open Thread exports immediately**
  - **Covers:** R1-R3.
  - **Given:** An open Thread contains four songs.
  - **When:** A1 exports it and another participant later adds a fifth song.
  - **Then:** The source Thread shows five songs while the provider playlist remains the original four-song snapshot.
- AE2. **Partial coverage is explicit**
  - **Covers:** R4, R6-R8.
  - **Given:** Seven Thread songs have exact destination matches and one does not.
  - **When:** A1 chooses that provider.
  - **Then:** A1 sees “7 of 8 songs” and the omitted title before authorization. If storefront revalidation reduces that set, A1 sees and confirms the authoritative count before any playlist write.
- AE3. **Zero coverage never creates an empty playlist**
  - **Covers:** R1, R4, R6.
  - **Given:** A Thread has no verified writable catalog identifiers for the chosen provider.
  - **When:** A1 chooses that provider.
  - **Then:** The Thread explains that this snapshot cannot be copied, requests no authorization, and creates no playlist.
- AE4. **Authorization is not contagious**
  - **Covers:** R9, R14-R15.
  - **Given:** A1 cancels provider authorization.
  - **When:** A1 returns to the Thread.
  - **Then:** A1 may still add songs and open every contribution through the normal receiver-side handoff.
- AE5. **Public Spotify gating is honest**
  - **Covers:** R11-R13.
  - **Given:** Spotify export is implemented but public quota or policy clearance is missing.
  - **When:** A non-allowlisted production participant views export options.
  - **Then:** Spotify is not presented as an available export path.

### Success Criteria

- A real Apple Music subscriber creates a correctly ordered staging playlist from an open Thread.
- An allowlisted Spotify tester creates a correctly ordered staging playlist from the same Thread shape.
- Each adapter passes the 50-track mixed-origin corpus gate with zero incorrect included songs and at least 80% eligible coverage in both directions.
- A later Thread change leaves each earlier provider playlist unchanged and a later export captures the new state.
- Cancellation, known failure, and ambiguous write states never trigger an automatic second playlist creation.
- Thread loads and individual song handoffs or copy actions produce no provider authorization or export-side effects.

### Scope Boundaries

**In this MVP**

- Explicit provider choice, point-in-time capture, coverage preview, native playlist creation, classified results, and staging availability controls.

**Deferred for later**

- Updating an existing export, choosing a prior exported playlist, connected-provider settings, token refresh, export history, and background retries.
- Public Spotify rollout until quota and policy gates clear.

**Outside this product's identity**

- Continuous playlist synchronization, background provider writes, in-app playback, or making provider authorization a prerequisite for collaboration.

### Dependencies and Assumptions

- Thread storage supplies a stable ordered snapshot plus source-provider, destination catalog ID, and match provenance for each song. A heuristic cross-provider URL never counts as exact export eligibility.
- Apple Music playlist creation requires Music User Token authorization and live MusicKit web verification.
- Spotify playlist creation and addition require OAuth playlist-modification permission.
- Spotify development mode permits up to five allowlisted authenticated users and requires the app owner to have Premium.
- Public Spotify availability remains blocked until applicable quota and cross-service policy requirements are cleared.
- Provider write endpoints may leave an ambiguous result after network failure, so automatic creation retries are outside the contract.

### Sources and Research

- Thread contract: `docs/plans/2026-07-13-002-feat-private-pass-the-aux-threads-plan.md`.
- Spotify create and add endpoints: <https://developer.spotify.com/documentation/web-api/reference/create-playlist> and <https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist>.
- Spotify quota and policy: <https://developer.spotify.com/documentation/web-api/concepts/quota-modes> and <https://developer.spotify.com/policy>.
- Apple playlist creation and user authorization: <https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist> and <https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit>.
