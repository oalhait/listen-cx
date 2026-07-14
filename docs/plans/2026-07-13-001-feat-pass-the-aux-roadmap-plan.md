---
title: Pass the Aux Roadmap - Plan
type: feat
date: 2026-07-13
topic: pass-the-aux-roadmap
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Pass the Aux Roadmap - Plan

## Goal Capsule

- **Objective:** Evolve listen.cx from a one-song sharing utility into a lightweight way for friends to build and hear a shared sequence across music providers.
- **Product authority:** The receiver-side, no-account, cross-provider playback thesis remains authoritative. Native playlist export and public social features must not complicate contributing to or opening a thread.
- **Open blockers:** Identify the initial social moment that makes someone start a thread. Verify native Apple Music and Spotify handoff on iOS and macOS before treating a thread as ready to listen.

---

## Product Contract

### Summary

Introduce Pass the Aux as a finite, unlisted music thread. A host passes an invite along; each participant adds a provider-agnostic song to a purposeful position in a shared sequence. Character, export, public discovery, and music intelligence arrive only after the core contribution loop proves useful.

### Problem Frame

People already build shared playlists through group-chat links, screenshots, and fragmented provider-specific collections. The work is social but the result is not portable: a contributor's preferred service can become a constraint for everyone else. A generic collaborative playlist would reproduce the usual link dump without giving the group a reason to finish something together.

### Key Decisions

- **Finite threads before ongoing rooms.** A short, completable sequence gives every contribution an editorial purpose and avoids the moderation and identity burden of an endless shared collection.
- **Contribution is the game.** Thread slots or prompts should create a musical handoff; abstract points, leaderboards, and voting do not improve the shared listening result.
- **Character begins with declared signals.** Prompt, role, sequence, artwork palette, and optional participant mood cues may shape the visual treatment before any automated music interpretation is trusted.
- **Export is opt-in and post-completion.** Saving a completed thread as a native playlist requires provider authorization and is not part of the low-touch contribution or playback path.
- **Public identity comes later.** Threads stay unlisted by default. Publishing, joinability, and permissioning require durable ownership and moderation decisions that the no-account MVP should not pretend to solve.

### Actors

- A1. **Host:** Starts a thread and passes its invitation to a small group.
- A2. **Contributor:** Adds one song from Spotify or Apple Music to a meaningful open position.
- A3. **Listener:** Opens a completed thread and listens to any song in their preferred provider.
- A4. **Future publisher:** Chooses whether a thread becomes visible beyond its original invitees.

### Requirements

**Phase 1 — private Pass the Aux threads**

- R1. A1 can create an unlisted, finite music thread with a title and optional prompt.
- R2. A thread presents a small set of purposeful song positions that form an ordered listening sequence.
- R3. A2 can open an invitation and contribute a Spotify or Apple Music track without creating an account.
- R4. Each accepted contribution resolves once into the existing cross-provider track representation and remains individually playable through A3's provider preference.
- R5. A1 receives a private management capability to close the thread or remove an unsuitable contribution without turning the public invite into an editor.
- R6. A completed thread becomes read-only and shareable as a finished mix.

**Phase 2 — thread character**

- R7. A thread has a visual identity derived from the group’s declared prompt, roles, sequencing, artwork, and optional mood signals.
- R8. The identity makes the sequence easier to understand and more desirable to share; it is not a cosmetic score or a claim of objective musical analysis.

**Phase 3 — provider export**

- R9. A listener may explicitly authorize a supported provider to save a completed thread as a native playlist.
- R10. Export is optional, happens after the core thread is complete, and does not alter the account-free invitation or listener redirect flows.

**Phase 4 and later — public threads and music intelligence**

- R11. Public publishing, joinability, and permissioning remain opt-in capabilities built on a durable ownership and moderation model.
- R12. Any embedding-based characterization uses a reliable, provider-independent music signal, is described as an interpretive reading, and earns its place by matching human judgments better than the declared-signal baseline.

### Key Flows

- F1. **Pass a thread along**
  - **Trigger:** A1 has an occasion, prompt, or group that deserves a shared sequence.
  - **Steps:** A1 starts a thread, shares its invite, and A2 fills an open musical position with a provider link.
  - **Outcome:** The group creates an ordered, cross-provider mix rather than an unstructured link dump.
  - **Covered by:** R1-R6.
- F2. **Listen across providers**
  - **Trigger:** A3 opens a completed thread.
  - **Steps:** A3 selects a song and listen.cx hands off to their preferred provider.
  - **Outcome:** The social object remains useful regardless of who uses Spotify or Apple Music.
  - **Covered by:** R4, R6.
- F3. **Export a completed mix**
  - **Trigger:** A3 wants the finished sequence in their own provider library.
  - **Steps:** A3 explicitly connects a supported provider and requests export.
  - **Outcome:** A3 gets a native playlist without imposing authentication on the group’s core loop.
  - **Covered by:** R9-R10.

### Acceptance Examples

- AE1. **A contribution completes a real slot**
  - **Covers:** R2-R4.
  - **Given:** A thread has an unfilled Peak position.
  - **When:** A2 contributes an Apple Music track.
  - **Then:** The position displays the resolved song and a Spotify listener can open its counterpart through their saved preference.
- AE2. **Thread visuals reflect group input**
  - **Covers:** R7-R8.
  - **Given:** A completed thread has a prompt, five distinct roles, and contributor-selected mood cues.
  - **When:** Its thread page is rendered.
  - **Then:** Its visual identity reflects those inputs without presenting an automated mood classification as fact.
- AE3. **Export does not gate listening**
  - **Covers:** R9-R10.
  - **Given:** A listener has not authorized either provider.
  - **When:** They open a completed thread.
  - **Then:** They can still open individual songs in their saved provider; authorization is only requested after they choose Export.

### Success Criteria

- A meaningful share of started threads receive a second contributor and reach completion.
- Completed threads are played by listeners using both supported providers.
- Character increases completed-thread sharing or return listening without lowering contribution completion.
- Native playlist export is a retained-use action, not a prerequisite for contribution or playback.

### Scope Boundaries

**Deferred for later**

- Native-provider playlist export and connected-provider accounts.
- Public profiles, follow graphs, public discovery, joinability, moderation, and granular permissions.
- Embedding-based thread characterization, similarity, prompts, and recommendation.
- Synchronized playback, comments, reactions, voting, points, and leaderboards.

**Outside this product's identity**

- In-app music playback.
- Making account creation a condition of listening or contributing.
- Treating an automated music characterization as authoritative taste judgment.

### Dependencies and Assumptions

- The current per-track resolver remains the provider-neutral unit used by a thread.
- Native handoff from a listen.cx link to installed Apple Music and Spotify apps must be validated on iOS and macOS.
- Provider export requires product and authorization decisions that differ from the credential-free resolver.
- A future music embedding source must have dependable catalog coverage and a clear permission basis.

### Outstanding Questions

**Resolve Before Planning**

- Which initial social moment should Pass the Aux optimize for: a party, a group-chat ritual, a trip, or another specific occasion?

**Deferred to Planning**

- What finite thread length and musical-role set best fit the chosen occasion?
- What first-party source can support meaningful music characterization across Spotify and Apple Music without relying on opaque or poorly covered signals?
