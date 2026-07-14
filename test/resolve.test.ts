import { describe, it, expect } from "vitest";
import { parseTrackUrl } from "../src/urls.js";
import { Resolver } from "../src/resolve.js";
import { SpotifyClient } from "../src/spotify.js";
import { ItunesClient } from "../src/itunes.js";

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

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const text = typeof body === "string" ? body : JSON.stringify(body);
        return new Response(text, {
          status: 200,
          headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json" },
        });
      }
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const SPOTIFY_OEMBED = {
  title: "Kingston",
  thumbnail_url: "https://img/spotify.jpg",
};

const SPOTIFY_EMBED = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      state: {
        data: {
          entity: {
            type: "track",
            id: "4uLU6hMCjMI75M1A2tKUQC",
            title: "Kingston",
            artists: [{ name: "Faye Webster" }],
            duration: 230000,
            visualIdentity: { image: [{ url: "https://img/spotify.jpg" }] },
          },
        },
      },
    },
  },
})}</script>`;

const INVALID_SPOTIFY_EMBED = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      state: {
        data: {
          entity: {
            type: "track",
            id: "4uLU6hMCjMI75M1A2tKUQC",
            title: "Kingston",
            artists: [{ name: "Faye Webster" }],
            duration: -1,
          },
        },
      },
    },
  },
})}</script>`;

const ITUNES_SONG = {
  wrapperType: "track",
  trackId: 1443109064,
  trackName: "Kingston",
  artistName: "Faye Webster",
  trackTimeMillis: 230500,
  trackViewUrl: "https://music.apple.com/us/album/kingston/1443108737?i=1443109064",
  artworkUrl100: "https://img/apple100x100.jpg",
};

describe("Resolver: spotify inbound", () => {
  it("resolves public embed metadata to a conservative apple match", async () => {
    const f = mockFetch({
      "https://open.spotify.com/oembed": SPOTIFY_OEMBED,
      "https://open.spotify.com/embed/track/": SPOTIFY_EMBED,
      "https://itunes.apple.com/search": { results: [ITUNES_SONG] },
    });
    const r = new Resolver(new SpotifyClient(f), new ItunesClient(f));
    const out = await r.resolve("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(out).toMatchObject({
      complete: false,
      isrc: null,
      title: "Kingston",
      artist: "Faye Webster",
      spotifyUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      appleUrl: ITUNES_SONG.trackViewUrl,
    });
    expect(out!.artworkUrl).toBe("https://img/spotify.jpg");
  });

  it("chooses the highest-likelihood apple candidate", async () => {
    const unrelated = {
      ...ITUNES_SONG,
      trackId: 1,
      artistName: "Different Artist",
      trackViewUrl: "https://music.apple.com/unrelated",
    };
    const instrumental = {
      ...ITUNES_SONG,
      trackId: 2,
      trackName: "Kingston (Instrumental)",
      trackViewUrl: "https://music.apple.com/instrumental",
    };
    const f = mockFetch({
      "https://open.spotify.com/oembed": SPOTIFY_OEMBED,
      "https://open.spotify.com/embed/track/": SPOTIFY_EMBED,
      "https://itunes.apple.com/search": { results: [unrelated, instrumental] },
    });
    const r = new Resolver(new SpotifyClient(f), new ItunesClient(f));
    const out = await r.resolve("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(out!.complete).toBe(false);
    expect(out!.appleUrl).toBe(instrumental.trackViewUrl);
  });

  it("rejects malformed public embed metadata", async () => {
    const f = mockFetch({
      "https://open.spotify.com/oembed": SPOTIFY_OEMBED,
      "https://open.spotify.com/embed/track/": INVALID_SPOTIFY_EMBED,
    });
    const spotify = new SpotifyClient(f);
    await expect(spotify.getTrack("4uLU6hMCjMI75M1A2tKUQC")).rejects.toThrow(
      "spotify embed duration invalid",
    );
  });
});

describe("Resolver: apple inbound", () => {
  it("returns apple metadata without requiring spotify credentials", async () => {
    const f = mockFetch({
      "https://itunes.apple.com/lookup?id=": { results: [ITUNES_SONG] },
    });
    const r = new Resolver(new SpotifyClient(f), new ItunesClient(f));
    const out = await r.resolve("https://music.apple.com/us/song/kingston/1443109064");
    expect(out).toMatchObject({
      complete: false,
      isrc: null,
      spotifyUrl: null,
      appleUrl: ITUNES_SONG.trackViewUrl,
    });
  });
});
