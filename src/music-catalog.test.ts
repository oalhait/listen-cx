import { describe, expect, it, vi } from "vitest";
import { MusicCatalog, MusicCatalogError } from "./music-catalog.js";
import type { CatalogTrack } from "./track-matching.js";

const spotifyId = "a".repeat(22);
const source: CatalogTrack = { provider: "apple", id: "123", storefront: "us", title: "Song", artist: "Artist", album: "Album", durationMs: 200000, isrc: "USABC2400001", explicit: false, playable: true };
const spotify = (extra: Record<string, unknown> = {}) => ({ id: spotifyId, type: "track", name: "Song", artists: [{ name: "Artist" }], album: { name: "Album" }, duration_ms: 200000, explicit: false, external_ids: { isrc: source.isrc }, is_playable: true, ...extra });
const apple = (extra: Record<string, unknown> = {}) => ({ id: "123", type: "songs", attributes: { name: "Song", artistName: "Artist", albumName: "Album", durationInMillis: 200000, isrc: source.isrc, contentRating: "clean", playParams: { id: "123", kind: "song" }, ...extra } });

describe("MusicCatalog", () => {
  it("uses public Spotify metadata without rebinding the fetcher and preserves known explicitness", async () => {
    const fetcher: typeof fetch = async function (this: unknown, input) {
      expect(this).toBeUndefined();
      if (String(input).includes("/oembed")) return Response.json({ title: "Song" });
      if (!String(input).includes('/embed/')) return new Response(`<meta property="og:url" content="https://open.spotify.com/track/${spotifyId}"><meta property="og:description" content="Artist · Album · Song · 2026">`);
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { type: "track", id: spotifyId, title: "Song", artists: [{ name: "Artist" }], duration: 200000, isExplicit: false, isPlayable: true } } } } } })}</script>`);
    };
    expect(await new MusicCatalog({ fetcher }).get({ provider: "spotify", id: spotifyId, storefront: "us" })).toMatchObject({ album: 'Album', explicit: false, playable: true, durationMs: 200000, isrc: null });
  });

  it("uses Apple metadata search when source ISRC is unknown", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ results: { songs: { data: [apple()] } } }));
    expect(await new MusicCatalog({ appleDeveloperToken: "token", fetcher }).findMatch({ ...source, provider: "spotify", id: spotifyId, isrc: null }, "apple", "us")).toMatchObject({ status: "matched", method: "metadata" });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v1/catalog/us/search");
    expect(url.searchParams.get("types")).toBe("songs");
    expect(url.searchParams.get("term")).toBe("Song Artist");
  });

  it("enriches a small ambiguous Apple set with album release evidence", async () => {
    const older = apple({ albumName: "Back from the Dead 2", durationInMillis: 206602, isrc: "USAE81401954", url: "https://music.apple.com/us/album/faneto/930701525?i=930701578" });
    const current = apple({ albumName: "Back from the Dead 2", durationInMillis: 206655, isrc: "USZEG1500799", url: "https://music.apple.com/us/album/faneto/1614548299?i=1614548303" });
    const item = (id: string, value: ReturnType<typeof apple>) => ({ ...value, id });
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/albums/930701525")) return Response.json({ data: [{ id: "930701525", type: "albums", attributes: { name: "Back from the Dead 2", releaseDate: "2014-10-31" } }] });
      if (url.pathname.endsWith("/albums/1614548299")) return Response.json({ data: [{ id: "1614548299", type: "albums", attributes: { name: "Back from the Dead 2", releaseDate: "2015-06-16" } }] });
      return Response.json({ results: { songs: { data: [item("930701578", older), item("1614548303", current)] } } });
    });
    const spotifySource: CatalogTrack = { provider: "spotify", id: spotifyId, storefront: "us", title: "Song", artist: "Artist", album: "Back from the Dead 2", releaseDate: "2015-06-16", durationMs: 206654, isrc: null, explicit: false, playable: true };
    expect(await new MusicCatalog({ appleDeveloperToken: "token", fetcher }).findMatch(spotifySource, "apple", "us")).toMatchObject({ status: "matched", selected: { id: "1614548303" } });
  });

  it("does not turn public source throttling into missing metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 429, headers: { "Retry-After": "23" } }));
    await expect(new MusicCatalog({ fetcher }).get({ provider: "spotify", id: spotifyId, storefront: "us" })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 23 });
  });

  it("preserves a catalog rate limit from the optional Spotify track page", async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.includes("/oembed")) return Response.json({ title: "Song" });
      if (!url.includes("/embed/")) return new Response(null, { status: 429, headers: { "Retry-After": "19" } });
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { type: "track", id: spotifyId, title: "Song", artists: [{ name: "Artist" }], duration: 200000, isExplicit: false, isPlayable: true } } } } } })}</script>`);
    });
    await expect(new MusicCatalog({ fetcher }).get({ provider: "spotify", id: spotifyId, storefront: "us" })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 19 });
  });

  it("fetches authenticated source metadata with destination market and bearer token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(spotify()));
    const catalog = new MusicCatalog({ spotifyAccessToken: "token", fetcher });
    expect(await catalog.get({ provider: "spotify", id: spotifyId, storefront: "gb" })).toMatchObject({ provider: "spotify", id: spotifyId, storefront: "gb", isrc: source.isrc, playable: true });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.spotify.com/v1/tracks/${spotifyId}?market=GB`);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
  });

  it("searches Spotify by ISRC first without fetching additional pages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ tracks: { items: [spotify()], next: "https://example.com/next" } }));
    expect(await new MusicCatalog({ spotifyAccessToken: "token", fetcher }).findMatch(source, "spotify", "us")).toMatchObject({ status: "matched", method: "isrc" });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get("q")).toBe(`isrc:${source.isrc}`);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back to automatic metadata matching after empty ISRC search", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ tracks: { items: [] } })).mockResolvedValueOnce(Response.json({ tracks: { items: [spotify()] } }));
    expect(await new MusicCatalog({ spotifyAccessToken: "token", fetcher }).findMatch(source, "spotify", "us")).toMatchObject({ status: "matched", method: "metadata" });
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("q")).toBe('track:"Song" artist:"Artist"');
  });

  it("searches Apple by ISRC symmetrically and bounds candidates to 25", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [apple()] }));
    expect(await new MusicCatalog({ appleDeveloperToken: "token", fetcher }).findMatch({ ...source, provider: "spotify", id: spotifyId }, "apple", "GB")).toMatchObject({ status: "matched", selected: { provider: "apple", storefront: "gb" } });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v1/catalog/gb/songs");
    expect(url.searchParams.get("filter[isrc]")).toBe(source.isrc);
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("keeps missing Apple explicitness unknown", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [apple({ contentRating: undefined })] }));
    expect(await new MusicCatalog({ appleDeveloperToken: "token", fetcher }).get({ provider: "apple", id: "123", storefront: "us" })).toMatchObject({ explicit: null });
  });

  it.each([401, 403, 429, 503])("throws status %i and retry timing instead of reporting unavailable", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status, headers: { "Retry-After": "17" } }));
    await expect(new MusicCatalog({ spotifyAccessToken: "token", fetcher }).findMatch(source, "spotify", "us")).rejects.toMatchObject({ status, retryAfterSeconds: 17 });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("throws when a required destination credential is unavailable", async () => {
    await expect(new MusicCatalog({}).findMatch(source, "spotify", "us")).rejects.toBeInstanceOf(MusicCatalogError);
  });

  it("returns absent for 404 and null tracks, but throws malformed payloads", async () => {
    for (const response of [new Response(null, { status: 404 }), Response.json(null)]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      expect(await new MusicCatalog({ spotifyAccessToken: "token", fetcher }).get({ provider: "spotify", id: spotifyId, storefront: "us" })).toBeNull();
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ tracks: {} }));
    await expect(new MusicCatalog({ spotifyAccessToken: "token", fetcher }).findMatch(source, "spotify", "us")).rejects.toThrow("payload");
  });

  it("does not treat restricted Spotify tracks as playable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(spotify({ restrictions: { reason: "market" } })));
    expect(await new MusicCatalog({ spotifyAccessToken: "token", fetcher }).get({ provider: "spotify", id: spotifyId, storefront: "us" })).toMatchObject({ playable: false });
  });

  it("rejects invalid IDs and storefronts before making requests", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const catalog = new MusicCatalog({ fetcher });
    await expect(catalog.get({ provider: "apple", id: "../bad", storefront: "us" })).rejects.toThrow();
    await expect(catalog.get({ provider: "spotify", id: spotifyId, storefront: "../us" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
