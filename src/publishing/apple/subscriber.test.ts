import { describe, expect, it, vi } from "vitest";
import { AppleLibrarySubscriber } from "./subscriber.js";

const playlistUrl = "https://music.apple.com/us/playlist/listen/pl.u-abc";
const credentials = { developerToken: "developer", musicUserToken: "user" };
const libraryResponse = (id = "p.library") => new Response(JSON.stringify({ data: [{ id, type: "library-playlists" }] }), {
  headers: { "Content-Type": "application/json" },
});

describe("AppleLibrarySubscriber", () => {
  it("adds the canonical catalog playlist to the listener library and verifies its library relationship", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(libraryResponse());
    const subscriber = new AppleLibrarySubscriber({ credentials, fetcher });

    await expect(subscriber.reconcile({ playlistUrl, previousPlaylistUrl: null })).resolves.toEqual({
      playlistId: "p.library", playlistUrl,
    });
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://api.music.apple.com/v1/catalog/us/playlists/pl.u-abc/library", expect.objectContaining({ method: "GET" }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.music.apple.com/v1/me/library?ids%5Bplaylists%5D=pl.u-abc", expect.objectContaining({
      method: "POST", redirect: "manual",
      headers: { Authorization: "Bearer developer", "Music-User-Token": "user" },
    }));
    expect(fetcher).toHaveBeenNthCalledWith(3, "https://api.music.apple.com/v1/catalog/us/playlists/pl.u-abc/library", expect.objectContaining({ method: "GET" }));
  });

  it("does not write again when the same canonical playlist is already in the listener library", async () => {
    const fetcher = vi.fn().mockResolvedValue(libraryResponse());
    const subscriber = new AppleLibrarySubscriber({ credentials, fetcher });

    await subscriber.reconcile({ playlistUrl, previousPlaylistUrl: playlistUrl });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://api.music.apple.com/v1/catalog/us/playlists/pl.u-abc/library", expect.objectContaining({ method: "GET" }));
  });

  it("checks the catalog storefront carried by the canonical playlist URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(libraryResponse());
    const subscriber = new AppleLibrarySubscriber({ credentials, fetcher });

    await subscriber.reconcile({ playlistUrl: playlistUrl.replace("/us/", "/gb/"), previousPlaylistUrl: null });

    expect(fetcher).toHaveBeenCalledWith("https://api.music.apple.com/v1/catalog/gb/playlists/pl.u-abc/library", expect.anything());
  });

  it.each([
    "https://evil.example/us/playlist/listen/pl.u-abc",
    "https://music.apple.com/us/playlist/listen/p.library",
    "https://music.apple.com/us/album/listen/pl.u-abc",
  ])("rejects a non-catalog Apple playlist URL before calling Apple: %s", async invalidUrl => {
    const fetcher = vi.fn();
    const subscriber = new AppleLibrarySubscriber({ credentials, fetcher });

    await expect(subscriber.reconcile({ playlistUrl: invalidUrl, previousPlaylistUrl: null })).rejects.toMatchObject({ code: "invalid_publication_readback" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects oversized provider readback", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("x".repeat(64 * 1024 + 1)));
    const subscriber = new AppleLibrarySubscriber({ credentials, fetcher });

    await expect(subscriber.reconcile({ playlistUrl, previousPlaylistUrl: playlistUrl })).rejects.toMatchObject({ code: "invalid_provider_response" });
  });
});
