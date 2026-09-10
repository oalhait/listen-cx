import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { D1LinkStore } from "./db.js";
import type { Resolved } from "./resolve.js";

const track: Resolved = {
  isrc: null, complete: false, title: "Cataracts", artist: "Freddie Gibbs, Madlib",
  artworkUrl: null, spotifyUrl: "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO", appleUrl: null,
};
const resolve = vi.fn<(_: string) => Promise<Resolved | null>>();
const store = new D1LinkStore(env.DB);
const app = createApp({ resolver: { resolve }, store, baseUrl: "https://listen.test" });
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

  it("keeps partial rows immutable and allocates a fresh slug on each creation", async () => {
    const first = await store.upsert(track);
    const second = await store.upsert({ ...track, title: "Another title" });
    expect(second.slug).not.toBe(first.slug);
    expect(await store.get(first.slug)).toEqual(first);
  });

  it.each([null, [], {}, { url: 1 }, { url: "https://example.com/song" }])("rejects invalid input %j before provider access", async (body) => {
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

  it.each(["/", "/missing", "/threads/new", "/api/threads"])("serves no UI at %s", async (path) => {
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
});
