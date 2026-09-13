# AGENTS.md

This repository contains source-provider track resolution, short links, and a
web-only Threads product, presented to invitees and MCP callers as shareable Jams.
Threads own ordered collaborative songs; Apple Music and Spotify are downstream
consumers, never authorities for website order. Chat and advisory votes are separate
collaboration state and must never advance playlist revisions or reorder songs.

## Scope

Keep source metadata, bounded provider retries, D1 storage, the Hono Worker API,
and the current frontend. Public Thread capabilities can read/contribute; separate
management capabilities remove/reorder/close. Preserve durable revisions and replay
receipts. Public Jam participants use a signed-in account identity or a digest-only
browser/caller capability; never expose raw participant keys, account IDs, or digests.
Keep chat plain text, vote/message retries idempotent, closed Jam history readable,
and moderation soft. Keep unresolved cross-provider identities explicit, never guessed matches.

Provider publishing remains blocked until a trusted adapter is authorized and
verified by actual provider readback. No native companion requirement, notifications,
old Thread Durable Object, playlist export, or public operator controls are restored.
Publishing spikes remain isolated research.

## Commands

`pnpm migrate:local`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm test:live`.
`pnpm types` regenerates Worker binding declarations after configuration changes.
Tests are co-located. Live tests use a separate Vitest configuration and make only
public read-only requests. Fixture tests do not prove current provider behavior.

## Compatibility

Preserve historical D1 migrations and stored rows. Legacy rows may contain guessed
cross-provider URLs; new rows only contain the source provider URL. No automatic
schema cleanup or remote deletion is part of this restart. The removed Thread
Durable Object needs an explicit migration decision before redeployment to an
existing environment. See README.md for the API and deployment implications.

Never deploy or perform mutating production deployment operations. Give Omar the
exact command to run himself. Read-only production inspection is allowed.
