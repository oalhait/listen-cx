import { describe, it, expect } from "vitest";
import { parseTrackUrl, spotifyTrackUrl, appleTrackUrl, spotifySearchUrl, appleSearchUrl } from "./urls.js";

describe("parseTrackUrl", () => {
  it("parses a plain spotify track url", () => {
    expect(parseTrackUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")).toEqual({
      provider: "spotify",
      id: "4uLU6hMCjMI75M1A2tKUQC",
      storefront: "us",
    });
  });

  it("parses spotify intl paths and strips share params", () => {
    expect(
      parseTrackUrl("https://open.spotify.com/intl-pt/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123"),
    ).toMatchObject({ provider: "spotify", id: "4uLU6hMCjMI75M1A2tKUQC" });
  });

  it("parses spotify share urls with tracking params", () => {
    expect(
      parseTrackUrl(
        "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO?si=5nEgSwdQQzmmxfWnNLTuWg&utm_source=sms",
      ),
    ).toEqual({ provider: "spotify", id: "4SN5Kkig8iJ8vdwsOoP7IO", storefront: "us" });
  });

  it("parses apple song page urls with storefront", () => {
    expect(parseTrackUrl("https://music.apple.com/gb/song/kingston/1443109064")).toEqual({
      provider: "apple",
      id: "1443109064",
      storefront: "gb",
    });
  });

  it("parses apple album deep links via ?i=", () => {
    expect(
      parseTrackUrl("https://music.apple.com/us/album/atlanta-millionaires-club/1443108737?i=1443109064"),
    ).toEqual({ provider: "apple", id: "1443109064", storefront: "us" });
  });

  it("rejects playlists, albums without ?i=, and junk", () => {
    expect(parseTrackUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")).toBeNull();
    expect(parseTrackUrl("https://music.apple.com/us/album/some-album/1443108737")).toBeNull();
    expect(parseTrackUrl("not a url")).toBeNull();
    expect(parseTrackUrl("https://example.com/track/abc")).toBeNull();
  });
});


it.each([
  "ftp://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO",
  "https://open.spotify.com/playlist/track/4SN5Kkig8iJ8vdwsOoP7IO",
  "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO/extra",
  "https://music.apple.com/us/artist/example/123?i=456",
])("rejects a non-track URL: %s", (url) => {
  expect(parseTrackUrl(url)).toBeNull();
});


it("builds canonical track and escaped search URLs", () => {
  expect(spotifyTrackUrl("4SN5Kkig8iJ8vdwsOoP7IO")).toBe("https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO");
  expect(appleTrackUrl("https://music.apple.com/us/album/x/123?i=1&foo=bar", "456")).toBe("https://music.apple.com/us/album/x/123?i=456&foo=bar");
  expect(spotifySearchUrl("A & B", "Artist")).toBe("https://open.spotify.com/search/A%20%26%20B%20Artist");
  expect(appleSearchUrl("A & B", "Artist")).toBe("https://music.apple.com/us/search?term=A%20%26%20B%20Artist");
});
