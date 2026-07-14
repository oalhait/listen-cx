import { describe, expect, it, vi } from "vitest";
import { ItunesClient } from "./itunes.js";

const RESULT = {
  wrapperType: "track",
  trackId: 1172853943,
  trackName: "Every Single Thing",
  artistName: "HOMESHAKE",
  trackTimeMillis: 155527,
  trackViewUrl: "https://music.apple.com/us/album/every-single-thing/1172852865?i=1172853943",
  artworkUrl100: "https://img.test/100x100bb.jpg",
};

describe("ItunesClient", () => {
  it("retries a transient search failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ results: [RESULT] }));

    const tracks = await new ItunesClient(fetcher).searchTracks("Every Single Thing", "HOMESHAKE");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tracks[0]?.title).toBe("Every Single Thing");
  });

  it("falls back to Apple Music page metadata when lookup is forbidden", async () => {
    const schema = {
      "@type": "https://schema.org/MusicComposition",
      name: "Always Lone",
      url: "https://music.apple.com/us/song/always-lone/1720804670",
      timeRequired: "PT3M14S",
      image: "https://img.test/always-lone.jpg",
      audio: {
        "@type": "MusicRecording",
        name: "Always Lone",
        duration: "PT3M14S",
        image: "https://img.test/always-lone.jpg",
        byArtist: [{ "@type": "MusicGroup", name: "Men I Trust" }],
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          `<script id="schema:music" type="application/ld+json">${JSON.stringify(schema)}</script>`,
        ),
      );

    const track = await new ItunesClient(fetcher).lookupById("1720804670", "us");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "https://music.apple.com/us/song/x/1720804670",
    );
    expect(track).toEqual({
      trackId: 1720804670,
      title: "Always Lone",
      artist: "Men I Trust",
      durationMs: 194000,
      trackViewUrl: "https://music.apple.com/us/song/always-lone/1720804670",
      artworkUrl: "https://img.test/always-lone.jpg",
    });
  });
});
