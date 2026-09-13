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
      if (!url.includes('/embed/')) return Promise.resolve(new Response('<meta property="og:description" content="Freddie Gibbs, Madlib · Piñata · Song · 2014">'));
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
      if (!url.includes('/embed/')) return new Response('<meta property="og:description" content="Freddie Gibbs, Madlib · Piñata · Song · 2014">');
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


it("retains explicit and playable facts from public embed metadata", async () => {
  const fetcher = vi.fn<typeof fetch>(async input => String(input).includes('/oembed') ? Response.json({ title: 'Song' })
    : new Response('<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { state: { data: { entity: {
      type: 'track', id: TRACK_ID, title: 'Song', duration: 180000, artists: [{ name: 'Artist' }], isExplicit: true, isPlayable: true,
    } } } } } }) + '</script>'));
  expect(await new SpotifyClient(fetcher).getTrack(TRACK_ID)).toMatchObject({ explicit: true, playable: true });
});

it("retains the official album from the public track page", async () => {
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.includes('/oembed')) return Response.json({ title: 'Faneto' });
    if (url.includes('/embed/')) return new Response('<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { state: { data: { entity: {
      type: 'track', id: TRACK_ID, title: 'Faneto', duration: 206654, artists: [{ name: 'Chief Keef' }], isExplicit: true, isPlayable: true,
    } } } } } }) + '</script>');
    return new Response(`<meta property="og:url" content="https://open.spotify.com/track/${TRACK_ID}"><meta property="og:description" content="Chief Keef · Back from the Dead 2 · Song · 2015"><meta name="music:release_date" content="2015-06-16">`);
  });

  expect(await new SpotifyClient(fetcher).getTrack(TRACK_ID)).toMatchObject({ album: 'Back from the Dead 2', releaseDate: '2015-06-16' });
});

it("rejects album metadata from a wrong or malformed canonical page", async () => {
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.includes('/oembed')) return Response.json({ title: 'Song' });
    if (!url.includes('/embed/')) return new Response('<meta property="og:url" content="https://open.spotify.com/track/wrong"><meta property="og:description" content="Artist · &#999999999; · Song · 2026">');
    return new Response('<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { state: { data: { entity: {
      type: 'track', id: TRACK_ID, title: 'Song', duration: 180000, artists: [{ name: 'Artist' }], isExplicit: false, isPlayable: true,
    } } } } } }) + '</script>');
  });

  expect(await new SpotifyClient(fetcher).getTrack(TRACK_ID)).toMatchObject({ title: 'Song', album: null, releaseDate: null });
});

it.each([
  () => Promise.resolve(new Response(null, { status: 403 })),
  () => Promise.resolve(new Response('x'.repeat(512_001))),
])("keeps primary embed metadata when the optional track page is unavailable", async page => {
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.includes('/oembed')) return Response.json({ title: 'Song' });
    if (!url.includes('/embed/')) return page();
    return new Response('<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { state: { data: { entity: {
      type: 'track', id: TRACK_ID, title: 'Song', duration: 180000, artists: [{ name: 'Artist' }], isExplicit: false, isPlayable: true,
    } } } } } }) + '</script>');
  });

  expect(await new SpotifyClient(fetcher).getTrack(TRACK_ID)).toMatchObject({ title: 'Song', album: null });
});

it("bounds optional page failures without losing primary metadata", async () => {
  let pageCalls = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes('/oembed')) return Response.json({ title: 'Song' });
    if (url.includes('/embed/')) return new Response('<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { state: { data: { entity: {
      type: 'track', id: TRACK_ID, title: 'Song', duration: 180000, artists: [{ name: 'Artist' }], isExplicit: false, isPlayable: true,
    } } } } } }) + '</script>');
    pageCalls += 1;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    throw new TypeError('offline');
  });

  expect(await new SpotifyClient(fetcher).getTrack(TRACK_ID)).toMatchObject({ title: 'Song', album: null });
  expect(pageCalls).toBe(3);
});
