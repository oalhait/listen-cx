import { describe, expect, it, vi } from "vitest";
import { ItunesClient } from "./itunes.js";
import { Resolver } from "./resolve.js";
import { SpotifyClient } from "./spotify.js";

const TRACK_ID = "3sFoSCg2KoaCUrOeKYMqvI";

const SPOTIFY_EMBED = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      state: {
        data: {
          entity: {
            type: "track",
            id: TRACK_ID,
            title: "Who Can I Run To",
            artists: [{ name: "The Jones Girls" }],
            duration: 204720,
            visualIdentity: { image: [] },
          },
        },
      },
    },
  },
})}</script>`;

describe("Resolver", () => {
  it("creates a spotify-backed link when apple matching is rate-limited", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/oembed")) {
        return Response.json({
          title: "Who Can I Run To",
          thumbnail_url: "https://img.test/art.jpg",
        });
      }
      if (url.includes("/embed/track/")) return new Response(SPOTIFY_EMBED);
      return new Response(null, { status: 429 });
    });
    const resolver = new Resolver(new SpotifyClient(fetcher), new ItunesClient(fetcher));

    await expect(
      resolver.resolve(`https://open.spotify.com/track/${TRACK_ID}`),
    ).resolves.toMatchObject({
      title: "Who Can I Run To",
      artist: "The Jones Girls",
      spotifyUrl: `https://open.spotify.com/track/${TRACK_ID}`,
      appleUrl: null,
      complete: false,
    });
  });
});
