# listen.cx

A cross-provider song link that remembers where each listener listens.

## Local development

```
pnpm install
pnpm types
pnpm migrate:local
pnpm dev
```

`pnpm dev` runs the isolated `dev` Wrangler environment against local D1 state.
Use `pnpm migrate:staging:local` followed by `pnpm dev:staging` for a local
staging-config simulation, or `pnpm dev:staging:remote` when you intentionally
need the shared QA database.
The shared staging environment remains `staging.listen.cx`; it is no longer the
default local development target.

## Verification

```
pnpm test
pnpm typecheck
pnpm types:check
```

## Cloudflare deployment

```
pnpm setup:dev        # one time: create listen-cx-dev and write its D1 ID
pnpm deploy:dev       # applies dev migrations and deploys only dev.listen.cx

pnpm migrate:staging
pnpm deploy:staging

pnpm migrate:production
pnpm deploy:production
```

Wrangler is pinned to the personal Cloudflare account in `wrangler.jsonc`.
The `dev`, staging, and production environments each have separate D1 binding
configuration. The dev Worker uses its `workers.dev` URL so local development
and deployment share one safe origin without requiring a DNS change. The first
`setup:dev`/`deploy:dev` run must be performed with access to the Cloudflare
account; Wrangler prints the deployed dev URL. No production command is needed
for local development.
