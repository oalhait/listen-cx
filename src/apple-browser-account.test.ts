import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createAccountApp } from "./account-app.js";
import { D1AccountStore } from "./account-db.js";
import { sha256 } from "./thread.js";
import type { RuntimeEnv } from "./thread-publisher.js";

const origin = "https://staging.listen.cx";
const accounts = new D1AccountStore(env.DB);
afterEach(() => vi.restoreAllMocks());
const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find(value => value.startsWith(name + "="))!.split(";")[0]!;
async function setup() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pem = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey))));
  const secrets = { MUSIC_ACCOUNT_CONNECTIONS_ENABLED: "true", APPLE_PUBLISHING_ENABLED: "true", APPLE_MUSIC_KEY_ID: "KEY1234567",
    APPLE_MUSIC_TEAM_ID: "TEAM123456", APPLE_MUSIC_PRIVATE_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`, PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(32)) };
  const runtime = { ...env, ...secrets, THREAD_PUBLISHER: { getByName: (name: string) => ({
    async authorizeAccountApple(id: string, token: string) {
      const stub = env.THREAD_PUBLISHER.getByName(name);
      await runInDurableObject(stub, instance => Object.assign((instance as unknown as { env: RuntimeEnv }).env, secrets));
      await stub.authorizeAccountApple(id, token);
    },
  }) } } as unknown as RuntimeEnv;
  const app = createAccountApp(runtime, origin, () => {});
  const post = (path: string, body: unknown, cookie = "") => app.request(origin + path, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", "X-Listen-Action": "thread", Cookie: cookie }, body: JSON.stringify(body) });
  const get = (cookie = "") => app.request(origin + "/api/account", { headers: { Cookie: cookie } });
  const prepare = async (cookie = "") => {
    const response = await post("/account/apple/prepare", {}, cookie);
    expect(response.status).toBe(200);
    const { authorizationBinding, developerToken } = await response.json() as { authorizationBinding: string; developerToken: string };
    expect(developerToken.split('.')).toHaveLength(3);
    return { cookie: cookieOf(response, "listen_apple_browser"), authorizationBinding };
  };
  return { app, post, get, prepare };
}

it("connects directly with MusicKit credentials, validates the grant in the real account object, and seals it before issuing a session", async () => {
  const f = await setup();
  expect(await (await f.get()).json()).toMatchObject({ account: null, available: { apple: true } });
  const prepared = await f.prepare();
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://api.music.apple.com/v1/me/storefront");
    expect(new Headers(init?.headers).get("Music-User-Token")).toBe("personal-grant");
    return Response.json({ data: [{ id: "us" }] });
  });
  const body = { authorizationBinding: prepared.authorizationBinding, musicUserToken: "personal-grant" };
  expect((await f.post("/account/apple/authorize", body)).status).toBe(403);
  expect(network).not.toHaveBeenCalled();
  const response = await f.post("/account/apple/authorize", body, prepared.cookie);
  expect(response.status).toBe(200);
  const session = cookieOf(response, "listen_account");
  expect(await (await f.get(session)).json()).toMatchObject({ account: { provider: "apple", connected: true, browserOnly: true } });
  expect((await f.post("/account/apple/authorize", body, prepared.cookie)).status).toBe(403);
  const rows = await env.DB.prepare("SELECT encrypted_credentials AS credentials FROM accounts WHERE provider_subject LIKE 'browser:%'").all<{ credentials: string }>();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0]!.credentials).not.toContain("personal-grant");
});

it("does not issue a session for a rejected MusicKit grant", async () => {
  const f = await setup();
  const prepared = await f.prepare();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  const response = await f.post("/account/apple/authorize", { authorizationBinding: prepared.authorizationBinding, musicUserToken: "revoked" }, prepared.cookie);
  expect(response.status).toBe(400);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await (await f.get(prepared.cookie)).json()).toMatchObject({ account: null });
});

it("returns to the same browser account after sign-out without merging different browsers", async () => {
  const f = await setup();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [{ id: "us" }] }));
  const first = await f.prepare();
  const response = await f.post("/account/apple/authorize", { authorizationBinding: first.authorizationBinding, musicUserToken: "valid" }, first.cookie);
  const session = cookieOf(response, "listen_account");
  const original = await accounts.session(await sha256(session.split('=')[1]!));
  await f.post("/account/sign-out", {}, `${session}; ${first.cookie}`);
  const again = await f.prepare(first.cookie);
  const resumed = await f.post("/account/apple/authorize", { authorizationBinding: again.authorizationBinding, musicUserToken: "valid" }, again.cookie);
  const restored = await accounts.session(await sha256(cookieOf(resumed, "listen_account").split('=')[1]!));
  expect(restored!.id).toBe(original!.id);
  const other = await f.prepare();
  const separate = await f.post("/account/apple/authorize", { authorizationBinding: other.authorizationBinding, musicUserToken: "valid" }, other.cookie);
  const different = await accounts.session(await sha256(cookieOf(separate, "listen_account").split('=')[1]!));
  expect(different!.id).not.toBe(original!.id);
});

it("rejects a grant prepared before signing into Spotify, and cancels in-flight completion on sign-out", async () => {
  const f = await setup();
  const prepared = await f.prepare();
  const spotify = await accounts.upsert("spotify", "spotify-owner", "Spotify");
  const token = "s".repeat(43);
  await accounts.createSession(spotify.id, await sha256(token), Date.now() + 60000);
  const body = { authorizationBinding: prepared.authorizationBinding, musicUserToken: "valid" };
  expect((await f.post("/account/apple/authorize", body, `${prepared.cookie}; listen_account=${token}`)).status).toBe(403);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await f.post("/account/sign-out", {}, prepared.cookie);
    return Response.json({ data: [{ id: "us" }] });
  });
  const response = await f.post("/account/apple/authorize", body, prepared.cookie);
  expect(response.status).toBe(400);
  expect(response.headers.get("set-cookie")).toBeNull();
});
