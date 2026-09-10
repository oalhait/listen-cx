import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./spikes/spotify-publisher/staging/wrangler.jsonc", environment: "staging" },
    miniflare: { bindings: { SPOTIFY_CLIENT_ID: "test-client", OPERATOR_TOKEN: "test-operator-".repeat(4), TOKEN_ENCRYPTION_KEY: "11".repeat(32) } },
  })],
  test: { include: ["spikes/spotify-publisher/staging/*.test.ts"] },
});
