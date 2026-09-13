import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadPublisher, RuntimeEnv } from "./thread-publisher.js";
import { D1ThreadStore } from "./thread-db.js";
import { authorizeManagementCapability } from "./thread-security.js";
import { connectionTarget } from "./music-connections-app.js";
import { MusicConnectionStore } from "./music-connection-store.js";

afterEach(() => vi.restoreAllMocks());

async function destination(key: string = crypto.randomUUID()) {
  const stub = env.THREAD_PUBLISHER.getByName(key);
  await runInDurableObject(stub, instance => {
    Object.assign((instance as unknown as { env: RuntimeEnv }).env, {
      SPOTIFY_PUBLISHING_ENABLED: "true", SPOTIFY_CLIENT_ID: "test-client",
      MUSIC_ACCOUNT_CONNECTIONS_ENABLED: "true",
      PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(32)),
    });
  });
  return { key, stub };
}

it("keeps account authorization private to its destination and binds OAuth to the initiating browser", async () => {
  const { key, stub } = await destination();
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const result = await stub.beginSpotifyConnection(key, "a".repeat(22), "browser-hash", "https://staging.listen.cx/connections/spotify/callback");
  expect(new URL(result.url).hostname).toBe("accounts.spotify.com");
  expect(new URL(result.url).searchParams.get("state")).not.toContain(key);
  await expect((async () => await stub.finishSpotifyConnection(key, result.nonce, "another-browser", "code"))()).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
  expect(await stub.connectionStatus(key, "spotify")).toMatchObject({ authorized: false });
  await expect((async () => await stub.connectionStatus("different-key", "spotify"))()).rejects.toThrow();
});

it("stores encrypted per-Thread tokens, consumes OAuth once, and refuses a different Spotify account", async () => {
  const { key, stub } = await destination();
  let account = "owner-one";
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("api/token")
    ? Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, token_type: "Bearer", scope: "playlist-modify-public" })
    : Response.json({ id: account, display_name: "Owner" }));
  const start = () => stub.beginSpotifyConnection(key, "a".repeat(22), "browser-hash", "https://staging.listen.cx/connections/spotify/callback");
  const first = await start();
  await stub.finishSpotifyConnection(key, first.nonce, "browser-hash", "code");
  expect(await stub.connectionStatus(key, "spotify")).toMatchObject({ authorized: true, accountLabel: "Owner" });
  await expect((async () => await stub.finishSpotifyConnection(key, first.nonce, "browser-hash", "code"))()).rejects.toThrow();
  await runInDurableObject(stub, async (_, state) => {
    const stored = JSON.stringify([...await state.storage.list()]);
    expect(stored).not.toContain("private-access");
    expect(stored).not.toContain("private-refresh");
  });
  account = "owner-two";
  const second = await start();
  await expect((async () => await stub.finishSpotifyConnection(key, second.nonce, "browser-hash", "new-code"))()).rejects.toThrow();
  const other = await destination();
  expect(await other.stub.connectionStatus(other.key, "spotify")).toMatchObject({ authorized: false });
});

