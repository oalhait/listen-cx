import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { createAccountApp } from "./account-app.js";
import { D1AccountStore } from "./account-db.js";
import { D1ThreadStore } from "./thread-db.js";
import { sha256 } from "./thread.js";
import { unseal } from "./music-auth.js";
import type { RuntimeEnv } from "./thread-publisher.js";

const origin = "https://staging.listen.cx";
const accounts = new D1AccountStore(env.DB);
const runtime = { ...env, MUSIC_ACCOUNT_CONNECTIONS_ENABLED: "true", SPOTIFY_PUBLISHING_ENABLED: "true",
  SPOTIFY_CLIENT_ID: "client", PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(32)),
  THREAD_PUBLISHER: { getByName: () => ({ setAccountCredentials: (id: string, value: string) => accounts.setCredentials(id, value) }) },
} as unknown as RuntimeEnv;
const changed = vi.fn();
const app = createAccountApp(runtime, origin, changed);
const post = (path: string, body: unknown, cookie = "") => app.request(origin + path, { method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, "X-Listen-Action": "thread", Cookie: cookie }, body: JSON.stringify(body) });
const get = (path: string, cookie = "") => app.request(origin + path, { headers: { Cookie: cookie } });
afterEach(() => { vi.restoreAllMocks(); changed.mockClear(); });
async function login(provider: "apple" | "spotify", subject: string = crypto.randomUUID(), credentials?: string) {
  const account = await accounts.upsert(provider, subject, "My music", credentials);
  const token = btoa(crypto.randomUUID()).replaceAll("=", "").slice(0, 43);
  await accounts.createSession(account.id, await sha256(token), Date.now() + 600000);
  return { account, cookie: `listen_account=${token}` };
}

it("keeps account and subscriber data private and requires same-origin signed-in mutations", async () => {
  const thread = await new D1ThreadStore(env.DB).create("Personal copies", crypto.randomUUID().replaceAll("-", "").slice(0, 22));
  const path = `/api/threads/${thread.publicCapability}/subscription`;
  const owner = await login("spotify", "private-subject", "encrypted-value");
  expect((await post(path, { action: "subscribe" })).status).toBe(401);
  expect((await app.request(origin + path, { method: "POST", headers: { Cookie: owner.cookie, Origin: "https://evil.test", "Content-Type": "application/json" }, body: '{"action":"subscribe"}' })).status).toBe(403);
  const response = await post(path, { action: "subscribe" }, owner.cookie);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('"provider":"spotify"');
  for (const privateValue of [owner.account.id, "publisherKey", "private-subject", "encrypted-value"]) expect(body).not.toContain(privateValue);
  expect(changed).toHaveBeenCalledWith(thread.publicCapability);
  const other = await login("apple");
  expect(await (await get(path, other.cookie)).json()).toMatchObject({ subscription: null });
  expect(await (await get(path)).json()).toEqual({ account: null, connections: [], subscription: null });
  const settings = await get("/api/account", owner.cookie);
  expect(settings.headers.get("cache-control")).toBe("private, no-store");
  const text = await settings.text();
  expect(text).toContain("Personal copies");
  expect(text).not.toContain("encrypted-value");
  expect(text).not.toContain("private-subject");
  expect((await post(path, { action: "unsubscribe" }, other.cookie)).status).toBe(200);
  expect((await accounts.subscription(owner.account.id, thread.publicCapability))?.connected).toBe(true);
});

it("requires music permission while allowing an Apple account to begin connecting Spotify", async () => {
  const apple = await login("apple");
  expect((await post("/account/spotify/start", {}, apple.cookie)).status).toBe(200);
  const thread = await new D1ThreadStore(env.DB).create("Pending permission", crypto.randomUUID().replaceAll("-", "").slice(0, 22));
  expect((await post(`/api/threads/${thread.publicCapability}/subscription`, { action: "subscribe" }, apple.cookie)).status).toBe(403);
  const spotify = await login("spotify");
  expect((await post("/account/apple/authorize", { musicUserToken: "secret" }, spotify.cookie)).status).toBe(403);
  expect((await post("/account/apple/token", {}, spotify.cookie)).status).toBe(403);
});

