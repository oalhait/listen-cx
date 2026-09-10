import { describe, expect, it, vi } from "vitest";
import { SpotifyClient } from "./spotify.js";

const TRACK_ID = "4SN5Kkig8iJ8vdwsOoP7IO";

describe("SpotifyClient", () => {
  it("invokes fetchers without rebinding their receiver", async () => {
    const fetcher: typeof fetch = function (this: unknown, input) {
      expect(this).toBeUndefined();
      const url = String(input);
      if (url.includes("/oembed")) {
        return Promise.resolve(
          Response.json({ title: "Cataracts", thumbnail_url: "https://img.test/art.jpg" }),
        );
      }
      return Promise.resolve(
        new Response(
          `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
            props: {
              pageProps: {
                state: {
                  data: {
                    entity: {
                      type: "track",
                      id: TRACK_ID,
                      title: "Cataracts",
                      duration: 219823,
                      artists: [{ name: "Freddie Gibbs, Madlib" }],
                      visualIdentity: { image: [] },
                    },
                  },
                },
              },
            },
          })}</script>`,
        ),
      );
    };

    const track = await new SpotifyClient(fetcher).getTrack(TRACK_ID);
    expect(track?.title).toBe("Cataracts");
  });

  it("retries a transient metadata failure", async () => {
    let embedCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/oembed")) {
        return Response.json({ title: "Cataracts", thumbnail_url: null });
      }
      embedCalls += 1;
      if (embedCalls === 1) return new Response(null, { status: 503 });
      return new Response(
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
          props: {
            pageProps: {
              state: {
                data: {
                  entity: {
                    type: "track",
                    id: TRACK_ID,
                    title: "Cataracts",
                    duration: 219823,
                    artists: [{ name: "Freddie Gibbs, Madlib" }],
                    visualIdentity: { image: [] },
                  },
                },
              },
            },
          },
        })}</script>`,
      );
    });

    const track = await new SpotifyClient(fetcher).getTrack(TRACK_ID);

    expect(embedCalls).toBe(2);
    expect(track?.title).toBe("Cataracts");
  });
});

it("returns null when Spotify reports the track missing", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
  expect(await new SpotifyClient(fetcher).getTrack(TRACK_ID)).toBeNull();
});

it("rejects missing embed metadata instead of inventing a track", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => String(input).includes("/oembed")
    ? Response.json({ title: "Cataracts" }) : new Response("<html></html>"));
  await expect(new SpotifyClient(fetcher).getTrack(TRACK_ID)).rejects.toThrow("spotify embed metadata missing");
});
