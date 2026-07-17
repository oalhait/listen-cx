---
title: Private Pass the Aux Threads - Plan
type: feat
date: 2026-07-13
origin: docs/plans/2026-07-13-001-feat-pass-the-aux-roadmap-plan.md
topic: private-pass-the-aux-threads
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Private Pass the Aux Threads - Plan

## Goal Capsule

- **Objective:** Let friends create one unlisted cross-provider song list, add freely through a shared link, and keep every contribution useful individually or as part of a provider playlist snapshot.
- **Product authority:** No listen.cx account is required. Receiver-side provider choice remains the default for individual songs. Export authorization is isolated to the participant who requests it.
- **MVP boundary:** Chronological Threads, repeat contribution, creator remove/close controls, per-song handoff, and copy-anytime snapshots.
- **Open blockers:** Choose the initial song cap and lifetimes during planning; verify native handoff and both export adapters on staging before production exposure.

---

## Product Contract

### Summary

The first Pass the Aux feature is an unlisted chronological Thread. Link holders may add multiple songs, open any song through their preferred provider, and copy the current Thread into a native playlist without turning contribution into an authenticated collaboration product.

### Problem Frame

Song sharing already happens in group chats, but the resulting list is scattered and often tied to the sender's service. Provider-native collaborative playlists remove the scattering only when the whole group uses the same provider. The listen.cx opportunity is to preserve the low-friction link-sharing behavior while producing one portable list.

### Key Decisions

- **The shared link is the collaboration surface.** No participant directory, invitation acceptance, or contributor identity is needed for the first version.
- **Chronology is the only ordering rule.** (session-settled: user-directed — chosen over five fixed musical roles: the MVP should prove that people want to build and copy a Thread before testing editorial rituals.) Songs appear in accepted order.
- **Participants may contribute repeatedly.** (session-settled: user-directed — chosen over one song per browser or creator configuration: open contribution is easier to understand and browser identity is not person identity.) Bounds apply to the Thread and request rate, not a supposed person.
- **The creator receives a private management capability.** (session-settled: user-directed — chosen over removal-only or no creator controls: remove and close are the minimum controls for mistakes and abuse.) Losing it has no account-based recovery in the MVP.
- **Open and closed Threads are exportable.** (session-settled: user-directed — chosen over finish-before-export: copying the current state should not require a completion event.) Closing only stops new contributions.

### Actors

- A1. **Creator:** Creates and shares the Thread, keeps its management capability, and may also participate normally.
- A2. **Participant:** Holds the shared link and may view, add, listen, share, and export without a listen.cx account.

### Requirements

**Creation and access**

- R1. A1 can create an unlisted Thread with a title and receive a cryptographically unguessable public share capability plus a separate cryptographically unguessable private management capability.
- R2. Anyone holding the share capability can view the current chronological song list without authentication, while Thread pages remain non-indexable and absent from public discovery surfaces.
- R3. Unfurl previews reveal the Thread title and bounded public presentation data but never management capabilities or private instrumentation values.

**Contribution**

- R4. While contribution is open, A2 can add a valid Spotify or Apple Music track through one prominent Add a song action.
- R5. A2 may add multiple songs from the same browser, and each accepted contribution appears once in acceptance order with Open in my provider and Copy song link actions.
- R6. Each contribution resolves once into the existing immutable provider-neutral song representation before joining the Thread.
- R7. Contribution enforces a bounded Thread size, bounded inputs, request idempotency, and rate limits without requiring participant identity.
- R8. A failed or invalid submission remains visibly unaccepted, preserves the entered link, and offers retry; an idempotent duplicate request reports the existing accepted song instead of appending again.

**Listening and export**

- R9. Every accepted song remains independently openable through the existing receiver-side provider preference and choice escape hatch.
- R10. Any A2 can request an export of the Thread's current ordered state whether contribution is open or closed when at least one song is eligible for the destination.
- R11. Export authorization and failures remain isolated from creation, contribution, sharing, Thread viewing, and individual song handoff.

**Creator control**

- R12. A1 can remove any contribution through the private management capability.
- R13. A1 can irreversibly close contribution after confirming that Add a song will be disabled while the Thread, individual song actions, and snapshot export remain available.
- R14. Invite holders cannot remove songs, close contribution, or derive the management capability.
- R15. Reaching the Thread song cap disables Add a song until A1 removes a contribution and frees capacity; the MVP has no automatic contribution or view expiry.

**Accessibility**

- R16. Creation, contribution, management, listening, and export remain keyboard- and touch-operable at narrow mobile widths, with chronological position and open/closed state conveyed in text and screen-reader semantics.

### Key Flows

- F1. **Create and share**
  - **Trigger:** A1 wants friends to assemble a playlist across providers.
  - **Actors:** A1.
  - **Steps:** A1 names the Thread, creates it, saves the management capability, and shares the public link.
  - **Outcome:** The group receives one unlisted collaboration surface and the creator retains narrow moderation control.
  - **Covered by:** R1-R3, R14.