it("uses single-use browser-bound Spotify state, encrypts tokens, and establishes a revocable account session", async () => {
  const started = await post("/account/spotify/start", { returnTo: "https://evil.test" });
  const { url } = await started.json() as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const browserCookie = started.headers.get("set-cookie")!.split(";")[0]!;
  const callback = `/account/spotify/callback?state=${encodeURIComponent(state)}&code=private-code`;
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("/api/token")
    ? Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, token_type: "Bearer" })
    : Response.json({ id: "display-id", account_id: "stable-id", display_name: "Omar" }));
  expect((await get(callback)).headers.get("location")).toBe("/settings?sign_in=failed");
  expect(network).not.toHaveBeenCalled();
  const completed = await get(callback, browserCookie);
  expect(completed.headers.get("location")).toBe("/settings");
  const cookie = completed.headers.getSetCookie().find(value => value.startsWith("listen_account="))!.split(";")[0]!;
  expect(cookie).toMatch(/^listen_account=[A-Za-z0-9_-]{43}$/);
  expect(completed.headers.getSetCookie().join(";")).toContain("HttpOnly");
  expect((await get(callback, browserCookie)).headers.get("location")).toBe("/settings?sign_in=failed");
  expect(network).toHaveBeenCalledTimes(2);
  const row = await env.DB.prepare("SELECT id, encrypted_credentials AS credentials FROM accounts WHERE provider_subject='stable-id'").first<{ id: string; credentials: string }>();
  expect(row!.credentials).not.toContain("private-");
  expect(await unseal(runtime.PUBLISHER_ENCRYPTION_KEY!, `account:${row!.id}`, JSON.parse(row!.credentials))).toMatchObject({ accountId: "stable-id", tokens: { refreshToken: "private-refresh" } });
  expect(await (await get("/api/account", cookie)).json()).toMatchObject({ account: { label: "Omar", provider: "spotify", connected: true } });
  expect((await post("/account/sign-out", {}, cookie)).status).toBe(200);
  expect(await (await get("/api/account", cookie)).json()).toMatchObject({ account: null });
});

it("refuses switching the provider account during reconnect without changing its credentials or session", async () => {
  const owner = await login("spotify", "original-owner", "original-encrypted");
  const started = await post("/account/spotify/start", {}, owner.cookie);
  const { url } = await started.json() as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const browser = started.headers.get("set-cookie")!.split(";")[0]!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("/api/token")
    ? Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, token_type: "Bearer" })
    : Response.json({ id: "another-owner" }));
  const result = await get(`/account/spotify/callback?state=${encodeURIComponent(state)}&code=code`, `${owner.cookie}; ${browser}`);
  expect(result.headers.get("location")).toBe("/settings?sign_in=failed");
  expect((await accounts.account(owner.account.id))!.credentials).toBe("original-encrypted");
  expect(await (await get("/api/account", owner.cookie)).json()).toMatchObject({ account: { provider: "spotify" } });
});

it("allows parallel sign-in tabs without a stale callback deleting the newer login binding", async () => {
  const first = await post("/account/spotify/start", {});
  const browser = first.headers.get("set-cookie")!.split(";")[0]!;
  const second = await post("/account/spotify/start", {}, browser);
  expect(second.headers.get("set-cookie")!.split(";")[0]).toBe(browser);
  const stale = await get("/account/spotify/callback?state=account.00000000-0000-0000-0000-000000000000&code=old", browser);
  expect(stale.headers.get("set-cookie")).toBeNull();
  const { url } = await second.json() as { url: string };
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("/api/token")
    ? Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" })
    : Response.json({ id: "parallel-owner" }));
  const callback = await get(`/account/spotify/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=new`, browser);
  expect(callback.headers.get("location")).toBe("/settings");
});

it("rejects Apple library grants prepared by a different or expired session", async () => {
  const first = await login("apple");
  const second = await login("apple");
  const snapshot = await (await get("/api/account", first.cookie)).json() as { authorizationBinding: string };
  expect((await post("/account/apple/authorize", { musicUserToken: "first-library", authorizationBinding: snapshot.authorizationBinding }, second.cookie)).status).toBe(403);
  expect((await post("/account/apple/token", { authorizationBinding: snapshot.authorizationBinding }, second.cookie)).status).toBe(403);
  expect((await accounts.account(second.account.id))?.credentials).toBeNull();
  expect((await post("/account/apple/authorize", { musicUserToken: "first-library" }, first.cookie)).status).toBe(403);
});

it("does not let a reconnect callback restore a signed-out session", async () => {
  const owner = await login("spotify", "logout-owner", "original-encrypted");
  const started = await post("/account/spotify/start", {}, owner.cookie);
  const { url } = await started.json() as { url: string };
  const browser = started.headers.get("set-cookie")!.split(";")[0]!;
  const loggedOut = await post("/account/sign-out", {}, owner.cookie);
  expect(loggedOut.headers.getSetCookie().join(";")).toContain("listen_login_browser=;");
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("/api/token")
    ? Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" })
    : Response.json({ id: "logout-owner" }));
  const callback = await get(`/account/spotify/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=new`, `${owner.cookie}; ${browser}`);
  expect(callback.headers.get("location")).toBe("/settings?sign_in=failed");
  expect(callback.headers.get("set-cookie")).toBeNull();
  expect((await accounts.account(owner.account.id))!.credentials).toBe("original-encrypted");
});

