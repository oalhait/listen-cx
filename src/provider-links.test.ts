import { describe, expect, it } from "vitest";
import { providerTarget } from "./provider-links.js";

const ROW = {
  title: "Kingston",
  artist: "Faye Webster",
  spotify_url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
  apple_url: "https://music.apple.com/us/album/kingston/1443108737?i=1443109064",
};

describe("providerTarget", () => {
  it("keeps an exact Apple destination as an HTTPS universal link", () => {
    expect(providerTarget(ROW, "apple")).toEqual({
      url: ROW.apple_url,
      isExactMatch: true,
    });
  });

  it("normalizes iTunes destinations to the Apple Music HTTPS host", () => {
    expect(
      providerTarget(
        { ...ROW, apple_url: "https://itunes.apple.com/us/album/kingston/1443108737?i=1443109064" },
        "apple",
      ),
    ).toEqual({
      url: "https://music.apple.com/us/album/kingston/1443108737?i=1443109064",
      isExactMatch: true,
    });
  });

  it("normalizes geo Apple destinations to the Apple Music HTTPS host", () => {
    expect(
      providerTarget(
        { ...ROW, apple_url: "https://geo.music.apple.com/us/album/kingston/1443108737?i=1443109064" },
        "apple",
      ),
    ).toEqual({
      url: "https://music.apple.com/us/album/kingston/1443108737?i=1443109064",
      isExactMatch: true,
    });
  });

  it("uses an HTTPS Apple Music search URL when no exact match exists", () => {
    const target = providerTarget({ ...ROW, apple_url: null }, "apple");
    expect(target.isExactMatch).toBe(false);
    expect(new URL(target.url).protocol).toBe("https:");
    expect(target.url).toContain("music.apple.com/us/search");
  });

  it.each([
    ["apple", "music://music.apple.com/song/1"],
    ["apple", "https://example.com/song/1"],
    ["apple", "not-a-url"],
    ["spotify", "spotify:track:4uLU6hMCjMI75M1A2tKUQC"],
    ["spotify", "https://example.com/track/1"],
    ["spotify", "not-a-url"],
  ] as const)("falls back when %s receives a non-provider destination", (provider, candidate) => {
    const row =
      provider === "apple"
        ? { ...ROW, apple_url: candidate }
        : { ...ROW, spotify_url: candidate };
    const target = providerTarget(row, provider);
    expect(target.isExactMatch).toBe(false);
    expect(new URL(target.url).protocol).toBe("https:");
    expect(target.url).not.toContain(candidate);
    expect(target.url).toContain(
      provider === "apple" ? "music.apple.com/us/search" : "open.spotify.com/search/",
    );
  });

  it("preserves Spotify exact links and search fallbacks", () => {
    expect(providerTarget(ROW, "spotify")).toEqual({
      url: ROW.spotify_url,
      isExactMatch: true,
    });
    const fallback = providerTarget({ ...ROW, spotify_url: null }, "spotify");
    expect(fallback.isExactMatch).toBe(false);
    expect(fallback.url).toContain("open.spotify.com/search/");
  });
});