- F2. **Add songs**
  - **Trigger:** A2 opens an actively collecting Thread.
  - **Actors:** A2.
  - **Steps:** A2 selects Add a song, submits a supported track link, waits for resolution, sees the accepted song at the end of the list, and may add again or pass the link onward.
  - **Outcome:** The Thread grows without roles, participant accounts, or a one-song limit.
  - **Covered by:** R4-R8.
- F3. **Use the Thread**
  - **Trigger:** A2 wants one song or the whole sequence.
  - **Actors:** A2.
  - **Steps:** A2 either opens one contribution through the existing provider handoff or requests a provider playlist snapshot of the current order.
  - **Outcome:** Individual and sequence-level value coexist without making export mandatory.
  - **Covered by:** R9-R11.
- F4. **Moderate and close**
  - **Trigger:** A1 needs to remove a mistake, stop abuse, or end contribution.
  - **Actors:** A1.
  - **Steps:** A1 uses the private management capability to remove a song or close further additions.
  - **Outcome:** The remaining Thread stays shareable, playable, and exportable.
  - **Covered by:** R12-R15.

### Acceptance Examples

- AE1. **Repeat contribution is ordinary**
  - **Covers:** R4-R6.
  - **Given:** A2 has already added one song to an open Thread.
  - **When:** A2 adds another valid song from the same browser.
  - **Then:** The second song is accepted at the end of the list without identity checks or replacement of the first.
- AE2. **Concurrent additions preserve both songs**
  - **Covers:** R5, R8.
  - **Given:** Two participants view the same open Thread.
  - **When:** They submit different valid songs at nearly the same time.
  - **Then:** Both accepted contributions appear exactly once in a stable order and neither overwrites the other.
- AE3. **A failed contribution stays recoverable**
  - **Covers:** R8.
  - **Given:** A participant submits a link that fails validation or provider resolution.
  - **When:** The submission returns to the Thread.
  - **Then:** No song was appended, the entered link remains available, and the participant sees a retry path rather than an ambiguous success.
- AE4. **Closing changes only contribution**
  - **Covers:** R10, R13-R15.
  - **Given:** A1 closes a Thread containing several songs.
  - **When:** A2 opens the public link.
  - **Then:** A2 cannot add a song but can still open each contribution and export the current sequence.
- AE5. **Management remains private**
  - **Covers:** R3, R12, R14.
  - **Given:** A2 has only the public Thread link.
  - **When:** A2 loads, shares, or unfurls it.
  - **Then:** No remove or close authority, management capability, or recovery path is disclosed.

### Success Criteria

- Staging proves one Thread with contributions from at least two browsers, repeat contribution from one browser, and tracks originating from both providers.
- Among the first 10 seeded dogfood Threads, at least five receive a second-browser contribution without facilitator help, and at least 80% of observed participants complete create-to-share or open-to-add without instruction.
- Every accepted staging contribution opens in each receiver provider through an exact counterpart or the existing honest fallback.
- Concurrent and repeated contribution preserve stable chronological order without duplicate request effects.
- A creator can remove and close without exposing management authority to the public link.
- Account-free Thread actions add no provider authorization, provider SDK request, or provider identity persistence until export is chosen.

### Scope Boundaries

**In this MVP**

- One unlisted Thread type, chronological order, multiple contributions per browser, creator remove/close controls, individual handoff, and snapshot export.
- A total song cap, request validation, rate limits, non-indexable bearer access, and privacy-bounded staging instrumentation.

**Deferred for later**

- Contributor names, attribution, accounts, host recovery, invite rotation or revocation, reopening, deletion guarantees, notifications, and granular permissions.
- Public publishing, search, discovery, profiles, follows, comments, reactions, voting, and presence.
- Characterization, visual effects, prompts, embeddings, recommendations, and similarity.

**Outside this MVP**

- Fixed contribution roles, one-song-per-browser enforcement, points, leaderboards, or automatic completion.
- Continuous or in-app playback and continuous synchronization with provider playlists.

### Dependencies and Assumptions

- The current one-song resolver remains the source for accepted cross-provider song records.
- The public share link is a bearer capability, not a claim of confidentiality or participant identity.
- Planning will set the initial song cap and rate limits from staging cost and abuse constraints. Threads do not expire automatically in the MVP.
- The management capability has no identity-based recovery and must not enter unfurls, logs, analytics, referrers, or third-party dependencies.
- Snapshot export follows `docs/plans/2026-07-13-004-feat-provider-playlist-export-plan.md` and never changes the Thread contract.

### Sources and Research

- Origin roadmap: `docs/plans/2026-07-13-001-feat-pass-the-aux-roadmap-plan.md`.
- Existing route and resolver behavior: `src/app.ts`, `src/resolve.ts`, `src/db.ts`, and `test/app.test.ts`.
