import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import worker from "./worker.js";
import { D1ThreadStore } from "./thread-db.js";
import { D1PublicationStore } from "./publication-db.js";
import { authorizeManagementCapability } from "./thread-security.js";
import { ThreadPublisher, wakeDue, type RuntimeEnv } from "./thread-publisher.js";
import type { PublishingSecrets } from "./publishing-bindings.js";

const credentials = {
  SPOTIFY_PUBLISHING_ENABLED: "true", SPOTIFY_CLIENT_ID: "client-id", SPOTIFY_CLIENT_SECRET: "client-secret",
  SPOTIFY_REFRESH_TOKEN: "seed-refresh", PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(32)),
};
const playlistId = "P".repeat(22);
const credentialStub = () => env.THREAD_PUBLISHER.getByName("_credentials");

async function configure(stub: DurableObjectStub<ThreadPublisher>, secrets: PublishingSecrets) {
  await runInDurableObject(stub, instance => {
    const object = instance as unknown as { env: RuntimeEnv };
    object.env = { ...object.env, ...secrets };
  });
}

async function setup(provider: "spotify" | "apple" = "spotify") {
  const threads = new D1ThreadStore(env.DB);
  const secret = nanoid(22);
  const view = await threads.create("Drive", secret);
  const auth = (await authorizeManagementCapability(threads, view.publicCapability, secret))!;
  await threads.manage(auth, { kind: "connect", provider, expectedRevision: 0, requestKey: "connect" });
  const [target] = await new D1PublicationStore(env.DB).due(view.publicCapability);
  const stub = env.THREAD_PUBLISHER.getByName(target!.publisherKey);
  return { threads, auth, cap: view.publicCapability, key: target!.publisherKey, stub };
}

