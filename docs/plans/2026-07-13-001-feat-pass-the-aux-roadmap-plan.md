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
- **Resolved wedge:** Optimize first for a repeatable, prompt-led “pass the aux” round in an existing small group chat: one friend starts a five-song handoff and the finished index is shared back to the chat. Party and trip variants would pull the product toward synchronized playback or provider-native control.
- **Open release dependency:** Verify native Apple Music and Spotify handoff on iOS and macOS before treating a completed thread as ready to listen.

---

## Product Contract

### Summary

Introduce Pass the Aux as a finite, unlisted group-chat relay. A host passes an invite along; each participant adds a provider-agnostic song to a purposeful position in a shared sequence. Character, export, public discovery, and music intelligence arrive only after the core contribution loop proves useful.

### Problem Frame

People already build shared playlists through group-chat links, screenshots, and fragmented provider-specific collections. The work is social but the result is not portable: a contributor's preferred service can become a constraint for everyone else. A generic collaborative playlist would reproduce the usual link dump without giving the group a reason to finish something together.

### Key Decisions

- **Finite threads before ongoing rooms.** A short, completable sequence gives every contribution an editorial purpose and avoids the moderation and identity burden of an endless shared collection.
- **Group chat is the first coordination surface.** listen.cx supplies the finite artifact; the existing chat supplies conversation, notification, and social context.
- **Contribution is the game.** Thread slots or prompts should create a musical handoff; abstract points, leaderboards, and voting do not improve the shared listening result.
- **Character begins with declared signals.** Prompt, role, sequence, artwork palette, and optional participant mood cues may shape the visual treatment before any automated music interpretation is trusted.
- **Export is opt-in and post-completion.** Saving a completed thread as a native playlist requires provider authorization and is not part of the low-touch contribution or playback path.
- **Public identity comes later.** Threads stay unlisted by default. Publishing, joinability, and permissioning require durable ownership and moderation decisions that the no-account MVP should not pretend to solve.

### Roadmap and Plan Set

| Track | Deliverable | Decision | Trigger or dependency | Backing plan |
|---|---|---|---|---|
| Foundation | Private Pass the Aux MVP | Build and dogfood a five-role group-chat relay with account-free contribution, separate invite/host capabilities, atomic slot claims, and existing cross-provider playback. | Native handoff must pass the staging device matrix before release. | [`2026-07-13-002-feat-private-pass-the-aux-threads-plan.md`](2026-07-13-002-feat-private-pass-the-aux-threads-plan.md) |
| Follow-on A | Declared thread character | Test deterministic in-progress role feedback and a richer completed “thread print.” No scores, inferred taste, or ambient motion. | The private-thread recruitment/completion gate passes. This does not depend on export. | [`2026-07-13-003-feat-declared-thread-character-plan.md`](2026-07-13-003-feat-declared-thread-character-plan.md) |
| Follow-on B | Native provider export | Run an Apple Music staging spike. Keep Spotify internal-only until public quota and cross-service policy gates are cleared. | Completed immutable threads exist. This may proceed independently of character. | [`2026-07-13-004-feat-provider-playlist-export-plan.md`](2026-07-13-004-feat-provider-playlist-export-plan.md) |
| Future horizon | Durable ownership and public threads | Split into four gates: ownership, share-only publishing, passkey-backed proposals, then opt-in discovery/indexing. Private contribution and listening remain account-free. | Demonstrated demand to publish beyond the originating chat plus separate moderation, privacy, legal, and abuse gates. | [`2026-07-13-005-feat-public-thread-ownership-publishing-plan.md`](2026-07-13-005-feat-public-thread-ownership-publishing-plan.md) |
| Research gate | Embedding-based music intelligence | Do not implement from provider previews or open models. Only reopen after a contract-backed enrichment source passes rights, coverage, cost, human-fit, and false-objectivity gates against `declared-v1`. | A lawful provider-independent signal exists and the declared baseline is frozen. | [`2026-07-13-006-research-embedding-music-intelligence-decision.md`](2026-07-13-006-research-embedding-music-intelligence-decision.md) |

### MVP Boundary

The first shippable unit is Phase 1 only: one fixed five-role template—Opener, Build, Peak, Curveball, Closer—inside an unlisted group-chat relay. It includes host close/remove controls, account-free Spotify/Apple contribution, ordered completion, existing receiver-side playback, a staging-only feature gate, and privacy-bounded funnel instrumentation.

Character, provider export, public identity/publishing, discovery, and music intelligence are not MVP dependencies. They must not add authorization, SDK loading, provider calls, or identity requirements to the private contribution and playback paths.

Phase 1 listening is an ordered index of independent provider handoffs, not continuous playback: each song opens separately in the listener's provider. The MVP validates the contribution ritual and portable finished artifact. Native export is the later path to provider-managed sequence playback, so weak repeat listening alone must not be interpreted as failure of collaborative contribution.

### MVP Security and Privacy Posture

