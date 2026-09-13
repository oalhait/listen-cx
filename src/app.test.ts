import { env, exports } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { D1LinkStore } from "./db.js";
import { D1JamStore } from "./jam-db.js";
import type { Resolved } from "./resolve.js";

const track: Resolved = {
  isrc: null, complete: false, title: "Cataracts", artist: "Freddie Gibbs, Madlib",
  artworkUrl: null, spotifyUrl: "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO", appleUrl: null,
};
const resolve = vi.fn<(_: string) => Promise<Resolved | null>>();
const store = new D1LinkStore(env.DB);
const jamStore = new D1JamStore(env.DB, { maxJams: 10_000 });
const app = createApp({
  resolver: { resolve },
  store,
  jamStore,
  jamsEnabled: true,
  baseUrl: "https://listen.test",
});
const create = (body: unknown) => app.request("/create", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { vi.restoreAllMocks(); resolve.mockReset().mockResolvedValue(track); });

describe("short-link API", () => {
  it("persists a short link and reads its metadata without calling providers again", async () => {
    const response = await create({ url: track.spotifyUrl });
    expect(response.status).toBe(200);
    const result = await response.json() as { slug: string; link: string };
    expect(result.slug).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{7}$/);
    expect(result.link).toBe(`https://listen.test/${result.slug}`);
    const read = await app.request(`/${result.slug}`);
    expect(read.headers.get("content-type")).toContain("application/json");
    expect(await read.json()).toMatchObject({ slug: result.slug, title: track.title, spotify_url: track.spotifyUrl, apple_url: null, complete: 0 });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("serves browser HTML and varies by Accept while preserving explicit and default JSON", async () => {
    const row = await store.upsert(track);
    for (const accept of [undefined, "*/*", "application/json", "text/html;q=.5, application/json"]) {
      const response = await app.request(`/${row.slug}`, { headers: accept ? { Accept: accept } : {} });
      expect(response.headers.get("Vary")).toBe("Accept");
      expect(await response.json()).toEqual(row);
    }
    const response = await app.request(`/${row.slug}`, { headers: { Accept: "text/html" } });
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("Vary")).toBe("Accept");
    const html = await response.text();
    expect(html).toContain("Open in Spotify");
    expect(html).toContain('<meta property="og:title" content="Cataracts — Freddie Gibbs, Madlib">');
    expect(html).toContain(`<meta property="og:url" content="https://listen.test/${row.slug}">`);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["/missing", "/zzzzzzz"])("returns an HTML 404 for a browser at %s", async (path) => {
    const response = await app.request(path, { headers: { Accept: "text/html" } });
    expect(response.status).toBe(404);
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(await response.text()).toContain("Link not found");
  });

  it("keeps partial rows immutable and allocates a fresh slug on each creation", async () => {
    const first = await store.upsert(track);
    const second = await store.upsert({ ...track, title: "Another title" });
    expect(second.slug).not.toBe(first.slug);
    expect(await store.get(first.slug)).toEqual(first);
  });

  it.each([null, [], {}, { url: 1 }, { url: "https://example.com/song" }, { url: "https://spotify.link/example" }, { url: "https://music.apple.com/us/album/this-thing-of-ours/1562919023" }, { url: "https://open.spotify.com/album/4SN5Kkig8iJ8vdwsOoP7IO" }])("rejects invalid input %j before provider access", async (body) => {
    expect((await create(body)).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized JSON including bodies without a length header", async () => {
    expect((await app.request("/create", { method: "POST", body: "{" })).status).toBe(400);
    expect((await create({ url: "x".repeat(5000) })).status).toBe(413);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reports missing tracks separately from provider failures", async () => {
    resolve.mockResolvedValueOnce(null);
    expect((await create({ url: track.spotifyUrl })).status).toBe(404);
    resolve.mockRejectedValueOnce(new Error("upstream failed"));
    expect((await create({ url: track.spotifyUrl })).status).toBe(502);
  });

  it("does not leak storage errors", async () => {
    vi.spyOn(store, "upsert").mockRejectedValueOnce(new Error("private database details"));
    const response = await create({ url: track.spotifyUrl });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error." });
  });

  it.each(["/", "/missing", "/threads/new", "/api/threads"])("keeps unknown API paths as JSON at %s", async (path) => {
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("returns 404 for an unknown valid slug", async () => {
    expect((await app.request("/zzzzzzz")).status).toBe(404);
  });

  it("checks database readiness through the actual Worker entrypoint", async () => {
    const response = await exports.default.fetch("https://staging.listen.cx/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("reports unavailable storage in health checks", async () => {
    vi.spyOn(store, "isReady").mockRejectedValueOnce(new Error("offline"));
    expect((await app.request("/healthz")).status).toBe(503);
  });

  it("serves only a signed Apple developer token to an allowed same-origin client", async () => {
    const issueDeveloperToken = vi.fn().mockResolvedValue({
      developerToken: "header.payload.signature",
      expiresAt: "2026-09-10T01:00:00.000Z",
      allowedOrigins: ["http://127.0.0.1:8787"],
      mediaId: "media.cx.listen.web",
    });
    const appleApp = createApp({
      resolver: { resolve },
      store,
      jamStore,
      jamsEnabled: true,
      baseUrl: "http://127.0.0.1:8787",
      appleMusic: {
        allowedOrigins: ["http://127.0.0.1:8787"],
        issueDeveloperToken,
      },
    });
    const response = await appleApp.request("http://127.0.0.1:8787/api/apple-music/developer-token", {
      headers: { Origin: "http://127.0.0.1:8787" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      developerToken: "header.payload.signature",
      expiresAt: "2026-09-10T01:00:00.000Z",
      mediaId: "media.cx.listen.web",
    });
    expect(issueDeveloperToken).toHaveBeenCalledOnce();

    const hostile = await appleApp.request("http://127.0.0.1:8787/api/apple-music/developer-token", {
      headers: { Origin: "https://attacker.example" },
    });
    expect(hostile.status).toBe(403);
    expect(issueDeveloperToken).toHaveBeenCalledOnce();
    expect((await app.request("/api/apple-music/developer-token")).status).toBe(404);
  });

  it("serves MCP tools that an agent can use to create and read a listen link", async () => {
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    const client = new Client({ name: "listen-cx-test-agent", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({ name: "listen-cx" });
      expect(client.getInstructions()).toContain("single-track links and collaborative Jams");
      expect(client.getInstructions()).toContain("not synchronized playback");
      expect(client.getInstructions()).toContain("Keep managementToken secret");

      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual([
        "create_listen_link",
        "get_listen_link",
        "create_jam",
        "get_jam",
        "add_track_to_jam",
        "remove_track_from_jam",
        "close_jam",
        "check_listen_health",
      ]);
      expect(tools.tools[0]?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
      expect(tools.tools[0]?.description).toContain("create_jam");

      const invalid = await client.callTool({
        name: "create_listen_link",
        arguments: { url: "https://example.com/not-a-track" },
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.content).toContainEqual({
        type: "text",
        text: "Send a Spotify or Apple Music track URL.",
      });
      expect(invalid.structuredContent).toEqual({
        ok: false,
        error: {
          code: "invalid_track_url",
          status: 400,
          message: "Send a Spotify or Apple Music track URL.",
          retryable: false,
        },
      });
      expect(resolve).not.toHaveBeenCalled();

      const created = await client.callTool({
        name: "create_listen_link",
        arguments: { url: track.spotifyUrl },
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({
        ok: true,
        title: track.title,
        artist: track.artist,
      });
      const slug = (created.structuredContent as { slug: string }).slug;

      const read = await client.callTool({
        name: "get_listen_link",
        arguments: { slugOrUrl: `https://listen.test/${slug}` },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({
        ok: true,
        slug,
        title: track.title,
        spotifyUrl: track.spotifyUrl,
        appleUrl: null,
        providerUrlStatus: "source_only",
        warning: expect.stringContaining("no cross-provider match"),
      });

      const missing = await client.callTool({
        name: "get_listen_link",
        arguments: { slugOrUrl: "zzzzzzz" },
      });
      expect(missing).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "link_not_found", status: 404, retryable: false },
        },
      });

      const invalidReference = await client.callTool({
        name: "get_listen_link",
        arguments: { slugOrUrl: "https://attacker.example/abcde23" },
      });
      expect(invalidReference).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "invalid_link", status: 400, retryable: false },
        },
      });

      resolve.mockResolvedValueOnce(null);
      const trackMissing = await client.callTool({
        name: "create_listen_link",
        arguments: { url: track.spotifyUrl },
      });
      expect(trackMissing).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "track_not_found", status: 404, retryable: false },
        },
      });

      resolve.mockRejectedValueOnce(new Error("private provider details"));
      const providerFailure = await client.callTool({
        name: "create_listen_link",
        arguments: { url: track.spotifyUrl },
      });
      expect(providerFailure).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "provider_unavailable", status: 502, retryable: true },
        },
      });
      expect(JSON.stringify(providerFailure)).not.toContain("private provider details");

      vi.spyOn(store, "upsert").mockRejectedValueOnce(new Error("private storage details"));
      const storageFailure = await client.callTool({
        name: "create_listen_link",
        arguments: { url: track.spotifyUrl },
      });
      expect(storageFailure).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "storage_unavailable", status: 500, retryable: true },
        },
      });
      expect(JSON.stringify(storageFailure)).not.toContain("private storage details");

      const health = await client.callTool({ name: "check_listen_health", arguments: {} });
      expect(health).toMatchObject({
        isError: false,
        structuredContent: { status: "ok", baseUrl: "https://listen.test" },
      });

      vi.spyOn(store, "isReady").mockResolvedValueOnce(false);
      const unavailableHealth = await client.callTool({
        name: "check_listen_health",
        arguments: {},
      });
      expect(unavailableHealth).toMatchObject({
        isError: true,
        structuredContent: { status: "unavailable", baseUrl: "https://listen.test" },
      });
    } finally {
      await client.close();
    }
  });

  it("keeps Jam storage dark when Jams are disabled", async () => {
    const jamReady = vi.spyOn(jamStore, "isReady").mockRejectedValue(new Error("must not run"));
    const jamRead = vi.spyOn(jamStore, "get");
    const disabledApp = createApp({
      resolver: { resolve },
      store,
      jamStore,
      jamsEnabled: false,
      baseUrl: "http://127.0.0.1:8787",
    });

    expect((await disabledApp.request("/healthz")).status).toBe(200);
    const publicRead = await disabledApp.request(`/api/jams/${"A".repeat(22)}`);
    expect(publicRead.status).toBe(404);

    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      fetch: async (input, init) => disabledApp.fetch(new Request(input, init)),
    });
    const client = new Client({ name: "disabled-jam-test-agent", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(client.getInstructions()).toContain("Jam tools are unavailable");
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual([
        "create_listen_link",
        "get_listen_link",
        "check_listen_health",
      ]);
      expect(tools.tools[0]?.description).not.toContain("create_jam");

      const health = await client.callTool({ name: "check_listen_health", arguments: {} });
      expect(health).toMatchObject({
        isError: false,
        structuredContent: {
          status: "ok",
          links: "ok",
          jams: "disabled",
        },
      });
    } finally {
      await client.close();
    }

    expect(jamReady).not.toHaveBeenCalled();
    expect(jamRead).not.toHaveBeenCalled();
  });

  it("runs a complete collaborative Jam lifecycle through a real MCP client", async () => {
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    const client = new Client({ name: "jam-lifecycle-test-agent", version: "1.0.0" });

    try {
      await client.connect(transport);
      const created = await client.callTool({
        name: "create_jam",
        arguments: { title: "Friday night" },
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({
        ok: true,
        title: "Friday night",
        state: "open",
        jamId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        managementToken: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      });
      const {
        jamId,
        managementToken,
      } = created.structuredContent as { jamId: string; managementToken: string };
      expect(JSON.stringify(created.content)).not.toContain(managementToken);

      const empty = await client.callTool({ name: "get_jam", arguments: { jamId } });
      expect(empty.structuredContent).toMatchObject({
        ok: true,
        state: "open",
        activeTrackCount: 0,
        tracks: [],
      });
      const publicRead = await app.request(`/api/jams/${jamId}`);
      expect(publicRead.status).toBe(200);
      expect(await publicRead.json()).toMatchObject({ jamId, title: "Friday night" });

      const added = await client.callTool({
        name: "add_track_to_jam",
        arguments: {
          jamId,
          url: track.spotifyUrl,
          requestKey: "agent-operation-1",
        },
      });
      expect(added.isError).not.toBe(true);
      expect(added.structuredContent).toMatchObject({
        ok: true,
        status: "accepted",
        jamId,
        requestKey: "agent-operation-1",
        contributionId: expect.any(Number),
        position: 1,
      });
      const contributionId = (added.structuredContent as { contributionId: number }).contributionId;

      const retried = await client.callTool({
        name: "add_track_to_jam",
        arguments: {
          jamId,
          url: track.spotifyUrl,
          requestKey: "agent-operation-1",
        },
      });
      expect(retried.structuredContent).toMatchObject({
        ok: true,
        status: "existing",
        contributionId,
        position: 1,
      });

      const populated = await client.callTool({ name: "get_jam", arguments: { jamId } });
      expect(populated.structuredContent).toMatchObject({
        ok: true,
        activeTrackCount: 1,
        totalContributions: 1,
        tracks: [{ contributionId, position: 1, title: track.title, artist: track.artist }],
      });

      const denied = await client.callTool({
        name: "remove_track_from_jam",
        arguments: { jamId, managementToken: "x".repeat(22), contributionId },
      });
      expect(denied).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "jam_management_denied", status: 403, retryable: false },
        },
      });

      const removed = await client.callTool({
        name: "remove_track_from_jam",
        arguments: { jamId, managementToken, contributionId },
      });
      expect(removed.structuredContent).toMatchObject({
        ok: true,
        status: "removed",
        jamId,
        contributionId,
      });

      const closed = await client.callTool({
        name: "close_jam",
        arguments: { jamId, managementToken },
      });
      expect(closed.structuredContent).toMatchObject({
        ok: true,
        status: "closed",
        jamId,
        closedAt: expect.any(String),
      });

      const addAfterClose = await client.callTool({
        name: "add_track_to_jam",
        arguments: {
          jamId,
          url: track.spotifyUrl,
          requestKey: "agent-operation-after-close",
        },
      });
      expect(addAfterClose).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "jam_closed", status: 409, retryable: false },
        },
      });
    } finally {
      await client.close();
    }
  });

  it("marks legacy cross-provider URLs as unverified in MCP output", async () => {
    vi.spyOn(store, "get").mockResolvedValueOnce({
      slug: "abcde23",
      isrc: "US-S1Z-99-00001",
      title: "Legacy track",
      artist: "Legacy artist",
      artwork_url: null,
      spotify_url: "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO",
      apple_url: "https://music.apple.com/us/song/legacy/123456789",
      complete: 1,
      created_at: "2026-01-01 00:00:00",
    });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    const client = new Client({ name: "legacy-link-test-agent", version: "1.0.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "get_listen_link",
        arguments: { slugOrUrl: "abcde23" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        providerUrlStatus: "legacy_unverified",
        warning: expect.stringContaining("Do not describe"),
      });
    } finally {
      await client.close();
    }
  });

  it("allows same-origin MCP preflight and rejects hostile browser origins", async () => {
    const response = await app.request("http://127.0.0.1:8787/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:8787",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8787");

    const hostile = await app.request("http://127.0.0.1:8787/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(hostile.status).toBe(403);

    const rebound = await app.request("https://attacker.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(rebound.status).toBe(403);

    const arbitraryWorker = await app.request("https://unrelated.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(arbitraryWorker.status).toBe(403);

    const mismatchedHost = await app.request("https://listen.cx/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "attacker.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mismatchedHost.status).toBe(403);
  });

  it("bounds MCP bodies and rejects JSON-RPC batches", async () => {
    const oversized = await app.request("http://127.0.0.1:8787/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const batch = await app.request("http://127.0.0.1:8787/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
    });
    expect(batch.status).toBe(400);

    const get = await app.request("http://127.0.0.1:8787/mcp");
    expect(get.status).toBe(405);
  });
});
