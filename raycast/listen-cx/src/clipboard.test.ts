import { describe, expect, it } from "vitest";
import { clipboardSongUrl } from "./clipboard";

describe("clipboardSongUrl", () => {
  it("keeps a Spotify track URL", () => {
    expect(
      clipboardSongUrl(
        " https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC ",
      ),
    ).toBe("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  });

  it("keeps an Apple Music song URL", () => {
    expect(
      clipboardSongUrl("https://music.apple.com/us/song/song-name/123456"),
    ).toBe("https://music.apple.com/us/song/song-name/123456");
  });

  it("keeps supported Spotify and Apple deep links", () => {
    expect(
      clipboardSongUrl(
        "https://play.spotify.com/intl-en/track/4uLU6hMCjMI75M1A2tKUQC",
      ),
    ).toBe("https://play.spotify.com/intl-en/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(
      clipboardSongUrl(
        "https://itunes.apple.com/us/album/album-name/123456?i=789012",
      ),
    ).toBe("https://itunes.apple.com/us/album/album-name/123456?i=789012");
  });

  it("leaves unrelated clipboard text out of the form", () => {
    expect(clipboardSongUrl("Notes from a meeting")).toBe("");
  });

  it("leaves non-track provider URLs out of the form", () => {
    expect(clipboardSongUrl("https://open.spotify.com/album/abc123")).toBe("");
  });

  it("leaves malformed track IDs out of the form", () => {
    expect(clipboardSongUrl("https://open.spotify.com/track/abc123")).toBe("");
  });
});
