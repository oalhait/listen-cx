# AGENTS.md

This repository is restarting from provider primitives and a JSON short-link API.
The prior UI and Thread product decisions are historical, not requirements for
new work. Do not rebuild them unless Omar requests it.

## Scope

Keep URL parsing, Spotify/Apple metadata clients, bounded retries, source metadata
resolution, D1 short-link storage, and the Hono Worker API. No frontend, cookies,
redirect handoff, threads, notifications, Raycast, or playlist OAuth flows remain.
Cross-provider catalog candidates must not be represented as verified matches.

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
