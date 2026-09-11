import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { createHash } from 'node:crypto';

const now = Math.floor(Date.now() / 1000);
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './spikes/apple-publisher/https-auth/wrangler.jsonc', environment: 'dev' },
    miniflare: { bindings: { DEVELOPER_TOKEN: `header.${Buffer.from(JSON.stringify({ iat: now, exp: now + 900 })).toString('base64url')}.signature`, INVITE_DIGEST: createHash('sha256').update('a'.repeat(64)).digest('hex') } },
  })],
  test: { include: ['spikes/apple-publisher/https-auth/*.test.ts'] },
});
