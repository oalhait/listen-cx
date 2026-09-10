import { SELF, env, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import worker from "./worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare module "cloudflare:test" { interface ProvidedEnv extends Cloudflare.Env {} }
const origin = "https://listen-cx-spotify-spike-staging.omar-alhait.workers.dev";
const control = { Authorization: `Bearer ${"test-operator-".repeat(4)}`, "Content-Type": "application/json" };
const A = "A".repeat(22), B = "B".repeat(22), C = "C".repeat(22), D = "D".repeat(22), P = "P".repeat(22);
const http = async (url: string, init?: RequestInit) => {
  const response = await SELF.fetch(url, init);
  return new Response(await response.arrayBuffer(), response);
};
const request = (path: string, body?: unknown, method = "POST", headers: HeadersInit = control) => http(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
const state = () => env.SPOTIFY_STATE.getByName("publisher");

let providerHandler: (url: URL, init?: RequestInit) => Response | Promise<Response>;
beforeEach(async () => {
  await runInDurableObject(state(), async (_instance, context) => { await context.storage.deleteAll(); });
  providerHandler = () => { throw new Error("Unexpected provider request"); };
  vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => providerHandler(new URL(String(input)), init)));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function invite() {
  const response = await request("/control/invitations");
  expect(response.status).toBe(201);
  return await response.json<{ inviteUrl: string; expiresAt: number }>();
}
async function begin() {
  const invitation = await invite();
  const landing = await http(invitation.inviteUrl, { redirect: "manual" });
  expect(landing.status).toBe(200);
  const html = await landing.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  const response = await http(origin + "/auth/start", {
    method: "POST", redirect: "manual", headers: { Origin: origin, Cookie: landing.headers.get("set-cookie")!.split(";")[0]!, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, ticket: new URL(invitation.inviteUrl).searchParams.get("ticket")! }).toString(),
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { invitation, response, location, cookie, callback: `${origin}/auth/callback?code=consent-code&state=${location.searchParams.get("state")}` };
}
function providerAuth(status = 200, expiresIn = 3600) {
  providerHandler = (url) => {
    if (url.href === "https://accounts.spotify.com/api/token") return Response.json({ access_token: "provider-access-secret", refresh_token: "provider-refresh-secret", expires_in: expiresIn, scope: "playlist-modify-public", token_type: "Bearer" });
    if (url.href === "https://api.spotify.com/v1/me") return Response.json(status === 200 ? { id: "friend-owner", account_id: "immutable-friend" } : { error: { status, message: "The user is not registered for this application." } }, { status });
    throw new Error("Unexpected provider request");
  };
}
async function authorize(expiresIn = 3600) {
  const flow = await begin(); providerAuth(200, expiresIn);
  const response = await http(flow.callback, { headers: { Cookie: flow.cookie }, redirect: "manual" });
  expect(response.status).toBe(200);
  const current = await (await request("/control/status", undefined, "GET")).json<{ candidate: { candidateId: string; publisherId: string } }>();
  return { ...flow, response, candidate: current.candidate };
}
async function confirm(candidate: { candidateId: string; publisherId: string }) {
  return request("/control/confirm", { ...candidate, appMode: "development" });
}
function providerPlaylists() {
  let tracks: string[] = [], marker = "", snapshot = 0, creates = 0;
  providerHandler = (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v1/me") return Response.json({ id: "friend-owner" });
    if (url.pathname === "/v1/me/playlists") { marker = body.description; creates++; return Response.json({ id: P }, { status: 201 }); }
    if (url.pathname === `/v1/playlists/${P}`) return Response.json({ id: P, owner: { id: "friend-owner" }, public: true, description: marker, snapshot_id: String(snapshot) });
    if (url.pathname.endsWith("/items")) {
      if (init?.method === "PUT") { tracks = body.uris; snapshot++; return Response.json({ snapshot_id: String(snapshot) }); }
      return Response.json({ items: tracks.map(uri => ({ item: { type: "track", uri } })), total: tracks.length, next: null });
    }
    throw new Error("Unexpected provider request");
  };
  return { tracks: () => tracks, creates: () => creates };
}

describe("isolated Spotify staging security and HTTP", () => {
  it("requires operator authorization for controls and keeps status private", async () => {
    for (const path of ["/control/invitations", "/control/confirm", "/control/desired", "/control/status"]) {
      expect((await request(path, undefined, path.endsWith("status") ? "GET" : "POST", {})).status).toBe(401);
    }
    const health = await http(origin + "/health");
    expect(health.status).toBe(200);
    expect(await health.text()).not.toContain("publisherId");
  });

  it("rejects host confusion, HTTP, CORS and oversized control bodies", async () => {
    expect((await http("http://listen-cx-spotify-spike-staging.omar-alhait.workers.dev/health")).status).toBe(400);
    expect((await http("https://attacker.example/health")).status).toBe(400);
    const response = await request("/control/invitations", undefined, "POST", { ...control, Origin: "https://attacker.example" });
    expect(response.status).toBe(403);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect((await request("/control/confirm", { text: "x".repeat(65000) })).status).toBe(413);
  });

  it("issues single-use short-lived invitations without operator secrets", async () => {
    const flow = await begin();
    expect(flow.invitation.inviteUrl).not.toContain(control.Authorization);
    expect(flow.invitation.expiresAt).toBeGreaterThan(Date.now());
    expect(flow.response.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(flow.response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(flow.location.origin).toBe("https://accounts.spotify.com");
    expect(flow.location.searchParams.get("redirect_uri")).toBe(origin + "/auth/callback");
    expect(flow.location.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await http(flow.invitation.inviteUrl, { redirect: "manual" })).status).toBe(400);
    expect((await http(origin + "/auth/invite?ticket=guessed", { redirect: "manual" })).status).toBe(400);
  });

  it("requires browser cookie and OAuth state and consumes callback only once", async () => {
    const flow = await begin();
    expect((await http(flow.callback)).status).toBe(400);
    expect((await http(flow.callback, { headers: { Cookie: "__Host-spotify-spike=wrong" } })).status).toBe(400);
    expect((await http(flow.callback.replace(/state=[^&]+/, "state=wrong"), { headers: { Cookie: flow.cookie } })).status).toBe(400);
    providerAuth();
    const success = await http(flow.callback, { headers: { Cookie: flow.cookie } });
    expect(success.status).toBe(200);
    expect(await success.text()).not.toMatch(/provider-access-secret|provider-refresh-secret|friend-owner/);
    expect((await http(flow.callback, { headers: { Cookie: flow.cookie } })).status).toBe(400);
  });

  it("rejects expired invitations and callbacks before provider requests", async () => {
    const invitation = await invite();
    await runInDurableObject(state(), async (_instance, context) => { const record = await context.storage.get<Record<string, unknown>>("invitation"); await context.storage.put("invitation", { ...record, expiresAt: 0 }); });
    expect((await http(invitation.inviteUrl, { redirect: "manual" })).status).toBe(400);
    const flow = await begin();
    await runInDurableObject(state(), async (_instance, context) => { const record = await context.storage.get<Record<string, unknown>>("flow"); await context.storage.put("flow", { ...record, expiresAt: 0 }); });
    expect((await http(flow.callback, { headers: { Cookie: flow.cookie } })).status).toBe(400);
  });

  it("encrypts pending tokens and prevents writes until operator confirms identity and mode", async () => {
    const flow = await authorize();
    const stored = await runInDurableObject(state(), async (_instance, context) => JSON.stringify([...await context.storage.list()]));
    expect(stored).not.toMatch(/provider-access-secret|provider-refresh-secret/);
    expect((await request("/control/desired", { playlistKey: "remote-spike", revision: 1, trackIds: [A] }, "PUT")).status).toBe(401);
    expect((await request("/control/confirm", { ...flow.candidate, publisherId: "wrong", appMode: "development" })).status).toBe(403);
    expect((await request("/control/confirm", { ...flow.candidate, appMode: "guess" })).status).toBe(400);
    expect((await confirm(flow.candidate)).status).toBe(200);
    const after = await runInDurableObject(state(), async (_instance, context) => JSON.stringify([...await context.storage.list()]));
    expect(after).not.toMatch(/provider-access-secret|provider-refresh-secret/);
    expect((await confirm(flow.candidate)).status).toBe(409);
  });

  it("survives durable-object restart and reconciles stable playlist ID via HTTP", async () => {
    const flow = await authorize();
    await abortAllDurableObjects();
    expect((await confirm(flow.candidate)).status).toBe(200);
    const spotify = providerPlaylists();
    const first = await request("/control/desired", { playlistKey: "remote-spike", revision: 1, trackIds: [A, B, C] }, "PUT");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ providerPlaylistId: P, appliedRevision: 1 });
    await abortAllDurableObjects();
    const next = await request("/control/desired", { playlistKey: "remote-spike", revision: 2, trackIds: [C, A, D] }, "PUT");
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ providerPlaylistId: P, appliedRevision: 2 });
    expect(spotify.tracks()).toEqual([C, A, D].map(id => `spotify:track:${id}`));
    expect(spotify.creates()).toBe(1);
  });

  it("retains actionable provider denial only behind operator authentication", async () => {
    const flow = await begin(); providerAuth(403);
    const callback = await http(flow.callback, { headers: { Cookie: flow.cookie } });
    expect(callback.status).toBe(403);
    expect(await callback.text()).not.toMatch(/provider-access-secret|provider-refresh-secret/);
    const current = await (await request("/control/status", undefined, "GET")).json();
    expect(current).toMatchObject({ authorized: false, lastVerificationFailure: { status: 403, message: "The user is not registered for this application." } });
  });
  it("fails closed when the operator secret is absent instead of accepting Bearer undefined", async () => {
    const missing = { ...env };
    Reflect.deleteProperty(missing, "OPERATOR_TOKEN");
    const response = await worker.fetch(new Request(origin + "/control/invitations", { method: "POST", headers: { Authorization: "Bearer undefined" } }), missing);
    expect(response.status).toBe(503);
  });

  it("rejects tampered encrypted credentials without confirming or exposing them", async () => {
    const flow = await authorize();
    await runInDurableObject(state(), async (_instance, context) => {
      const candidate = await context.storage.get<{ tokens: { ciphertext: string } }>("candidate");
      candidate!.tokens.ciphertext = "tampered";
      await context.storage.put("candidate", candidate);
    });
    const response = await confirm(flow.candidate);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/provider-access-secret|provider-refresh-secret/);
    expect(await (await request("/control/status", undefined, "GET")).json()).toMatchObject({ authorized: false });
  });

  it("exchanges a concurrent callback at most once", async () => {
    const flow = await begin(); providerAuth();
    const responses = await Promise.all([1, 2].map(() => http(flow.callback, { headers: { Cookie: flow.cookie } })));
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(responses.some(r => [400, 409].includes(r.status))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "https://accounts.spotify.com/api/token")).toHaveLength(1);
  });

  it("refreshes tokens server-side and persists the rotated refresh token encrypted", async () => {
    const flow = await authorize(10); expect((await confirm(flow.candidate)).status).toBe(200);
    providerPlaylists();
    const playlistsHandler = providerHandler;
    let refreshes = 0;
    providerHandler = (url, init) => {
      if (url.href === "https://accounts.spotify.com/api/token") {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("provider-refresh-secret");
        refreshes++;
        return Response.json({ access_token: "rotated-access-secret", refresh_token: "rotated-refresh-secret", expires_in: 3600 });
      }
      return playlistsHandler(url, init);
    };
    expect((await request("/control/desired", { playlistKey: "refresh-spike", revision: 1, trackIds: [A] }, "PUT")).status).toBe(200);
    expect(refreshes).toBe(1);
    const stored = await runInDurableObject(state(), async (_instance, context) => JSON.stringify([...await context.storage.list()]));
    expect(stored).not.toMatch(/provider-refresh-secret|rotated-access-secret|rotated-refresh-secret/);
  });

  it("serializes publisher control changes with in-flight reconciliation", async () => {
    const flow = await authorize(); await confirm(flow.candidate); providerPlaylists();
    const playlistsHandler = providerHandler;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    providerHandler = async (url, init) => {
      if (init?.method === "PUT") { entered(); await gate; }
      return playlistsHandler(url, init);
    };
    const publishing = request("/control/desired", { playlistKey: "serial-spike", revision: 1, trackIds: [A] }, "PUT");
    await started;
    const invitation = await request("/control/invitations");
    release();
    expect((await publishing).status).toBe(200);
    expect(invitation.status).toBe(409);
  });

  it("does not consume invitations on preview GET and requires same-origin browser-bound POST", async () => {
    const invitation = await invite();
    const preview = await http(invitation.inviteUrl, { redirect: "manual" });
    expect(preview.status).toBe(200);
    const landing = await http(invitation.inviteUrl, { redirect: "manual" });
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain("Continue with Spotify");
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
    const ticket = new URL(invitation.inviteUrl).searchParams.get("ticket")!;
    const cookie = landing.headers.get("set-cookie")!.split(";")[0]!;
    const form = new URLSearchParams({ ticket, csrf }).toString();
    const post = (browserOrigin: string, browserCookie = cookie) => http(origin + "/auth/start", { method: "POST", headers: { Origin: browserOrigin, Cookie: browserCookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
    expect((await post("https://attacker.example")).status).toBe(403);
    expect((await post(origin, "")).status).toBe(400);
    expect((await post(origin)).status).toBe(302);
    expect((await post(origin)).status).toBe(400);
  });

});