it("cannot recreate a session when sign-out finishes during reconnect credential persistence", async () => {
  const owner = await login("spotify", "racing-logout-owner", "original-encrypted");
  const started = await post("/account/spotify/start", {}, owner.cookie);
  const { url } = await started.json() as { url: string };
  const browser = started.headers.get("set-cookie")!.split(";")[0]!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("/api/token")
    ? Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" })
    : Response.json({ id: "racing-logout-owner" }));
  const original = accounts.setCredentials.bind(accounts);
  vi.spyOn(accounts, "setCredentials").mockImplementation(async (id, value) => {
    await post("/account/sign-out", {}, owner.cookie);
    await original(id, value);
  });
  const callback = await get(`/account/spotify/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=new`, `${owner.cookie}; ${browser}`);
  expect(callback.headers.get("location")).toBe("/settings?sign_in=failed");
  expect(callback.headers.get("set-cookie")).toBeNull();
  expect(await (await get("/api/account", owner.cookie)).json()).toMatchObject({ account: null });
});

it("links Spotify to an Apple session and keeps both subscriptions independently addressable", async () => {
  const owner = await login("apple", "browser:original", "apple-encrypted");
  const thread = await new D1ThreadStore(env.DB).create("Both libraries", "d".repeat(22));
  const original = await accounts.subscribe(owner.account.id, thread.publicCapability);
  const started = await post("/account/spotify/start", {}, owner.cookie);
  const { url } = await started.json() as { url: string };
  const browser = started.headers.getSetCookie()[0]!.split(";")[0]!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("/api/token")
    ? Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" })
    : Response.json({ id: "linked-spotify" }));
  const callback = await get(`/account/spotify/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=code`, `${owner.cookie}; ${browser}`);
  expect(callback.headers.get("location")).toBe("/settings");
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith("listen_account="))!.split(";")[0]!;
  const settings = await (await get("/api/account", cookie)).json() as { connections: { provider: string; connected: boolean }[] };
  expect(settings.connections).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider: "apple", connected: true }), expect.objectContaining({ provider: "spotify", connected: true }),
  ]));
  expect(settings.connections).toHaveLength(2);
  expect((await accounts.subscription(owner.account.id, thread.publicCapability))?.publisherKey).toBe(original.publisherKey);
  const path = `/api/threads/${thread.publicCapability}/subscription`;
  expect((await post(path, { action: "subscribe", provider: "spotify" }, cookie)).status).toBe(200);
  expect((await post(path, { action: "unsubscribe", provider: "apple" }, cookie)).status).toBe(200);
  const status = await (await get(path, cookie)).json() as { connections: { account: { provider: string }; subscription: { connected: boolean } }[] };
  expect(status.connections.find(value => value.account.provider === "apple")?.subscription.connected).toBe(false);
  expect(status.connections.find(value => value.account.provider === "spotify")?.subscription.connected).toBe(true);
  expect((await post(path, { action: "subscribe", provider: "unknown" }, cookie)).status).toBe(400);
  const outsider = await login("apple");
  expect((await post(path, { action: "unsubscribe", provider: "spotify" }, outsider.cookie)).status).toBe(403);
});

it("does not link a second provider after the initiating session signs out during token storage", async () => {
  const owner = await login("apple", "browser:logout-test", "apple-encrypted");
  const started = await post("/account/spotify/start", {}, owner.cookie);
  const { url } = await started.json() as { url: string };
  const browser = started.headers.getSetCookie()[0]!.split(";")[0]!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("/api/token")
    ? Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" })
    : Response.json({ id: "not-linked" }));
  const original = accounts.setCredentials.bind(accounts);
  vi.spyOn(accounts, "setCredentials").mockImplementation(async (id, value) => {
    await post("/account/sign-out", {}, owner.cookie);
    await original(id, value);
  });
  const callback = await get(`/account/spotify/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=code`, `${owner.cookie}; ${browser}`);
  expect(callback.headers.get("location")).toBe("/settings?sign_in=failed");
  expect(callback.headers.get("set-cookie")).toBeNull();
  expect(await accounts.connections(owner.account.id)).toHaveLength(1);
});

