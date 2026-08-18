import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { D1LinkStore } from "./db.js";
import type { Resolved } from "./resolve.js";
import { fingerprintContributionInput, type ThreadEvent } from "./thread.js";
import { D1ThreadStore } from "./thread-db.js";
import {
  MANAGEMENT_ACTION_HEADER,
  MANAGEMENT_ACTION_VALUE,
  PUBLIC_ACTION_HEADER,
  allowAllAttemptLimiter,
  authorizeManagementCapability,
  fixedAttemptLimiter,
} from "./thread-security.js";

const BASE_URL = "https://x.link";
const TRACK_URL = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";
const OTHER_TRACK_URL = "https://open.spotify.com/track/5uLU6hMCjMI75M1A2tKUQC";
const RESOLVED: Resolved = {
  isrc: "USSM11804580",
  title: "Kingston",
  artist: "Faye Webster",
  artworkUrl: "https://img.example/kingston.jpg",
  spotifyUrl: TRACK_URL,
  appleUrl: "https://music.apple.com/us/album/kingston/1443108737?i=1443109064",
  complete: true,
};

type AppOptions = {
  maxThreads?: number;
  maxContributionsPerThread?: number;
  threadsEnabled?: boolean;
  resolve?: (url: string) => Promise<Resolved | null>;
  creationAllowed?: boolean;
  contributionAllowed?: boolean;
  appleMusic?: {
    getDeveloperToken(): Promise<string>;
    createThreadPlaylist(
      userToken: string,
      threadTitle: string,
      trackIds: readonly string[],
    ): Promise<{
      id: string;
      playlistId: string;
      playlistUrl?: string;
      url: string | null;
      addedCount: number;
    }>;
  };
};

function makeApp(options: AppOptions = {}) {
  const linkStore = new D1LinkStore(env.DB);
  const threadStore = new D1ThreadStore(env.DB, {
    maxThreads: options.maxThreads ?? 10_000,
    maxContributionsPerThread: options.maxContributionsPerThread,
  });
  const resolve = vi.fn(options.resolve ?? (async () => RESOLVED));
  const creation = options.creationAllowed === false
    ? fixedAttemptLimiter({ allowed: false, retryAfterSeconds: 60 })
    : allowAllAttemptLimiter();
  const contribution = options.contributionAllowed === false
    ? fixedAttemptLimiter({ allowed: false, retryAfterSeconds: 60 })
    : allowAllAttemptLimiter();
  const events: ThreadEvent[] = [];
  const app = createApp({
    resolver: { resolve },
    store: linkStore,
    threadStore,
    threadLimiters: { creation, contribution },
    threadEvents: { emit: (event) => events.push(event) },
    appleMusic: options.appleMusic,
    threadsEnabled: options.threadsEnabled,
    baseUrl: BASE_URL,
  });
  return { app, events, linkStore, threadStore, resolve };
}

function publicMutationHeaders(action: "create-thread" | "add-song" | "thread-event" | "apple-music-spike") {
  return {
    "content-type": "application/json",
    origin: BASE_URL,
    [PUBLIC_ACTION_HEADER]: action,
  };
}

async function createThread(app: ReturnType<typeof makeApp>["app"], title = "Friday night") {
  const response = await app.request("/api/threads", {
    method: "POST",
    headers: {
      ...publicMutationHeaders("create-thread"),
      "cf-connecting-ip": "203.0.113.8",
    },
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
  const body = await response.json<{ publicUrl: string; managementUrl: string }>();
  const publicCapability = new URL(body.publicUrl).pathname.split("/").at(-1)!;
  const managementCapability = new URL(body.managementUrl).hash.slice("#manage=".length);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return { response, body, publicCapability, managementCapability, cookie };
}

function managementHeaders(cookie?: string) {
  return {
    origin: BASE_URL,
    [MANAGEMENT_ACTION_HEADER]: MANAGEMENT_ACTION_VALUE,
    ...(cookie ? { cookie } : {}),
  };
}

async function addSong(
  app: ReturnType<typeof makeApp>["app"],
  publicCapability: string,
  requestKey: string,
  url = TRACK_URL,
) {
  return app.request(`/api/threads/${publicCapability}/contributions`, {
    method: "POST",
    headers: publicMutationHeaders("add-song"),
    body: JSON.stringify({ url, requestKey }),
  });
}

function streamedJson(
  path: string,
  body: string,
  action: "create-thread" | "add-song",
): Request {
  const bytes = new TextEncoder().encode(body);
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: publicMutationHeaders(action),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2048));
        controller.enqueue(bytes.slice(2048));
        controller.close();
      },
    }),
  });
}