it("rotates a personal Spotify refresh token durably without reading shared publisher credentials", async () => {
  const { key, stub } = await destination();
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("api/token")
    ? Response.json({ access_token: "first-access", refresh_token: "first-refresh", expires_in: 3600, token_type: "Bearer" })
    : Response.json({ id: "owner" }));
  const first = await stub.beginSpotifyConnection(key, "a".repeat(22), "browser", "https://staging.listen.cx/connections/spotify/callback");
  await stub.finishSpotifyConnection(key, first.nonce, "browser", "code");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
  const refresh = vi.mocked(fetch).mockImplementation(async (_, init) => {
    expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("first-refresh");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    return Response.json({ access_token: "second-access", refresh_token: "second-refresh", expires_in: 3600, token_type: "Bearer" });
  });
  refresh.mockClear();
  await runInDurableObject(stub, async (instance, state) => {
    const config = (instance as unknown as { env: RuntimeEnv }).env;
    const store = new MusicConnectionStore(state.storage, config, key);
    expect(await Promise.all([store.spotifyAccessToken(), store.spotifyAccessToken()])).toEqual(["second-access", "second-access"]);
    expect(await new MusicConnectionStore(state.storage, config, key).spotifyAccessToken()).toBe("second-access");
    expect(JSON.stringify([...await state.storage.list()])).not.toMatch(/second-access|second-refresh/);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("checks Apple backend access, recovers a rejected first creation, then appends with the saved personal account", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const p8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey))));
  const threads = new D1ThreadStore(env.DB);
  const secret = "a".repeat(22);
  const thread = await threads.create("Apple connection test", secret);
  const key = await connectionTarget(env, thread.publicCapability, "apple");
  const { stub } = await destination(key);
  await runInDurableObject(stub, instance => {
    Object.assign((instance as unknown as { env: RuntimeEnv }).env, {
      APPLE_PUBLISHING_ENABLED: "true", APPLE_MUSIC_KEY_ID: "KEY1234567", APPLE_MUSIC_TEAM_ID: "TEAM123456",
      APPLE_MUSIC_PRIVATE_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${p8}\n-----END PRIVATE KEY-----`,
      APPLE_MUSIC_USER_TOKEN: "must-not-use-shared-token",
    });
  });
  let rejectCreate = true;
  let marker = "";
  let tracks: string[] = [];
  const writes: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe("api.music.apple.com");
    expect(new Headers(init?.headers).get("Music-User-Token")).toMatch(/^personal-apple-/);
    if (url.pathname === "/v1/me/storefront") return Response.json({ data: [{ id: "us" }] });
    if (url.pathname === "/v1/me/library/playlists" && init?.method === "POST") {
      writes.push("create");
      if (rejectCreate) return Response.json({ error: "expired" }, { status: 401 });
      marker = JSON.parse(String(init.body)).attributes.description;
      return Response.json({ data: [{ id: "p.personal" }] });
    }
    if (url.pathname === "/v1/me/library/playlists/p.personal") return Response.json({ data: [{ id: "p.personal", attributes: { description: marker, isPublic: true, canEdit: true, url: "https://music.apple.com/us/playlist/pl.personal" } }] });
    if (url.pathname === "/v1/me/library/playlists/p.personal/tracks") {
      if (init?.method === "POST") {
        writes.push("append");
        tracks.push(...JSON.parse(String(init.body)).data.map((song: { id: string }) => song.id));
        return new Response(null, { status: 204 });
      }
      return Response.json({ data: tracks.map(id => ({ attributes: { playParams: { catalogId: id } } })) });
    }
    throw new Error("Unexpected Apple request");
  });
  await stub.authorizeAppleConnection(key, "personal-apple-initial");
  expect(writes).toEqual([]);
  const auth = (await authorizeManagementCapability(threads, thread.publicCapability, secret))!;
  await threads.manage(auth, { kind: "connect", provider: "apple", expectedRevision: 0, requestKey: "connect" });
  await stub.wake(key);
  await runDurableObjectAlarm(stub);
  expect((await threads.get(thread.publicCapability))!.publications.find(p => p.provider === "apple")!.blockedReason).toBe("publisher_not_authorized");
  await stub.authorizeAppleConnection(key, "personal-apple-reconnected");
  rejectCreate = false;
  await env.DB.prepare("UPDATE thread_publications SET status = 'pending', blocked_reason = NULL WHERE publisher_key = ?").bind(key).run();
  await stub.wake(key);
  await runDurableObjectAlarm(stub);
  expect((await threads.get(thread.publicCapability))!.publications.find(p => p.provider === "apple")!.status).toBe("synced");
  await threads.add(thread.publicCapability, { expectedRevision: 1, requestKey: "add", source: { provider: "apple", id: "704790294", storefront: "us" },
    track: { title: "Sunset", artist: "The Internet", appleUrl: "https://music.apple.com/us/album/sunset/704790269?i=704790294", spotifyUrl: null, artworkUrl: null, isrc: null, complete: false } });
  await stub.wake(key);
  await runDurableObjectAlarm(stub);
  expect((await threads.get(thread.publicCapability))!.publications.find(p => p.provider === "apple")).toMatchObject({ status: "synced", appliedRevision: 2, verifiedPlaylistId: "p.personal" });
  expect(writes).toEqual(["create", "create", "append"]);
  await runInDurableObject(stub, async (_, state) => {
    expect(JSON.stringify([...await state.storage.list()])).not.toContain("personal-apple-");
  });
});
