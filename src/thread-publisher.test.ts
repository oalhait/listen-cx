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
import { D1AccountStore } from "./account-db.js";

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

async function accountFixture(provider: "spotify" | "apple" = "spotify", payload?: unknown) {
  const accountId = crypto.randomUUID();
  const { seal } = await import("./music-auth.js");
  const value = payload ?? { clientId: credentials.SPOTIFY_CLIENT_ID, accountId,
    tokens: { accessToken: "expired-access", refreshToken: "account-refresh", expiresAt: 0 } };
  const encrypted = JSON.stringify(await seal(credentials.PUBLISHER_ENCRYPTION_KEY, `account:${accountId}`, value));
  await env.DB.prepare("INSERT INTO accounts(id, provider, provider_subject, label, encrypted_credentials) VALUES (?, ?, ?, 'Listener', ?)")
    .bind(accountId, provider, accountId, encrypted).run();
  const stub = env.THREAD_PUBLISHER.getByName(`account_${accountId}`);
  await configure(stub, credentials);
  return { accountId, stub };
}

async function matchingThread(sourceProvider: "spotify" | "apple") {
  const threads = new D1ThreadStore(env.DB);
  const view = await threads.create("Automatic matching", nanoid(22));
  const sourceId = sourceProvider === "apple" ? "123456" : "S".repeat(22);
  await threads.add(view.publicCapability, {
    expectedRevision: 0, requestKey: "source-song",
    source: { provider: sourceProvider, id: sourceId, storefront: "us" },
    track: { title: "Song", artist: "Artist", isrc: null, artworkUrl: null, complete: false,
      spotifyUrl: sourceProvider === "spotify" ? `https://open.spotify.com/track/${sourceId}` : null,
      appleUrl: sourceProvider === "apple" ? `https://music.apple.com/us/song/${sourceId}` : null },
  });
  return { threads, cap: view.publicCapability, sourceId };
}

