import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createHarness } from "./harness.ts";

const A = "A".repeat(22), B = "B".repeat(22), C = "C".repeat(22), D = "D".repeat(22);
const playlistId = "P".repeat(22);
const controlToken = "local-control-".repeat(4);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });

async function fixture(discoverPublisher = false) {
  const directory = await mkdtemp(join(tmpdir(), "spotify-spike-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let tracks: string[] = [], marker = "", snapshot = 0;
  let now = Date.now();
  let tokenStatus = 200;
  let tokenPublisher = "publisher";
  const calls: { path: string; method: string; body: string }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url.hostname === "accounts.spotify.com") return Response.json({ access_token: "provider-secret", refresh_token: "refresh-secret", expires_in: 3600, scope: "playlist-modify-public", token_type: "Bearer" }, { status: tokenStatus });
    if (url.pathname === "/v1/me") return Response.json({ id: tokenPublisher });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v1/me/playlists") { marker = body.description; return Response.json({ id: playlistId }, { status: 201 }); }
    if (url.pathname === `/v1/playlists/${playlistId}`) return Response.json({ id: playlistId, public: true, owner: { id: "publisher" }, description: marker, snapshot_id: String(snapshot) });
    if (url.pathname.endsWith("/items")) {
      if (init?.method === "PUT") { tracks = body.uris; snapshot++; return Response.json({ snapshot_id: String(snapshot) }); }
      return Response.json({ items: tracks.map(uri => ({ item: { uri, type: "track" } })), total: tracks.length, next: null });
    }
    throw new Error("Unexpected provider request");
  });
  const config = { clientId: "client-id", publisherId: discoverPublisher ? undefined : "publisher", controlToken, appMode: discoverPublisher ? undefined : "development" as const, redirectUri: "http://127.0.0.1:8789/auth/callback", stateDirectory: directory, fetcher: fetcher as typeof fetch, now: () => now };
  const start = async () => {
    const harness = await createHarness(config);
    const url = await harness.listen(0);
    cleanup.push(() => harness.close());
    return { harness, url };
  };
  const first = await start();
  const headers = { authorization: `Bearer ${controlToken}`, "content-type": "application/json" };
  const request = (path: string, body?: unknown, method = "POST") => fetch(`${first.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const authorize = async () => {
    const response = await request("/auth/start");
    const data = await response.json() as { authorizationUrl: string };
    const auth = new URL(data.authorizationUrl);
    const callback = await fetch(`${first.url}/auth/callback?state=${auth.searchParams.get("state")}&code=code`, { redirect: "manual" });
    return { auth, callback };
  };
  return { ...first, start, directory, config, headers, request, authorize, calls, tracks: () => tracks, advance: (ms: number) => { now += ms; }, failToken: () => { tokenStatus = 401; }, wrongPublisher: () => { tokenPublisher = "other"; } };
}

describe("Spotify local HTTP harness", () => {
  it("requires control authorization and does not treat playlist keys as credentials", async () => {
    const f = await fixture();
    const response = await fetch(`${f.url}/desired`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ playlistKey: "acceptance", revision: 1, trackIds: [A] }) });
    expect(response.status).toBe(401);
    expect(f.calls).toHaveLength(0);
    expect((await f.request("/desired", {}, "PUT")).status).toBe(400);
  });

  it("uses state-bound PKCE, keeps provider tokens server-side, and rejects callback replays", async () => {
    const f = await fixture();
    const { auth, callback } = await f.authorize();
    expect(callback.status).toBe(200);
    expect(await callback.text()).not.toMatch(/provider-secret|refresh-secret/);
    expect(auth.searchParams.get("redirect_uri")).toBe(f.config.redirectUri);
    expect(auth.searchParams.get("scope")).toBe("playlist-modify-public");
    const exchange = new URLSearchParams(f.calls.find(c => c.path === "/api/token")?.body);
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
    expect(exchange.has("client_secret")).toBe(false);
    expect((await fetch(`${f.url}/auth/callback?state=${auth.searchParams.get("state")}&code=replay`)).status).toBe(400);
    expect((await stat(join(f.directory, "tokens.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects missing, wrong, and expired OAuth state before token exchange", async () => {
    const f = await fixture();
    expect((await fetch(`${f.url}/auth/callback?code=code`)).status).toBe(400);
    const start = await f.request("/auth/start");
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    expect((await fetch(`${f.url}/auth/callback?state=wrong&code=code`)).status).toBe(400);
    f.advance(11 * 60_000);
    expect((await fetch(`${f.url}/auth/callback?state=${new URL(authorizationUrl).searchParams.get("state")}&code=code`)).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it("rejects authorization from an unexpected publisher", async () => {
    const f = await fixture(); f.wrongPublisher();
    expect((await f.authorize()).callback.status).toBe(403);
    await expect(readFile(join(f.directory, "tokens.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes and updates through real local HTTP, persists state, and returns stale-revision conflict", async () => {
    const f = await fixture();
    expect((await f.request("/desired", { playlistKey: "acceptance", revision: 1, trackIds: [A, B, C] }, "PUT")).status).toBe(401);
    await f.authorize();
    const first = await f.request("/desired", { playlistKey: "acceptance", revision: 1, trackIds: [A, B, C] }, "PUT");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ providerPlaylistId: playlistId, appliedRevision: 1 });
    await f.harness.close();
    const restarted = await f.start();
    const result = await fetch(`${restarted.url}/desired`, { method: "PUT", headers: f.headers, body: JSON.stringify({ playlistKey: "acceptance", revision: 2, trackIds: [C, A, D] }) });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ providerPlaylistId: playlistId, appliedRevision: 2 });
    expect(f.tracks()).toEqual([C, A, D].map(id => `spotify:track:${id}`));
    const stale = await fetch(`${restarted.url}/desired`, { method: "PUT", headers: f.headers, body: JSON.stringify({ playlistKey: "acceptance", revision: 1, trackIds: [A] }) });
    expect(stale.status).toBe(409);
    expect(f.calls.filter(c => c.path === "/v1/me/playlists")).toHaveLength(1);
  });

  it("refreshes expired tokens server-side and fails closed on rejected refresh", async () => {
    const f = await fixture(); await f.authorize(); f.advance(3_601_000);
    expect((await f.request("/desired", { playlistKey: "acceptance", revision: 1, trackIds: [A] }, "PUT")).status).toBe(200);
    expect(new URLSearchParams(f.calls.filter(c => c.path === "/api/token")[1]?.body).get("grant_type")).toBe("refresh_token");
    f.advance(3_601_000); f.failToken();
    expect((await f.request("/desired", { playlistKey: "acceptance", revision: 2, trackIds: [B] }, "PUT")).status).toBe(401);
  });

  it("exposes controlled recovery without permitting arbitrary existing-playlist adoption", async () => {
    const f = await fixture(); await f.authorize();
    const response = await f.request("/recover-create", { playlistKey: "acceptance", providerPlaylistId: playlistId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "no_unresolved_create" });
    expect(f.calls.filter(c => c.path.startsWith("/v1/playlists/"))).toHaveLength(0);
  });

  it("blocks cross-origin control calls and malformed JSON", async () => {
    const f = await fixture();
    expect((await fetch(`${f.url}/auth/start`, { method: "POST", headers: { ...f.headers, origin: "https://attacker.example" } })).status).toBe(403);
    expect((await fetch(`${f.url}/desired`, { method: "PUT", headers: f.headers, body: "{" })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it("discovers publisher identity and requires explicit binding and observed app mode before writes", async () => {
    const f = await fixture(true);
    const { callback } = await f.authorize();
    expect(callback.status).toBe(200);
    expect(await callback.json()).toMatchObject({ authorized: false, candidatePublisherId: "publisher", confirmationRequired: true });
    expect((await f.request("/desired", { playlistKey: "acceptance", revision: 1, trackIds: [A] }, "PUT")).status).toBe(401);
    expect((await f.request("/auth/confirm", { publisherId: "other", appMode: "development" })).status).toBe(403);
    expect((await f.request("/auth/confirm", { publisherId: "publisher", appMode: "unknown" })).status).toBe(400);
    expect((await f.request("/auth/confirm", { publisherId: "publisher", appMode: "development" })).status).toBe(200);
    expect((await f.request("/desired", { playlistKey: "acceptance", revision: 1, trackIds: [A] }, "PUT")).status).toBe(200);
    await f.harness.close();
    const resumed = await f.start();
    const status = await fetch(`${resumed.url}/status`, { headers: f.headers });
    expect(await status.json()).toMatchObject({ publisherId: "publisher", appMode: "development", authorized: true });
  });

  it("rejects a second process using the same state directory", async () => {
    const f = await fixture();
    await expect(createHarness(f.config)).rejects.toThrow("state_locked");
  });
});