it('edits only the signed-in public profile and rejects unsafe or forged fields', async () => {
  const owner = await login('apple');
  const other = await login('spotify');
  const { profileBinding } = await (await get('/api/account', owner.cookie)).json() as { profileBinding: string };
  expect((await post('/api/account/profile', { displayName: 'Name', avatarUrl: null })).status).toBe(401);
  expect((await app.request(origin + '/api/account/profile', { method: 'POST', headers: { Cookie: owner.cookie, Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{"displayName":"Forged","avatarUrl":null}' })).status).toBe(403);
  for (const body of [{ displayName: '', avatarUrl: null }, { displayName: 'Name', avatarUrl: 'javascript:bad' }, { displayName: 'Name', avatarUrl: null, accountId: other.account.id }]) {
    expect((await post('/api/account/profile', { ...body, profileBinding }, owner.cookie)).status).toBe(400);
  }
  expect(await (await post('/api/account/profile', { displayName: '  Omar  ', avatarUrl: 'https://example.com/omar.jpg', profileBinding }, owner.cookie)).json()).toEqual({ profile: { displayName: 'Omar', avatarUrl: 'https://example.com/omar.jpg' } });
  expect(await (await get('/api/account', owner.cookie)).json()).toMatchObject({ profile: { displayName: 'Omar', avatarUrl: 'https://example.com/omar.jpg' } });
  expect(await (await get('/api/account', other.cookie)).json()).toMatchObject({ profile: { displayName: 'Listener', avatarUrl: null } });
  expect(await (await get('/api/account')).json()).toMatchObject({ profile: null });
});

it('imports an existing connected Spotify profile once using only its own verified account', async () => {
  const owner = await login('spotify', 'existing-profile-owner', 'encrypted');
  const token = vi.fn().mockResolvedValue('access');
  const localApp = createAccountApp({ ...runtime, THREAD_PUBLISHER: { getByName: (name: string) => {
    expect(name).toBe(`account_${owner.account.id}`);
    return { getAccountSpotifyToken: token };
  } } } as unknown as RuntimeEnv, origin, changed);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'playlist-owner', account_id: 'existing-profile-owner', display_name: 'Imported name', images: [{ url: 'https://i.scdn.co/image/photo' }] }));
  const read = () => localApp.request(origin + '/api/account', { headers: { Cookie: owner.cookie } });
  expect(await (await read()).json()).toMatchObject({ profile: { displayName: 'Imported name', avatarUrl: 'https://i.scdn.co/image/photo' } });
  await read();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(token).toHaveBeenCalledWith(owner.account.id);
});

it('does not import a mismatched Spotify identity and keeps settings available after provider failure', async () => {
  const owner = await login('spotify', 'expected-profile-owner', 'encrypted');
  const token = vi.fn().mockResolvedValue('access');
  const localApp = createAccountApp({ ...runtime, THREAD_PUBLISHER: { getByName: () => ({ getAccountSpotifyToken: token }) } } as unknown as RuntimeEnv, origin, changed);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'other-user', display_name: 'Wrong person' }));
  const read = () => localApp.request(origin + '/api/account', { headers: { Cookie: owner.cookie } });
  expect(await (await read()).json()).toMatchObject({ profile: { displayName: 'Listener', avatarUrl: null } });
  await read();
  expect(token).toHaveBeenCalledTimes(1);
});

it('rejects profile edits from a stale, different, or missing session binding', async () => {
  const owner = await login('apple');
  const other = await login('spotify');
  const { profileBinding, authorizationBinding } = await (await get('/api/account', owner.cookie)).json() as { profileBinding: string; authorizationBinding: string };
  const body = { displayName: 'Stale name', avatarUrl: null, profileBinding };
  expect((await post('/api/account/profile', body, other.cookie)).status).toBe(403);
  expect((await post('/api/account/profile', { ...body, profileBinding: undefined }, owner.cookie)).status).toBe(403);
  expect((await post('/api/account/profile', { ...body, profileBinding: authorizationBinding }, owner.cookie)).status).toBe(403);
  const { seal } = await import('./music-auth.js');
  const expired = JSON.stringify(await seal(runtime.PUBLISHER_ENCRYPTION_KEY!, 'profile-edit-grant', { accountId: owner.account.id, sessionHash: await sha256(owner.cookie.split('=')[1]!), expiresAt: Date.now() - 1 }));
  expect((await post('/api/account/profile', { ...body, profileBinding: expired }, owner.cookie)).status).toBe(403);
  expect((await post('/api/account/profile', body, owner.cookie)).status).toBe(200);
});
