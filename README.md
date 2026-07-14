# listen.cx

A cross-provider song link that remembers where each listener listens.

## Local development

```
pnpm install
pnpm types
pnpm migrate:local
pnpm dev
```

## Verification

```
pnpm test
pnpm typecheck
pnpm types:check
```

## Cloudflare deployment

```
pnpm migrate:staging
pnpm deploy:staging

pnpm migrate:production
pnpm deploy:production
```

Wrangler is pinned to the personal Cloudflare account in `wrangler.jsonc`.
Staging and production use separate D1 databases.
