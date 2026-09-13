import path from "node:path";
import { readFile } from "node:fs/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const production = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
      return {
        wrangler: { configPath: "./wrangler.jsonc", environment: "staging" },
        miniflare: {
          durableObjects: { LEGACY_THREAD: { className: "ThreadLive", useSQLite: true } },
          bindings: {
            MUSIC_ACCOUNT_CONNECTIONS_ENABLED: "false",
            ACCOUNT_SUBSCRIPTIONS_ENABLED: "false",
            SPOTIFY_PUBLISHING_ENABLED: "false",
            APPLE_PUBLISHING_ENABLED: "false",
            TEST_PRODUCTION_VARS: production.vars,
            TEST_PRODUCTION_CONFIG: { main: production.main, migrations: production.migrations, durable_objects: production.durable_objects },
            TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          },
        },
      };
    }),
  ],
  test: {
    exclude: ["**/node_modules/**", "src/*.live.test.ts", "spikes/**"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