it.each([true, false])("matches an Apple source with the Spotify subscriber token and requires exact final readback: %s", async exactReadback => {
  const f = await matchingThread("apple");
  const account = await accountFixture();
  const unrelated = await accountFixture();
  await unrelated.stub.setAccountCredentials(unrelated.accountId, "invalid-unrelated-credentials");
  const accounts = new D1AccountStore(env.DB);
  const subscription = await accounts.subscribe(account.accountId, f.cap);
  const destination = env.THREAD_PUBLISHER.getByName(subscription.publisherKey);
  await configure(destination, { ...credentials, APPLE_DEVELOPER_TOKEN: "catalog-developer" });
  const selectedId = "M".repeat(22);
  let marker = "";
  let reads = 0;
  let searches = 0;
  let writes = 0;
  let refreshes = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    if (url.hostname === "accounts.spotify.com") {
      expect(String(init?.body)).toContain("refresh_token=account-refresh");
      refreshes++;
      return Response.json({ token_type: "Bearer", access_token: "listener-spotify", expires_in: 3600 });
    }
    if (url.hostname === "api.music.apple.com") {
      expect(url.pathname).toBe(`/v1/catalog/us/songs/${f.sourceId}`);
      expect(headers.get("Authorization")).toBe("Bearer catalog-developer");
      return Response.json({ data: [{ id: f.sourceId, type: "songs", attributes: {
        name: "Song", artistName: "Artist", durationInMillis: 180000, isrc: "USABC2600001", contentRating: "clean",
        playParams: { id: f.sourceId, kind: "song" },
      } }] });
    }
    expect(url.hostname).toBe("api.spotify.com");
    expect(headers.get("Authorization")).toBe("Bearer listener-spotify");
    if (url.pathname === "/v1/search") {
      searches++;
      expect(url.searchParams.get("q")).toBe("isrc:USABC2600001");
      expect(url.searchParams.get("market")).toBe("US");
      return Response.json({ tracks: { items: [{ id: selectedId, type: "track", name: "Song", artists: [{ name: "Artist" }],
        duration_ms: 180000, explicit: false, is_playable: true, external_ids: { isrc: "USABC2600001" } }] } });
    }
    if (url.pathname === "/v1/me") return Response.json({ id: account.accountId });
    if (url.pathname === "/v1/me/playlists") {
      marker = JSON.parse(String(init?.body)).description;
      return Response.json({ id: playlistId });
    }
    if (url.pathname === `/v1/playlists/${playlistId}`) {
      return Response.json({ owner: { id: account.accountId }, public: true, description: marker, snapshot_id: "1" });
    }
    if (url.pathname === `/v1/playlists/${playlistId}/items`) {
      expect(await accounts.subscription(account.accountId, f.cap)).toMatchObject({ status: "pending", appliedRevision: null });
      if (init?.method === "PUT") {
        writes++;
        expect(JSON.parse(String(init.body))).toEqual({ uris: [`spotify:track:${selectedId}`] });
        return Response.json({ snapshot_id: "1" });
      }
      reads++;
      const actualId = exactReadback || reads === 1 ? selectedId : "W".repeat(22);
      return Response.json({ items: [{ item: { type: "track", uri: `spotify:track:${actualId}` } }], total: 1, next: null });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }));
  await destination.wake(subscription.publisherKey);
  expect(await runDurableObjectAlarm(destination)).toBe(true);
  expect(await accounts.subscription(account.accountId, f.cap)).toMatchObject(exactReadback
    ? { status: "synced", appliedRevision: 1, verifiedPlaylistId: playlistId }
    : { status: "failed", appliedRevision: null, failureCode: "readback_invalid", verifiedPlaylistId: null });
  expect({ refreshes, searches, writes, reads }).toEqual({ refreshes: 1, searches: 1, writes: 1, reads: 2 });
  const evidence = await env.DB.prepare("SELECT provider, storefront, status, result_json FROM automatic_track_matches WHERE publisher_key = ?")
    .bind(subscription.publisherKey).first<{ provider: string; storefront: string; status: string; result_json: string }>();
  expect(evidence).toMatchObject({ provider: "spotify", storefront: "us", status: "matched" });
  expect(JSON.parse(evidence!.result_json)).toMatchObject({ method: "isrc", selected: { id: selectedId, provider: "spotify" } });
  expect((await f.threads.get(f.cap))!.contributions[0]!.source.id).toBe(f.sourceId);
  expect((await accounts.account(unrelated.accountId))!.credentials).toBe("invalid-unrelated-credentials");
});

