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
          Response.json({ title: "Kingston", thumbnail_url: "https://img.test/art.jpg" }),
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
                      title: "Kingston",
                      duration: 202000,
                      artists: [{ name: "Faye Webster" }],
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
    expect(track?.title).toBe("Kingston");
  });

  it("retries a transient metadata failure", async () => {
    let embedCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/oembed")) {
        return Response.json({ title: "Kingston", thumbnail_url: null });
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
                    title: "Kingston",
                    duration: 202000,
                    artists: [{ name: "Faye Webster" }],
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
    expect(track?.title).toBe("Kingston");
  });
});