describe("Thread routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM thread_contributions").run();
    await env.DB.prepare("DELETE FROM threads").run();
    await env.DB.prepare("DELETE FROM links").run();
  });

  it("serves the creation page before the wildcard with Thread security headers", async () => {
    const { app } = makeApp();

    const response = await app.request("/threads/new");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('action="/api/threads"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("reports unavailable until the Thread schema is ready", async () => {
    const { app, threadStore } = makeApp();
    vi.spyOn(threadStore, "isReady").mockResolvedValue(false);

    const response = await app.request("/healthz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("keeps Thread routes dark when the environment flag is disabled", async () => {
    const { app, threadStore } = makeApp({ threadsEnabled: false });
    const readiness = vi.spyOn(threadStore, "isReady").mockRejectedValue(new Error("no schema"));

    expect((await app.request("/threads/new")).status).toBe(404);
    expect((await app.request("/api/threads/A", { method: "POST" })).status).toBe(404);
    expect((await app.request("/t/A")).status).toBe(404);
    expect((await app.request("/healthz")).status).toBe(200);
    expect(readiness).not.toHaveBeenCalled();
  });

  it("creates once, returns only public/private URLs, and activates this browser", async () => {
    const { app } = makeApp();

    const created = await createThread(app, "  Friday night  ");

    expect(created.body).toEqual({
      publicUrl: `${BASE_URL}/t/${created.publicCapability}`,
      managementUrl: `${BASE_URL}/t/${created.publicCapability}#manage=${created.managementCapability}`,
    });
    expect(created.response.headers.get("set-cookie")).toContain(
      `Path=/t/${created.publicCapability}`,
    );
    expect(created.response.headers.get("set-cookie")).toContain("HttpOnly");
    const page = await app.request(`/t/${created.publicCapability}`, {
      headers: { cookie: created.cookie },
    });
    expect(await page.text()).toContain("Private management view");
  });

  it("keeps the Apple Music staging proof same-origin and never returns the user token", async () => {
    const appleMusic = {
      getDeveloperToken: vi.fn().mockResolvedValue("developer-token-fixture"),
      createThreadPlaylist: vi.fn().mockResolvedValue({
        id: "playlist-fixture",
        playlistId: "playlist-fixture",
        playlistUrl: "https://music.apple.com/us/playlist/fixture",
        url: "https://music.apple.com/us/playlist/fixture",
        addedCount: 1,
      }),
    };
    const { app } = makeApp({ appleMusic });
    const created = await createThread(app, "Apple proof");
    await addSong(app, created.publicCapability, "apple-proof-song");

    const tokenResponse = await app.request("/api/apple-music/developer-token", {
      headers: { origin: BASE_URL },
    });
    expect(tokenResponse.status).toBe(200);
    expect(await tokenResponse.json()).toEqual({
      developerToken: "developer-token-fixture",
      storefrontId: "us",
    });

    const musicUserToken = "music-user-token-fixture-secret";
    const response = await app.request(
      `/api/threads/${created.publicCapability}/apple-music/spike`,
      {
        method: "POST",
        headers: publicMutationHeaders("apple-music-spike"),
        body: JSON.stringify({ musicUserToken }),
      },
    );
    expect(response.status).toBe(201);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toMatchObject({
      status: "created",
      playlistId: "playlist-fixture",
      trackCount: 1,
    });
    expect(responseText).not.toContain(musicUserToken);
    expect(appleMusic.createThreadPlaylist).toHaveBeenCalledWith(
      musicUserToken,
      "Apple proof",
      ["1443109064"],
    );

    const foreignHeaders = new Headers(publicMutationHeaders("apple-music-spike"));
    foreignHeaders.set("origin", "https://evil.example");
    const denied = await app.request(
      `/api/threads/${created.publicCapability}/apple-music/spike`,
      {
        method: "POST",
        headers: foreignHeaders,
        body: JSON.stringify({ musicUserToken }),
      },
    );
    expect(denied.status).toBe(403);
    expect(appleMusic.createThreadPlaylist).toHaveBeenCalledTimes(1);
  });

  it("emits only allowlisted aggregate Thread events", async () => {
    const { app, events } = makeApp();
    const created = await createThread(app);
    await addSong(app, created.publicCapability, "event-song");
    const eventResponse = await app.request("/api/thread-events", {
      method: "POST",
      headers: publicMutationHeaders("thread-event"),
      body: JSON.stringify({ outcome: "copied" }),
    });

    expect(eventResponse.status).toBe(204);
    expect(events).toEqual([
      { event: "thread_creation", outcome: "created" },
      { event: "thread_contribution", outcome: "accepted", count: 1 },
      { event: "thread_song_action", outcome: "copied" },
    ]);
    expect(JSON.stringify(events)).not.toContain(created.publicCapability);
    expect(JSON.stringify(events)).not.toContain(created.managementCapability);
    expect(JSON.stringify(events)).not.toContain(TRACK_URL);
  });

  it("exposes a public structured Thread read without management authority", async () => {
    const { app } = makeApp();
    const created = await createThread(app, "Agent-readable");
    await addSong(app, created.publicCapability, "agent-song");

    const response = await app.request(`/api/threads/${created.publicCapability}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      title: "Agent-readable",
      state: "open",
      songs: [
        {
          title: RESOLVED.title,
          artist: RESOLVED.artist,
          artworkUrl: RESOLVED.artworkUrl,
          url: expect.stringMatching(new RegExp(`^${BASE_URL}/[A-Za-z0-9]+$`)),
        },
      ],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(body)).not.toContain(created.managementCapability);
  });

  it("rejects cross-site public mutations before persistence or provider work", async () => {
    const { app, resolve, threadStore } = makeApp();
    const created = await createThread(app);
    const createResponse = await app.request("/api/threads", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: JSON.stringify({ title: "Cross-site" }),
    });
    const contributionResponse = await app.request(
      `/api/threads/${created.publicCapability}/contributions`,
      {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://evil.example" },
        body: JSON.stringify({ url: TRACK_URL, requestKey: "cross-site" }),
      },
    );

    expect(createResponse.status).toBe(403);
    expect(contributionResponse.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM threads").first<{
      count: number;
    }>();
    expect(count?.count).toBe(1);
    expect((await threadStore.getView(created.publicCapability))?.contributions).toHaveLength(0);
  });

  it("rejects invalid, oversized, rate-limited, and ceiling-limited creation without rows", async () => {
    const invalid = makeApp();
    expect(
      (
        await invalid.app.request("/api/threads", {
          method: "POST",
          headers: publicMutationHeaders("create-thread"),
          body: JSON.stringify({ title: " " }),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await invalid.app.request("/api/threads", {
          method: "POST",
          headers: {
            ...publicMutationHeaders("create-thread"),
            "content-length": "4097",
          },
          body: JSON.stringify({ title: "Too large" }),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await invalid.app.request(
          streamedJson(
            "/api/threads",
            `${JSON.stringify({ title: "Chunked" })}${" ".repeat(4097)}`,
            "create-thread",
          ),
        )
      ).status,
    ).toBe(413);
    const denied = makeApp({ creationAllowed: false });
    const deniedCreate = vi.spyOn(denied.threadStore, "create");
    const deniedResponse = await denied.app.request("/api/threads", {
      method: "POST",
      headers: publicMutationHeaders("create-thread"),
      body: JSON.stringify({ title: "Denied" }),
    });
    expect(deniedResponse.status).toBe(429);
    expect(deniedResponse.headers.get("retry-after")).toBe("60");
    expect(deniedCreate).not.toHaveBeenCalled();

    const capped = makeApp({ maxThreads: 1 });
    await createThread(capped.app, "First");
    const cappedResponse = await capped.app.request("/api/threads", {
      method: "POST",
      headers: publicMutationHeaders("create-thread"),
      body: JSON.stringify({ title: "Second" }),
    });
    expect(cappedResponse.status).toBe(503);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM threads").first<{
      count: number;
    }>();
    expect(count?.count).toBe(1);
  });

  it("denies contribution before resolver and stores no song", async () => {
    const { app, resolve, linkStore, threadStore } = makeApp({ contributionAllowed: false });
    const created = await createThread(app);
    const upsert = vi.spyOn(linkStore, "upsert");
    const accept = vi.spyOn(threadStore, "acceptContribution");

    const response = await addSong(app, created.publicCapability, "request-1");

    expect(response.status).toBe(429);
    expect(resolve).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it("parses source identity, appends repeatedly, retries idempotently, and renders canonical song URLs", async () => {
    const { app, threadStore } = makeApp();
    const created = await createThread(app);

    expect((await addSong(app, created.publicCapability, "request-1")).status).toBe(201);
    expect((await addSong(app, created.publicCapability, "request-2")).status).toBe(201);
    expect((await addSong(app, created.publicCapability, "request-2")).status).toBe(200);
    const view = await threadStore.getView(created.publicCapability);
    expect(view?.contributions).toHaveLength(2);
    expect(view?.contributions[0]).toMatchObject({
      sourceProvider: "spotify",
      sourceCatalogId: "4uLU6hMCjMI75M1A2tKUQC",
      sourceStorefront: "us",
      position: 1,
    });
    const page = await app.request(`/t/${created.publicCapability}`);
    const html = await page.text();
    expect(html.match(new RegExp(`href="${BASE_URL}/[a-z0-9]+"`, "g"))).toHaveLength(2);
    expect(html).toContain(`data-copy-song="${BASE_URL}/${view?.contributions[0]?.linkSlug}"`);
  });

  it("short-circuits accepted retries before credential-free provider resolution", async () => {
    const partial = { ...RESOLVED, isrc: null, complete: false };
    const { app, resolve, threadStore } = makeApp({ resolve: async () => partial });
    const created = await createThread(app);

    expect((await addSong(app, created.publicCapability, "partial-retry")).status).toBe(201);
    resolve.mockRejectedValue(new Error("provider unavailable"));
    const retry = await addSong(app, created.publicCapability, "partial-retry");

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: "existing" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((await threadStore.getView(created.publicCapability))?.contributions).toHaveLength(1);
  });

  it("classifies invalid, provider-failed, and conflicting additions without extra membership", async () => {
    const { app, resolve, threadStore } = makeApp();
    const created = await createThread(app);

    expect((await addSong(app, created.publicCapability, "bad", "https://example.com")).status).toBe(
      422,
    );
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRejectedValueOnce(new Error("provider unavailable"));
    expect((await addSong(app, created.publicCapability, "provider-fail")).status).toBe(502);
    expect((await addSong(app, created.publicCapability, "same-key")).status).toBe(201);
    expect(
      (await addSong(app, created.publicCapability, "same-key", OTHER_TRACK_URL)).status,
    ).toBe(409);
    expect((await threadStore.getView(created.publicCapability))?.contributions).toHaveLength(1);
  });

  it("rejects an unknown Thread before provider resolution", async () => {
    const { app, resolve } = makeApp();

    const response = await addSong(app, "A".repeat(22), "unknown-thread");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized contribution bodies before provider resolution", async () => {
    const { app, resolve } = makeApp();
    const created = await createThread(app);

    const malformed = await app.request(
      `/api/threads/${created.publicCapability}/contributions`,
      {
        method: "POST",
        headers: publicMutationHeaders("add-song"),
        body: "{",
      },
    );
    const oversized = await app.request(
      `/api/threads/${created.publicCapability}/contributions`,
      {
        method: "POST",
        headers: {
          ...publicMutationHeaders("add-song"),
          "content-length": "4097",
        },
        body: JSON.stringify({ url: TRACK_URL, requestKey: "oversized" }),
      },
    );
    const streamedOversized = await app.request(
      streamedJson(
        `/api/threads/${created.publicCapability}/contributions`,
        `${JSON.stringify({ url: TRACK_URL, requestKey: "streamed-oversized" })}${" ".repeat(4097)}`,
        "add-song",
      ),
    );

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(streamedOversized.status).toBe(413);
    expect(resolve).not.toHaveBeenCalled();
    expect(oversized.headers.get("cache-control")).toBe("private, no-store");
  });

  it("shows a full Thread, rejects a new add, and preserves an accepted retry", async () => {
    const { app, resolve, threadStore } = makeApp();
    const created = await createThread(app);
    expect((await addSong(app, created.publicCapability, "seed-1")).status).toBe(201);
    const linkSlug = (await threadStore.getView(created.publicCapability))?.contributions[0]
      ?.linkSlug;
    if (!linkSlug) throw new Error("seed contribution missing");
    const identity = {
      linkSlug,
      sourceProvider: "spotify" as const,
      sourceCatalogId: "4uLU6hMCjMI75M1A2tKUQC",
      sourceStorefront: "us",
    };
    const inputFingerprint = await fingerprintContributionInput(identity);
    for (let index = 2; index <= 50; index += 1) {
      const result = await threadStore.acceptContribution(created.publicCapability, {
        ...identity,
        requestKey: `seed-${index}`,
        inputFingerprint,
      });
      expect(result.status).toBe("accepted");
    }
    resolve.mockClear();

    const response = await addSong(app, created.publicCapability, "over-cap");
    const retry = await addSong(app, created.publicCapability, "seed-1");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "full" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: "existing" });
    expect(resolve).toHaveBeenCalledTimes(1);
    const page = await app.request(`/t/${created.publicCapability}`);
    expect(await page.text()).toContain("This Thread is full");
  });

  it("returns a recoverable error at the authoritative contribution storage ceiling", async () => {
    const { app } = makeApp({ maxContributionsPerThread: 1 });
    const thread = await createThread(app, "Bounded history");

    expect((await addSong(app, thread.publicCapability, "first")).status).toBe(201);
    const denied = await addSong(app, thread.publicCapability, "second");

    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: "contribution_limit_reached" });
    const page = await app.request(`/t/${thread.publicCapability}`);
    expect(await page.text()).toContain("reached its lifetime contribution limit");
  });

  it("returns the authoritative closed state when close wins during resolution", async () => {
    let threadStore: D1ThreadStore;
    let publicCapability = "";
    let managementCapability = "";
    const built = makeApp({
      resolve: async () => {
        const authorization = await authorizeManagementCapability(
          threadStore,
          publicCapability,
          managementCapability,
        );
        if (!authorization) throw new Error("authorization failed");
        await threadStore.close(authorization);
        return RESOLVED;
      },
    });
    threadStore = built.threadStore;
    const created = await createThread(built.app);
    publicCapability = created.publicCapability;
    managementCapability = created.managementCapability;

    const response = await addSong(built.app, publicCapability, "racing-add");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "closed" });
    expect((await threadStore.getView(publicCapability))?.contributions).toHaveLength(0);
  });

  it("returns the authoritative full state when capacity fills during resolution", async () => {
    let threadStore: D1ThreadStore;
    let publicCapability = "";
    let identity: {
      linkSlug: string;
      sourceProvider: "spotify";
      sourceCatalogId: string;
      sourceStorefront: string;
    };
    let inputFingerprint = "";
    const built = makeApp({
      resolve: async () => {
        const result = await threadStore.acceptContribution(publicCapability, {
          ...identity,
          requestKey: "fills-last-slot",
          inputFingerprint,
        });
        if (result.status !== "accepted") throw new Error("last slot was not filled");
        return RESOLVED;
      },
    });
    threadStore = built.threadStore;
    const created = await createThread(built.app);
    publicCapability = created.publicCapability;
    const link = await built.linkStore.upsert(RESOLVED);
    identity = {
      linkSlug: link.slug,
      sourceProvider: "spotify",
      sourceCatalogId: "4uLU6hMCjMI75M1A2tKUQC",
      sourceStorefront: "us",
    };
    inputFingerprint = await fingerprintContributionInput(identity);
    for (let index = 1; index <= 49; index += 1) {
      const result = await threadStore.acceptContribution(publicCapability, {
        ...identity,
        requestKey: `seed-${index}`,
        inputFingerprint,
      });
      expect(result.status).toBe("accepted");
    }

    const response = await addSong(built.app, publicCapability, "racing-overflow");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "full" });
    expect((await threadStore.getView(publicCapability))?.contributions).toHaveLength(50);
  });

  it("exchanges fragment authority, rejects cross-origin activation, and keeps bots public", async () => {
    const { app } = makeApp();
    const created = await createThread(app);
    const denied = await app.request(`/t/${created.publicCapability}/manage/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        [MANAGEMENT_ACTION_HEADER]: MANAGEMENT_ACTION_VALUE,
      },
      body: JSON.stringify({ token: created.managementCapability }),
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("set-cookie")).toBeNull();

    const invalid = await app.request(`/t/${created.publicCapability}/manage/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders() },
      body: JSON.stringify({ token: "Z".repeat(22) }),
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("set-cookie")).not.toContain(created.managementCapability);

    const navigation = await app.request(`/t/${created.publicCapability}/manage/activate`, {
      headers: managementHeaders(),
    });
    expect(navigation.status).toBe(404);

    const activated = await app.request(`/t/${created.publicCapability}/manage/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders() },
      body: JSON.stringify({ token: created.managementCapability }),
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({ status: "activated" });
    const cookie = activated.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const managed = await app.request(`/t/${created.publicCapability}`, { headers: { cookie } });
    expect(await managed.text()).toContain("Private management view");

    const bot = await app.request(`/t/${created.publicCapability}`, {
      headers: { cookie, "user-agent": "Slackbot-LinkExpanding 1.0" },
    });
    const botHtml = await bot.text();
    expect(botHtml).toContain('property="og:title"');
    expect(botHtml).not.toContain("Private management view");
    expect(botHtml).not.toContain(created.managementCapability);
  });

  it("removes with guarded cookie authority, closes irreversibly, and leaves songs viewable", async () => {
    const { app } = makeApp();
    const created = await createThread(app);
    await addSong(app, created.publicCapability, "request-1");
    const page = await app.request(`/t/${created.publicCapability}`, {
      headers: { cookie: created.cookie },
    });
    const contributionId = (await page.text()).match(/data-contribution-id="(\d+)"/)?.[1];
    expect(contributionId).toBeDefined();

    const unguarded = await app.request(
      `/t/${created.publicCapability}/manage/contributions/${contributionId}/remove`,
      { method: "POST", headers: { cookie: created.cookie } },
    );
    expect(unguarded.status).toBe(403);
    const removed = await app.request(
      `/t/${created.publicCapability}/manage/contributions/${contributionId}/remove`,
      { method: "POST", headers: managementHeaders(created.cookie) },
    );
    expect(removed.status).toBe(200);

    const second = await addSong(app, created.publicCapability, "request-2");
    const secondId = (await second.json<{ contributionId: number }>()).contributionId;
    await addSong(app, created.publicCapability, "request-3");
    const closed = await app.request(`/t/${created.publicCapability}/manage/close`, {
      method: "POST",
      headers: managementHeaders(created.cookie),
    });
    expect(closed.status).toBe(200);
    const rejected = await addSong(app, created.publicCapability, "after-close");
    const retry = await addSong(app, created.publicCapability, "request-2");
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "closed" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: "existing" });
    const removedAfterClose = await app.request(
      `/t/${created.publicCapability}/manage/contributions/${secondId}/remove`,
      { method: "POST", headers: managementHeaders(created.cookie) },
    );
    expect(removedAfterClose.status).toBe(200);
    const closedPage = await app.request(`/t/${created.publicCapability}`);
    const html = await closedPage.text();
    expect(html).toContain("Contributions are closed");
    expect(html).toContain("Open song");
  });

  it("uses a plain 404 for unknown Threads and preserves the existing homepage", async () => {
    const { app } = makeApp();

    const unknown = await app.request(`/t/${"A".repeat(22)}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("Link not found.");
    const home = await app.request("/");
    expect(await home.text()).toContain('href="/threads/new"');
  });
});