it.each(["none", "valid", "revoked", "source401", "source403", "source429"] as const)("resolves Spotify sources or backs off for an Apple subscriber using their account group and stored storefront: Spotify %s", async spotifyState => {
  const linkedSpotify = spotifyState !== "none";
  const sourceIsrc = spotifyState === "valid";
  const f = await matchingThread("spotify");
  const accounts = new D1AccountStore(env.DB);
  const account = await accountFixture("apple", { teamId: "TEAM123456", musicUserToken: "apple-listener", storefront: "us" });
  const unrelated = await accountFixture();
  await unrelated.stub.setAccountCredentials(unrelated.accountId, "invalid-unrelated-credentials");
  if (linkedSpotify) {
    const spotify = await accountFixture();
    const sessionHash = crypto.randomUUID();
    await accounts.createSession(account.accountId, sessionHash, Date.now() + 60000);
    expect(await accounts.linkAccounts(account.accountId, spotify.accountId, sessionHash)).toBe(true);
  }
  const subscription = await accounts.subscribe(account.accountId, f.cap);
  const destination = env.THREAD_PUBLISHER.getByName(subscription.publisherKey);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const encoded = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))));
  const secrets = { ...credentials, APPLE_PUBLISHING_ENABLED: "true", APPLE_MUSIC_KEY_ID: "KEY1234567", APPLE_MUSIC_TEAM_ID: "TEAM123456",
    APPLE_MUSIC_PRIVATE_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` };
  await configure(account.stub, secrets);
  await configure(destination, secrets);
  const selectedId = "987654";
  let marker = "";
  let searches = 0;
  let reads = 0;
  let creates = 0;
  let publicReads = 0;
  let authenticatedSourceReads = 0;
  let refreshes = 0;
  let preflights = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    if (url.hostname === "accounts.spotify.com") {
      expect(linkedSpotify).toBe(true);
      expect(String(init?.body)).toContain("refresh_token=account-refresh");
      refreshes++;
      if (spotifyState === "revoked") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ token_type: "Bearer", access_token: "linked-listener", expires_in: 3600 });
    }
    if (url.hostname === "api.spotify.com") {
      expect(linkedSpotify).toBe(true);
      expect(headers.get("Authorization")).toBe("Bearer linked-listener");
      expect(url.pathname).toBe(`/v1/tracks/${f.sourceId}`);
      authenticatedSourceReads++;
      if (spotifyState.startsWith("source")) return Response.json({ error: "source denied" }, { status: Number(spotifyState.slice(6)), headers: { "Retry-After": "120" } });
      return Response.json({ id: f.sourceId, type: "track", name: "Song", artists: [{ name: "Artist" }],
        duration_ms: 180000, explicit: true, is_playable: true, external_ids: { isrc: "USABC2600001" } });
    }
    if (url.hostname === "open.spotify.com") {
      expect(sourceIsrc).toBe(false);
      expect(headers.get("Authorization")).toBeNull();
      publicReads++;
      if (url.pathname === "/oembed") return Response.json({ title: "Unreliable oEmbed title" });
      if (url.pathname === `/track/${f.sourceId}`) return new Response(`<meta property="og:url" content="https://open.spotify.com/track/${f.sourceId}"><meta property="og:description" content="Artist · Album · Song · 2026"><meta name="music:release_date" content="2026-01-01">`);
      expect(url.pathname).toBe(`/embed/track/${f.sourceId}`);
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: {
        id: f.sourceId, type: "track", title: "Song", artists: [{ name: "Artist" }], duration: 180000, isExplicit: true, isPlayable: true,
      } } } } } })}</script>`);
    }
    expect(url.hostname).toBe("api.music.apple.com");
    expect(headers.get("Authorization")).toMatch(/^Bearer ey[\w-]+\.[\w-]+\.[\w-]+$/);
    if (url.pathname.startsWith("/v1/catalog/")) {
      expect(headers.get("Music-User-Token")).toBeNull();
      expect(url.pathname).toBe(`/v1/catalog/gb/${sourceIsrc ? "songs" : "search"}`);
      expect(url.searchParams.get(sourceIsrc ? "filter[isrc]" : "term")).toBe(sourceIsrc ? "USABC2600001" : "Song Artist");
      searches++;
      const song = { id: selectedId, type: "songs", attributes: { name: "Song", artistName: "Artist", durationInMillis: 180000,
        contentRating: "explicit", isrc: "USABC2600001", playParams: { id: selectedId, kind: "song" } } };
      return Response.json(sourceIsrc ? { data: [song] } : { results: { songs: { data: [song] } } });
    }
    expect(headers.get("Music-User-Token")).toBe("apple-listener");
    if (url.pathname === "/v1/me/storefront") {
      preflights++;
      return Response.json({ data: [{ id: "gb" }] });
    }
    if (url.pathname === "/v1/me/library/playlists") {
      creates++;
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      marker = body.attributes.description;
      expect(body.relationships.tracks.data).toEqual([{ id: selectedId, type: "songs" }]);
      return Response.json({ data: [{ id: "p.matched" }] });
    }
    if (url.pathname === "/v1/me/library/playlists/p.matched") {
      return Response.json({ data: [{ id: "p.matched", attributes: { description: marker, isPublic: true, url: "https://music.apple.com/gb/playlist/pl.matched" } }] });
    }
    if (url.pathname === "/v1/me/library/playlists/p.matched/tracks") {
      expect(await accounts.subscription(account.accountId, f.cap)).toMatchObject({ status: "pending", appliedRevision: null });
      reads++;
      return Response.json({ data: [{ id: "i.library-song", type: "library-songs", attributes: { playParams: { catalogId: selectedId } } }] });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }));
  await account.stub.authorizeAccountApple(account.accountId, "apple-listener");
  await destination.wake(subscription.publisherKey);
  expect(await runDurableObjectAlarm(destination)).toBe(true);
  if (spotifyState === "source429") {
    expect(await accounts.subscription(account.accountId, f.cap)).toMatchObject({ status: "failed", failureCode: "rate_limited",
      appliedRevision: null, nextAttemptAt: Date.now() + 120000 });
    expect({ searches, creates, reads, publicReads }).toEqual({ searches: 0, creates: 0, reads: 0, publicReads: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM automatic_track_matches WHERE publisher_key = ?")
      .bind(subscription.publisherKey).first<number>("count")).toBe(0);
    return;
  }
  expect(await accounts.subscription(account.accountId, f.cap)).toMatchObject({ status: "synced", appliedRevision: 1,
    verifiedPlaylistId: "p.matched", verifiedPlaylistUrl: "https://music.apple.com/gb/playlist/pl.matched" });
  expect({ searches, creates, reads, preflights, publicReads, authenticatedSourceReads, refreshes }).toEqual({ searches: 1, creates: 1, reads: 2,
    preflights: 1, publicReads: sourceIsrc ? 0 : 3, authenticatedSourceReads: linkedSpotify && spotifyState !== "revoked" ? 1 : 0, refreshes: linkedSpotify ? 1 : 0 });
  const evidence = await env.DB.prepare("SELECT storefront, status, result_json FROM automatic_track_matches WHERE publisher_key = ?")
    .bind(subscription.publisherKey).first<{ storefront: string; status: string; result_json: string }>();
  expect(evidence).toMatchObject({ storefront: "gb", status: "matched" });
  expect(JSON.parse(evidence!.result_json)).toMatchObject({ method: sourceIsrc ? "isrc" : "metadata", selected: { provider: "apple", id: selectedId, explicit: true } });
  expect((await accounts.account(unrelated.accountId))!.credentials).toBe("invalid-unrelated-credentials");
  await runInDurableObject(destination, async (_, state) => {
    expect(await state.storage.get(`apple:${subscription.publisherKey}`)).toMatchObject({ appliedRevision: 1, appliedTrackIds: [selectedId], intent: null,
      verifiedUrl: "https://music.apple.com/gb/playlist/pl.matched" });
  });
});

