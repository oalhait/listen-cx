import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import production from "./worker-production.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_PRODUCTION_VARS: Record<string, string | boolean>;
    }
  }
}

it("serves account settings and both music connections with production configuration", async () => {
  const configured = { ...env, ...env.TEST_PRODUCTION_VARS,
    SPOTIFY_CLIENT_ID: "test-client", PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(32)),
    APPLE_MUSIC_TEAM_ID: "test-team", APPLE_MUSIC_KEY_ID: "test-key", APPLE_MUSIC_PRIVATE_KEY_P8: "test-key",
  };
  const ctx = createExecutionContext();
  const page = await production.fetch(new Request("https://listen.cx/settings", { headers: { Accept: "text/html" } }) as Request<unknown, IncomingRequestCfProperties>, configured, ctx);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('id="account-page"');
  const account = await production.fetch(new Request("https://listen.cx/api/account") as Request<unknown, IncomingRequestCfProperties>, configured, ctx);
  expect(account.status).toBe(200);
  expect(await account.json()).toMatchObject({ account: null, available: { spotify: true, apple: true } });
  await waitOnExecutionContext(ctx);
});
