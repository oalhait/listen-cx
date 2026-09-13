import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { D1ThreadStore } from "./thread-db.js";
import { D1LinkStore } from "./db.js";
import { createMusicConnectionsApp, connectionTarget, requireMusicConnection } from "./music-connections-app.js";
import type { RuntimeEnv } from "./thread-publisher.js";
import { availableConnections } from "./publishing-bindings.js";

const baseUrl = "https://staging.listen.cx";
const runtime = { ...env, MUSIC_ACCOUNT_CONNECTIONS_ENABLED: "true", SPOTIFY_PUBLISHING_ENABLED: "true", SPOTIFY_CLIENT_ID: "client", PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(32)) };
const store = new D1ThreadStore(env.DB);
const onChange = vi.fn();
const app = createApp({ baseUrl, store: new D1LinkStore(env.DB), threadStore: store, resolver: { resolve: async () => null },
  connections: createMusicConnectionsApp(runtime, baseUrl, onChange),
  publishing: { availableProviders: availableConnections(runtime), onChange, requireConnection: (auth, provider) => requireMusicConnection(runtime, auth, provider) },
});
const post = (path: string, body: unknown, cookie?: string) => app.request(baseUrl + path, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl, "X-Listen-Action": "thread", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
});
afterEach(() => { vi.restoreAllMocks(); onChange.mockClear(); });

async function create() {
  const created = await post("/api/threads", { title: "Connections", creationKey: crypto.randomUUID().replaceAll("-", "").slice(0, 22) });
  const data = await created.json() as { thread: { publicCapability: string } };
  const cap = data.thread.publicCapability;
  const key = await connectionTarget(runtime, cap, "spotify");
  await runInDurableObject(env.THREAD_PUBLISHER.getByName(key), instance => {
    Object.assign((instance as unknown as { env: RuntimeEnv }).env, runtime);
  });
  return { cap, key, cookie: created.headers.get("set-cookie")!.split(";")[0]!, path: `/t/${cap}/manage/apps` };
}

it("requires this Thread's management cookie and same-origin action before authorization", async () => {
  const f = await create();
  const other = await create();
  const network = vi.spyOn(globalThis, "fetch");
  expect((await app.request(baseUrl + f.path)).status).toBe(403);
  expect((await post(f.path + "/spotify/start", {}, other.cookie)).status).toBe(403);
  expect((await post(f.path + "/apple/token", {})).status).toBe(403);
  expect((await post(f.path + "/apple/authorize", { musicUserToken: "x".repeat(17000) }, f.cookie)).status).toBe(413);
  expect((await app.request(baseUrl + f.path + "/spotify/start", { method: "POST", headers: { Cookie: f.cookie, Origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  expect(network).not.toHaveBeenCalled();
  const page = await app.request(baseUrl + f.path, { headers: { Cookie: f.cookie } });
  expect(page.status).toBe(200);
  expect(page.headers.get("referrer-policy")).toBe("strict-origin");
  expect(page.headers.get("content-security-policy")).toContain("https://js-cdn.music.apple.com");
  const status = await app.request(baseUrl + f.path + "/status", { headers: { Cookie: f.cookie } });
  expect(status.headers.get("referrer-policy")).toBe("no-referrer");
  expect(status.headers.get("cache-control")).toBe("private, no-store");
  expect(await status.text()).not.toContain(f.key);
});

it("completes a browser-bound Spotify callback then requires an explicit authorized sync action", async () => {
  const f = await create();
  const connect = { kind: "connect", provider: "spotify", expectedRevision: 0, requestKey: "connect" };
  const manage = `/t/${f.cap}/manage/mutate`;
  expect((await post(manage, connect, f.cookie)).status).toBe(403);
  const started = await post(f.path + "/spotify/start", {}, f.cookie);
  expect(started.status).toBe(200);
  const { url } = await started.json() as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const callback = `${baseUrl}/connections/spotify/callback?code=private-code&state=${encodeURIComponent(state)}`;
  const browserCookie = started.headers.get("set-cookie")!.split(";")[0]!;
  expect(started.headers.get("set-cookie")).toMatch(/HttpOnly/);
  expect(started.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("api/token")
    ? Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, scope: "playlist-modify-public", token_type: "Bearer" })
    : Response.json({ id: "owner", display_name: "Omar" }));
  expect((await app.request(callback)).status).toBe(400);
  expect(network).not.toHaveBeenCalled();
  const finished = await app.request(callback, { headers: { Cookie: browserCookie } });
  expect(finished.status).toBe(200);
  expect(await finished.text()).toContain(f.path + "?spotify=authorized");
  expect((await store.get(f.cap))!.publications.find(p => p.provider === "spotify")!.connected).toBe(false);
  expect((await post(manage, connect, f.cookie)).status).toBe(200);
  expect((await store.get(f.cap))!.publications.find(p => p.provider === "spotify")!.connected).toBe(true);
  const replay = await app.request(callback, { headers: { Cookie: browserCookie } });
  expect(await replay.text()).toContain(f.path + "?spotify=error");
  expect(network).toHaveBeenCalledTimes(2);
  const status = await app.request(baseUrl + f.path + "/status", { headers: { Cookie: f.cookie } });
  const text = await status.text();
  expect(text).toContain("Omar");
  expect(text).not.toContain("private-");
  expect(text).not.toContain(f.key);
});