it("serializes account refreshes across subscriptions and persists rotated encrypted tokens", async () => {
  const { accountId, stub } = await accountFixture();
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const refreshed = String(init?.body).includes("refresh_token=account-rotated");
    return Response.json({ token_type: "Bearer", access_token: refreshed ? "account-second" : "account-first", refresh_token: "account-rotated", expires_in: 3600 });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await Promise.all([stub.getAccountSpotifyToken(accountId), stub.getAccountSpotifyToken(accountId)]))
    .toEqual(["account-first", "account-first"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const row = await env.DB.prepare("SELECT encrypted_credentials FROM accounts WHERE id = ?").bind(accountId).first();
  expect(JSON.stringify(row)).not.toMatch(/account-first|account-rotated|account-refresh/);
  vi.mocked(Date.now).mockReturnValue(Date.now() + 3_600_000);
  await runInDurableObject(stub, async (instance, state) => {
    const object = new ThreadPublisher(state, (instance as unknown as { env: RuntimeEnv }).env);
    expect(await object.getAccountSpotifyToken(accountId)).toBe("account-second");
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("keeps reauthorization ordered after an in-flight account refresh", async () => {
  const { accountId, stub } = await accountFixture();
  const { seal } = await import("./music-auth.js");
  const replacement = JSON.stringify(await seal(credentials.PUBLISHER_ENCRYPTION_KEY, `account:${accountId}`, {
    clientId: credentials.SPOTIFY_CLIENT_ID, accountId,
    tokens: { accessToken: "reauthorized-access", refreshToken: "reauthorized-refresh", expiresAt: Date.now() + 3_600_000 },
  }));
  await runInDurableObject(stub, async instance => {
    const object = instance as unknown as ThreadPublisher;
    let finish!: () => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      started();
      await gate;
      return Response.json({ token_type: "Bearer", access_token: "refresh-access", refresh_token: "refresh-rotated", expires_in: 3600 });
    }));
    const refreshing = object.getAccountSpotifyToken(accountId);
    await start;
    const saving = object.setAccountCredentials(accountId, replacement);
    finish();
    await Promise.all([refreshing, saving]);
    expect(await object.getAccountSpotifyToken(accountId)).toBe("reauthorized-access");
  });
});

it("rejects account credential access from another object and never falls back to legacy credentials", async () => {
  const { accountId, stub } = await accountFixture("apple", { teamId: "TEAM", musicUserToken: "user", storefront: "us" });
  await runInDurableObject(stub, async instance => {
    const object = instance as unknown as ThreadPublisher;
    await expect(object.getAccountSpotifyToken("other")).rejects.toThrow("account_object_required");
    await expect(object.setAccountCredentials("other", "{}")).rejects.toThrow("account_object_required");
    await expect(object.getAccountAppleCredentials("other")).rejects.toThrow("account_object_required");
    await expect(object.getAccountSpotifyToken(accountId)).rejects.toMatchObject({ status: 401 });
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("publishes separate subscriber destinations with only their own account tokens", async () => {
  const f = await setup();
  const first = await accountFixture();
  const second = await accountFixture();
  const { seal } = await import("./music-auth.js");
  const destinations = new Map<string, { accountId: string; playlistId: string; marker: string }>();
  const keys: string[] = [];
  for (const [index, account] of [first, second].entries()) {
    const accessToken = `subscriber-${index}`;
    destinations.set(accessToken, { accountId: account.accountId, playlistId: String(index).repeat(22), marker: "" });
    await account.stub.setAccountCredentials(account.accountId, JSON.stringify(await seal(credentials.PUBLISHER_ENCRYPTION_KEY, `account:${account.accountId}`, {
      clientId: credentials.SPOTIFY_CLIENT_ID, accountId: account.accountId,
      tokens: { accessToken, refreshToken: "private-refresh", expiresAt: Date.now() + 3_600_000 },
    })));
    const publisherKey = crypto.randomUUID();
    keys.push(publisherKey);
    await env.DB.prepare(`INSERT INTO thread_subscriptions(account_id, thread_id, provider, publisher_key, requested_revision)
      SELECT ?, id, 'spotify', ?, revision FROM threads WHERE public_capability = ?`).bind(account.accountId, publisherKey, f.cap).run();
  }
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const token = new Headers(init?.headers).get("Authorization")!.replace("Bearer ", "");
    const destination = destinations.get(token)!;
    expect(destination).toBeDefined();
    expect(url.hostname).toBe("api.spotify.com");
    if (url.pathname === "/v1/me") return Response.json({ id: destination.accountId });
    if (url.pathname === "/v1/me/playlists") {
      destination.marker = JSON.parse(String(init?.body)).description;
      return Response.json({ id: destination.playlistId });
    }
    if (url.pathname === `/v1/playlists/${destination.playlistId}`) {
      return Response.json({ owner: { id: destination.accountId }, public: true, description: destination.marker, snapshot_id: "1" });
    }
    if (url.pathname === `/v1/playlists/${destination.playlistId}/items`) {
      return init?.method === "PUT" ? Response.json({ snapshot_id: "1" }) : Response.json({ items: [], total: 0, next: null });
    }
    throw new Error("Unexpected provider request");
  });
  vi.stubGlobal("fetch", fetcher);
  for (const key of keys) {
    const stub = env.THREAD_PUBLISHER.getByName(key);
    await configure(stub, credentials);
    await stub.wake(key);
    await runDurableObjectAlarm(stub);
  }
  const rows = await env.DB.prepare("SELECT account_id, status, verified_playlist_id FROM thread_subscriptions WHERE account_id IN (?, ?) ORDER BY verified_playlist_id")
    .bind(first.accountId, second.accountId).all();
  expect(rows.results).toEqual([
    { account_id: first.accountId, status: "synced", verified_playlist_id: "0".repeat(22) },
    { account_id: second.accountId, status: "synced", verified_playlist_id: "1".repeat(22) },
  ]);
  expect(destinations.get("subscriber-0")!.marker).not.toBe(destinations.get("subscriber-1")!.marker);
  expect(fetcher).toHaveBeenCalled();
  expect((await new D1PublicationStore(env.DB).target(f.key))!.status).toBe("pending");
});

it("checks the Apple subscription journal before replacing authorization", async () => {
  const threads = new D1ThreadStore(env.DB);
  const view = await threads.create("Apple listener", nanoid(22));
  const { accountId } = await accountFixture("apple", { teamId: "TEAM123456", musicUserToken: "old-user", storefront: "us" });
  const { D1AccountStore } = await import("./account-db.js");
  const subscription = await new D1AccountStore(env.DB).subscribe(accountId, view.publicCapability);
  await new D1AccountStore(env.DB).unsubscribe(accountId, view.publicCapability);
  const stub = env.THREAD_PUBLISHER.getByName(subscription.publisherKey);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const encoded = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))));
  await configure(stub, { APPLE_MUSIC_KEY_ID: "KEY1234567", APPLE_MUSIC_TEAM_ID: "TEAM123456", APPLE_MUSIC_PRIVATE_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` });
  await runInDurableObject(stub, async (instance, state) => {
    const object = instance as unknown as ThreadPublisher;
    await state.storage.put(`apple:${subscription.publisherKey}`, { intent: { kind: "create" }, providerPlaylistId: null });
    await expect(object.validateAccountAppleToken(subscription.publisherKey, "replacement")).rejects.toThrow("create_unresolved");
    expect(fetch).not.toHaveBeenCalled();
    await state.storage.put(`apple:${subscription.publisherKey}`, { providerPlaylistId: "p.unverified" });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Music-User-Token")).toBe("replacement");
      if (input.endsWith("/storefront")) return Response.json({ data: [{ id: "us" }] });
      expect(input).toBe("https://api.music.apple.com/v1/me/library/playlists/p.unverified");
      return Response.json({ data: [{ id: "p.unverified", attributes: { canEdit: false } }] });
    }));
    await expect(object.validateAccountAppleToken(subscription.publisherKey, "replacement")).rejects.toMatchObject({ code: "destination_mismatch" });
  });
});

it("finishes an Apple creation before validating replacement authorization against its new destination", async () => {
  const { D1AccountStore } = await import("./account-db.js");
  const accounts = new D1AccountStore(env.DB);
  const view = await new D1ThreadStore(env.DB).create("Apple race", nanoid(22));
  const { accountId, stub } = await accountFixture("apple", { teamId: "TEAM123456", musicUserToken: "original-user", storefront: "us" });
  const subscription = await accounts.subscribe(accountId, view.publicCapability);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const encoded = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))));
  const appleSecrets = { APPLE_PUBLISHING_ENABLED: "true", APPLE_MUSIC_KEY_ID: "KEY1234567", APPLE_MUSIC_TEAM_ID: "TEAM123456", APPLE_MUSIC_PRIVATE_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` };
  await configure(stub, appleSecrets);
  await configure(env.THREAD_PUBLISHER.getByName(subscription.publisherKey), appleSecrets);
  let marker = "";
  const events: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const token = new Headers(init?.headers).get("Music-User-Token");
    if (path.endsWith("/storefront")) return Response.json({ data: [{ id: "us" }] });
    if (path === "/v1/me/library/playlists") {
      expect(token).toBe("original-user");
      marker = JSON.parse(String(init?.body)).attributes.description;
      events.push("create-started");
      await new Promise(resolve => setTimeout(resolve, 10));
      events.push("create-finished");
      return Response.json({ data: [{ id: "p.raced" }] });
    }
    if (path === "/v1/me/library/playlists/p.raced") {
      if (token === "replacement-user") {
        events.push("replacement-checked");
        return Response.json({ data: [{ id: "p.raced", attributes: { canEdit: false } }] });
      }
      return Response.json({ data: [{ id: "p.raced", attributes: { description: marker, isPublic: true, url: "https://music.apple.com/us/playlist/pl.raced" } }] });
    }
    if (path === "/v1/me/library/playlists/p.raced/tracks") return Response.json({ data: [] });
    throw new Error("Unexpected Apple request");
  }));
  await runInDurableObject(stub, async instance => {
    const object = instance as unknown as ThreadPublisher;
    const publishing = object.publishAppleSubscription(accountId, subscription.publisherKey);
    const authorizing = object.authorizeAccountApple(accountId, "replacement-user");
    const results = await Promise.allSettled([publishing, authorizing]);
    expect(results[0]).toEqual({ status: "fulfilled", value: null });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { message: "destination_mismatch" } });
    expect((await object.getAccountAppleCredentials(accountId)).musicUserToken).toBe("original-user");
  });
  expect(events).toEqual(["create-started", "create-finished", "replacement-checked"]);
  expect(await accounts.subscription(accountId, view.publicCapability)).toMatchObject({ status: "synced", verifiedPlaylistId: "p.raced" });
});