beforeEach(async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external request"); }));
  await configure(credentialStub(), credentials);
  await runInDurableObject(credentialStub(), async (_, state) => { await state.storage.deleteAll(); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("persists a wake without provider work and blocks missing credentials when the alarm runs", async () => {
  const f = await setup();
  const ctx = createExecutionContext();
  worker.scheduled(createScheduledController(), env, ctx);
  await waitOnExecutionContext(ctx);
  await runInDurableObject(f.stub, async (_, state) => {
    expect(await state.storage.get("publisherKey")).toBe(f.key);
    expect(await state.storage.getAlarm()).toBeTypeOf("number");
  });
  expect((await f.threads.get(f.cap))!.publications.find(p => p.provider === "spotify")!.status).toBe("pending");
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect((await f.threads.get(f.cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: "blocked", blockedReason: "publisher_not_authorized" });
});

it("rejects destination key mismatches and credential access from playlist objects", async () => {
  const f = await setup();
  await runInDurableObject(f.stub, async instance => {
    await expect((instance as unknown as ThreadPublisher).wake("other-key")).rejects.toThrow("publisher_key_mismatch");
    await expect((instance as unknown as ThreadPublisher).spotifyAccessToken()).rejects.toThrow("credentials_object_required");
  });
  await runInDurableObject(credentialStub(), async instance => {
    await expect((instance as unknown as ThreadPublisher).wake("_credentials")).rejects.toThrow("invalid_publisher_key");
  });
});

it("shares encrypted rotated credentials and a single refresh across concurrent requests", async () => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(String(init?.body)).toContain("refresh_token=seed-refresh");
    return Response.json({ access_token: "access-first", refresh_token: "rotated-refresh", expires_in: 3600 });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await Promise.all([credentialStub().spotifyAccessToken(), credentialStub().spotifyAccessToken()])).toEqual(["access-first", "access-first"]);
  await runInDurableObject(credentialStub(), async (_, state) => {
    const rows = JSON.stringify([...await state.storage.list()]);
    expect(rows).not.toContain("access-first");
    expect(rows).not.toContain("rotated-refresh");
    expect(rows).not.toContain("seed-refresh");
  });
  await runInDurableObject(credentialStub(), async (instance, state) => {
    const object = new ThreadPublisher(state, (instance as unknown as { env: RuntimeEnv }).env);
    expect(await object.spotifyAccessToken()).toBe("access-first");
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("replaces persisted credentials when the provisioned refresh seed changes", async () => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const replacement = String(init?.body).includes("refresh_token=replacement-refresh");
    return Response.json({ access_token: replacement ? "access-second" : "access-first", refresh_token: "rotated-refresh", expires_in: 3600 });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await credentialStub().spotifyAccessToken()).toBe("access-first");
  await configure(credentialStub(), { SPOTIFY_REFRESH_TOKEN: "replacement-refresh" });
  expect(await credentialStub().spotifyAccessToken()).toBe("access-second");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([false, true])("requires Spotify write and readback and schedules edits arriving during publication: %s", async newerRevision => {
  const f = await setup();
  await configure(f.stub, credentials);
  let marker = "";
  let writes = 0;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "accounts.spotify.com") return Response.json({ access_token: "private-access", expires_in: 3600 });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-access");
    if (url.pathname === "/v1/me") return Response.json({ id: "publisher" });
    if (url.pathname === "/v1/me/playlists") {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.name).toBe("Drive");
      marker = body.description;
      return Response.json({ id: playlistId });
    }
    if (url.pathname === `/v1/playlists/${playlistId}`) return Response.json({ owner: { id: "publisher" }, public: true, description: marker, snapshot_id: "1" });
    if (url.pathname === `/v1/playlists/${playlistId}/items`) {
      if (init?.method === "PUT") {
        writes++;
        if (newerRevision && writes === 1) await f.threads.manage(f.auth, { kind: "close", expectedRevision: 1, requestKey: "close" });
        expect(JSON.parse(String(init.body))).toEqual({ uris: [] });
        return Response.json({ snapshot_id: "1" });
      }
      reads++;
      return Response.json({ items: [], total: 0, next: null });
    }
    throw new Error("Unexpected provider request");
  }));
  await wakeDue(env);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect((await f.threads.get(f.cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: newerRevision ? "pending" : "synced", appliedRevision: 1,
    verifiedPlaylistUrl: `https://open.spotify.com/playlist/${playlistId}` });
  expect(writes).toBe(1);
  expect(reads).toBe(2);
  if (newerRevision) {
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect((await f.threads.get(f.cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: "synced", appliedRevision: 2 });
    expect(writes).toBe(2);
  }
  await runInDurableObject(f.stub, async (_, state) => {
    expect(JSON.stringify([...await state.storage.list()])).not.toMatch(/private-access|seed-refresh|client-secret/);
  });
});

it("uses the rotated refresh token after cached access expires", async () => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const rotated = String(init?.body).includes("refresh_token=rotated-refresh");
    return Response.json({ access_token: rotated ? "access-second" : "access-first", refresh_token: "rotated-refresh", expires_in: 3600 });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await credentialStub().spotifyAccessToken()).toBe("access-first");
  vi.mocked(Date.now).mockReturnValue(Date.now() + 3_600_000);
  await runInDurableObject(credentialStub(), async (instance, state) => {
    const object = new ThreadPublisher(state, (instance as unknown as { env: RuntimeEnv }).env);
    expect(await object.spotifyAccessToken()).toBe("access-second");
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("blocks invalid encryption credentials before attempting Spotify refresh", async () => {
  await configure(credentialStub(), { PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(16)) });
  await runInDurableObject(credentialStub(), async instance => {
    await expect((instance as unknown as ThreadPublisher).spotifyAccessToken()).rejects.toMatchObject({ status: 401 });
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("repairs drift after an adapter checkpoint without creating a second Spotify playlist", async () => {
  const f = await setup();
  await configure(f.stub, credentials);
  await runInDurableObject(f.stub, async (_, state) => {
    await state.storage.put(`spotify:${f.key}`, {
      desired: { playlistKey: f.key, title: "Drive", revision: 1, trackIds: [] },
      providerPlaylistId: playlistId, appliedRevision: 1, publisherId: "publisher", marker: "marker",
      createUnresolved: false, retryNotBefore: 0,
    });
  });
  let tracks = [`spotify:track:${"A".repeat(22)}`];
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "accounts.spotify.com") return Response.json({ access_token: "private-access", expires_in: 3600 });
    if (url.pathname === "/v1/me") return Response.json({ id: "publisher" });
    if (url.pathname === `/v1/playlists/${playlistId}`) return Response.json({ owner: { id: "publisher" }, public: true, description: "marker", snapshot_id: "1" });
    if (url.pathname === `/v1/playlists/${playlistId}/items`) {
      if (init?.method === "PUT") {
        tracks = JSON.parse(String(init.body)).uris;
        writes++;
        return Response.json({ snapshot_id: "1" });
      }
      return Response.json({ items: tracks.map(uri => ({ item: { type: "track", uri } })), total: tracks.length, next: null });
    }
    throw new Error("Unexpected provider request");
  }));
  await wakeDue(env, f.cap);
  await runDurableObjectAlarm(f.stub);
  expect((await f.threads.get(f.cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: "failed", failureCode: "readback_invalid", appliedRevision: null });
  expect(writes).toBe(0);
  vi.mocked(Date.now).mockReturnValue(Date.now() + 61_000);
  await runDurableObjectAlarm(f.stub);
  expect((await f.threads.get(f.cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: "synced", appliedRevision: 1 });
  expect(writes).toBe(1);
});

it("publishes Apple only after the provider returns a public URL and exact catalog track readback", async () => {
  const f = await setup("apple");
  await configure(f.stub, { APPLE_PUBLISHING_ENABLED: "true", APPLE_DEVELOPER_TOKEN: "private-developer", APPLE_MUSIC_USER_TOKEN: "private-user" });
  let marker = "";
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    expect(url.hostname).toBe("api.music.apple.com");
    expect(new Headers(init?.headers).get("Music-User-Token")).toBe("private-user");
    if (url.pathname === "/v1/me/library/playlists") {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      marker = body.attributes.description;
      expect(body.relationships.tracks.data).toEqual([]);
      return Response.json({ data: [{ id: "p.destination" }] });
    }
    if (url.pathname === "/v1/me/library/playlists/p.destination") return Response.json({ data: [{ id: "p.destination", attributes: { description: marker, isPublic: true, url: "https://music.apple.com/us/playlist/pl.public" } }] });
    if (url.pathname === "/v1/me/library/playlists/p.destination/tracks") {
      reads++;
      return Response.json({ data: [] });
    }
    throw new Error("Unexpected provider request");
  }));
  await wakeDue(env, f.cap);
  await runDurableObjectAlarm(f.stub);
  expect((await f.threads.get(f.cap))!.publications.find(p => p.provider === "apple")).toMatchObject({ status: "synced", appliedRevision: 1, verifiedPlaylistUrl: "https://music.apple.com/us/playlist/pl.public" });
  expect(reads).toBe(2);
  await runInDurableObject(f.stub, async (_, state) => {
    expect(JSON.stringify([...await state.storage.list()])).not.toMatch(/private-developer|private-user/);
  });
});

it("blocks an invalid Spotify refresh credential across the private RPC boundary", async () => {
  const f = await setup();
  await configure(f.stub, credentials);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })));
  await wakeDue(env, f.cap);
  await runDurableObjectAlarm(f.stub);
  expect((await f.threads.get(f.cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: "blocked", blockedReason: "publisher_not_authorized" });
});