- “Unlisted” means bearer access, not confidentiality or recipient identity. Anyone holding the invite may view and contribute during the write window.
- Invite, management, contributor, and idempotency capabilities are high-entropy and least-privilege. The management secret is delivered separately, must be saved by the host, has no identity-based recovery in the private MVP, and must not enter unfurls, application logs, analytics, referrers, or third-party page dependencies.
- Anonymous creation and contribution use bounded inputs, finite slots, provider-URL prevalidation, and a staging feature gate. A production rate-limit decision is required after measuring resolver amplification; account creation is not the abuse control.
- The MVP has a seven-day contribution window and a 180-day unlisted view window. It does not claim physical deletion or invite revocation; those remain explicit follow-ups rather than hidden promises.
- Distinct-contributor measurement is advisory and per-thread/per-browser only. Instrumentation stores aggregate thread facts without raw IPs, device fingerprints, cross-thread participant identity, prompts, provider URLs, or capability values.

### Actors

- A1. **Host:** Starts a thread and passes its invitation to a small group.
- A2. **Contributor:** Adds one song from Spotify or Apple Music to a meaningful open position.
- A3. **Listener:** Opens a completed thread and listens to any song in their preferred provider.
- A4. **Future publisher:** Chooses whether a thread becomes visible beyond its original invitees.

### Requirements

**Phase 1 — private Pass the Aux threads**

- R1. A1 can create an unlisted, finite music thread with a title and optional prompt.
- R2. A thread presents a small set of purposeful song positions that form an ordered listening sequence.
- R3. A2 can open an invitation and contribute one active Spotify or Apple Music track per browser without creating an account. This is an advisory limit, not a claim of person-level identity.
- R4. Each accepted contribution resolves once into the existing cross-provider track representation and remains individually playable through A3's provider preference.
- R5. A1 receives a separate private management capability to close the thread or remove an unsuitable contribution without turning the public invite into an editor; losing that capability has no identity-based recovery in the private MVP.
- R6. The fifth accepted contribution completes the thread and makes invite-level contribution read-only. Closing an incomplete thread leaves a playable partial mix; host removal from a completed mix reopens that role for the bounded replacement window defined by the private-thread plan.

**Phase 2 — thread character**

- R7. A thread has a visual identity derived from the group’s declared prompt, roles, sequencing, artwork, and optional mood signals. A contributor may add a cue after track acceptance, but skipping it never blocks contribution or valid character rendering.
- R8. The identity makes the sequence easier to understand and more desirable to share; it is not a cosmetic score or a claim of objective musical analysis.

**Phase 3 — provider export**

- R9. A listener may explicitly authorize a supported provider to save a completed thread as a native playlist.
- R10. Export is optional, happens after the core thread is complete, and does not alter the account-free invitation or listener redirect flows.

**Phase 4 and later — public threads and music intelligence**

- R11. Public publishing, joinability, and permissioning remain opt-in capabilities built on a durable ownership and moderation model.
- R12. Any embedding-based characterization uses a reliable, provider-independent music signal, is described as an interpretive reading, and earns its place by matching human judgments better than the declared-signal baseline.

**Cross-phase accessibility**

- R13. Creation, contribution, management, and listening remain keyboard- and touch-operable at narrow mobile widths; role order and state are conveyed in text and screen-reader semantics; character never relies only on color, artwork, or motion.

### Key Flows

- F1. **Pass a thread along**
  - **Trigger:** A1 starts a prompt-led pass-the-aux round in an existing small group chat.
  - **Steps:** A1 starts a thread, saves the separate management link, and shares the invite. A2 fills one open musical position; acceptance names the filled role, shows what remains, and makes passing the canonical invite onward the primary next action without requiring a recipient identity.
  - **Outcome:** The group creates an ordered, cross-provider mix rather than an unstructured link dump.
  - **Covered by:** R1-R6.
- F2. **Listen across providers**
  - **Trigger:** A3 opens a completed thread.
  - **Steps:** A3 views the ordered finished index, selects one song, and listen.cx hands off to their preferred provider. Returning for the next song is explicit; automatic continuation is not promised.
  - **Outcome:** The social object remains individually playable regardless of provider, while provider-managed continuous sequence playback stays deferred to export.
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
- The first gate is second-distinct-contributor rate; among recruited threads, completion and role-abandonment determine whether the five-role template survives.
- At least one completed thread containing tracks originating from one provider records successful playback through the opposite provider, proving actual portability rather than aggregate provider mix.
- Character increases completed-thread sharing against `declared-v1` control while seven-day completion and 24-hour contribution depth remain inside their preregistered non-inferiority margins. Improving contribution is welcome but is not required for the completed-artifact treatment to earn its place.
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

**Resolved in this plan set**

- The initial moment is an asynchronous ritual in an existing small group chat.
- The first dogfood template has five roles: Opener, Build, Peak, Curveball, and Closer. This is a measurable product hypothesis, not a universal optimum.
- Provider previews and open audio models do not currently provide a lawful, dependable music-intelligence path. A licensed enrichment vendor is the only research avenue left open.

**First questions to resolve with staging evidence, in order**

1. Do prompt-led rounds in real group chats receive a second distinct contributor? If not, rework the trigger and invitation before judging the five-role format.
2. Among threads that recruit a second contributor, do five roles finish and do contributors report that Opener/Build/Peak/Curveball/Closer made choosing a song easier? If recruitment is healthy but completion or comprehension stalls, test a shorter template; compare neutral numbered positions before treating named roles as the successful mechanism.
3. Does the ordered index feel like a worthwhile finished artifact before export? If contribution is healthy but repeat listening is weak, treat provider-managed sequence playback as an untested payoff rather than rejecting the social loop.