it("publishes Apple subscriptions through the account queue after replacing credentials", async () => {
  const { D1AccountStore } = await import("./account-db.js");
  const accounts = new D1AccountStore(env.DB);
  const threads = new D1ThreadStore(env.DB);
  const view = await threads.create("Apple account alarm", nanoid(22));
  const { accountId, stub } = await accountFixture("apple", { teamId: "TEAM123456", musicUserToken: "original-user", storefront: "us" });
  const subscription = await accounts.subscribe(accountId, view.publicCapability);
  const destination = env.THREAD_PUBLISHER.getByName(subscription.publisherKey);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const encoded = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))));
  const appleSecrets = { APPLE_PUBLISHING_ENABLED: "true", APPLE_MUSIC_KEY_ID: "KEY1234567", APPLE_MUSIC_TEAM_ID: "TEAM123456", APPLE_MUSIC_PRIVATE_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` };
  await configure(stub, appleSecrets);
  await configure(destination, appleSecrets);
  let marker = "";
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Music-User-Token")).toBe("replacement-user");
    const path = new URL(input).pathname;
    if (path.endsWith("/storefront")) return Response.json({ data: [{ id: "us" }] });
    if (path === "/v1/me/library/playlists") {
      marker = JSON.parse(String(init?.body)).attributes.description;
      return Response.json({ data: [{ id: "p.account" }] });
    }
    if (path === "/v1/me/library/playlists/p.account") return Response.json({ data: [{ id: "p.account", attributes: { description: marker, isPublic: true, url: "https://music.apple.com/us/playlist/pl.account" } }] });
    if (path === "/v1/me/library/playlists/p.account/tracks") return Response.json({ data: [] });
    throw new Error("Unexpected Apple request");
  }));
  await stub.authorizeAccountApple(accountId, "replacement-user");
  expect((await accounts.account(accountId))!.credentials).not.toMatch(/replacement-user|original-user/);
  await destination.wake(subscription.publisherKey);
  expect(await runDurableObjectAlarm(destination)).toBe(true);
  expect(await accounts.subscription(accountId, view.publicCapability)).toMatchObject({ status: "synced", verifiedPlaylistId: "p.account" });
  await runInDurableObject(destination, async instance => {
    await expect((instance as unknown as ThreadPublisher).runAppleSubscription(subscription.publisherKey, "other-account", { developerToken: "private", musicUserToken: "private" })).rejects.toMatchObject({ status: 401 });
  });
  await runInDurableObject(stub, async instance => {
    const object = instance as unknown as ThreadPublisher;
    await expect(object.authorizeAccountApple("other-account", "private")).rejects.toThrow("account_object_required");
    await expect(object.publishAppleSubscription("other-account", subscription.publisherKey)).rejects.toThrow("account_object_required");
  });
});
