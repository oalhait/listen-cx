import { describe, expect, it, vi } from "vitest";
import { addSongToThread, parseThreadUrl, threadRequestKey } from "./thread";

const CAPABILITY = "abcdefghijklmnopqrstuv";
const SONG_URL = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";

describe("parseThreadUrl", () => {
  it("normalizes production, staging, and local Thread URLs", () => {
    expect(
      parseThreadUrl(`https://listen.cx/t/${CAPABILITY}#manage=private`),
    ).toEqual({
      publicUrl: `https://listen.cx/t/${CAPABILITY}`,
      contributionEndpoint: `https://listen.cx/api/threads/${CAPABILITY}/contributions`,
      origin: "https://listen.cx",
    });
    expect(
      parseThreadUrl(`https://staging.listen.cx/t/${CAPABILITY}`)?.publicUrl,
    ).toBe(`https://staging.listen.cx/t/${CAPABILITY}`);
    expect(
      parseThreadUrl(`http://127.0.0.1:8787/t/${CAPABILITY}`)?.publicUrl,
    ).toBe(`http://127.0.0.1:8787/t/${CAPABILITY}`);
  });

  it("rejects untrusted hosts and malformed Thread capabilities", () => {
    expect(parseThreadUrl(`https://example.com/t/${CAPABILITY}`)).toBeNull();
    expect(parseThreadUrl("https://listen.cx/t/too-short")).toBeNull();
    expect(
      parseThreadUrl(`https://listen.cx/api/threads/${CAPABILITY}`),
    ).toBeNull();
  });
});

describe("threadRequestKey", () => {
  it("is stable for the same Thread and song", async () => {
    const first = await threadRequestKey(
      `https://staging.listen.cx/t/${CAPABILITY}`,
      SONG_URL,
    );
    const second = await threadRequestKey(
      `https://staging.listen.cx/t/${CAPABILITY}#manage=private`,
      ` ${SONG_URL} `,
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^raycast-[a-f0-9]{64}$/);
  });

  it("is stable across equivalent provider share URLs", async () => {
    const spotify = await Promise.all([
      threadRequestKey(
        `https://listen.cx/t/${CAPABILITY}`,
        `${SONG_URL}?si=first#fragment`,
      ),
      threadRequestKey(
        `https://listen.cx/t/${CAPABILITY}`,
        "https://play.spotify.com/intl-en/track/4uLU6hMCjMI75M1A2tKUQC?si=second",
      ),
    ]);
    const apple = await Promise.all([
      threadRequestKey(
        `https://listen.cx/t/${CAPABILITY}`,
        "https://music.apple.com/us/song/song-name/123456?at=affiliate",
      ),
      threadRequestKey(
        `https://listen.cx/t/${CAPABILITY}`,
        "https://itunes.apple.com/us/album/album-name/999999?i=123456",
      ),
    ]);

    expect(spotify[0]).toBe(spotify[1]);
    expect(apple[0]).toBe(apple[1]);
  });

  it("changes when the Thread or song changes", async () => {
    const first = await threadRequestKey(
      `https://staging.listen.cx/t/${CAPABILITY}`,
      SONG_URL,
    );
    const second = await threadRequestKey(
      `https://staging.listen.cx/t/${CAPABILITY}`,
      "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
    );

    expect(first).not.toBe(second);
  });
});

describe("addSongToThread", () => {
  it("posts a song with the Thread mutation contract", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "accepted", contributionId: "song-1" }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(
      addSongToThread(
        `https://staging.listen.cx/t/${CAPABILITY}`,
        SONG_URL,
        "request-1",
        fetcher,
      ),
    ).resolves.toBe("accepted");
    expect(fetcher).toHaveBeenCalledWith(
      `https://staging.listen.cx/api/threads/${CAPABILITY}/contributions`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://staging.listen.cx",
          "x-listen-action": "add-song",
        },
        body: JSON.stringify({ url: SONG_URL, requestKey: "request-1" }),
      }),
    );
  });

  it("returns existing contributions as a successful result", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ status: "existing", contributionId: "song-1" }),
        ),
      );

    await expect(
      addSongToThread(
        `https://listen.cx/t/${CAPABILITY}`,
        SONG_URL,
        "request-1",
        fetcher,
      ),
    ).resolves.toBe("existing");
  });

  it("surfaces API errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Thread not found." }), {
        status: 404,
      }),
    );

    await expect(
      addSongToThread(
        `https://listen.cx/t/${CAPABILITY}`,
        SONG_URL,
        "request-1",
        fetcher,
      ),
    ).rejects.toThrow("Thread not found.");
  });

  it.each(["TimeoutError", "AbortError"])(
    "translates %s into a retryable timeout",
    async (name) => {
      const fetcher = vi
        .fn()
        .mockRejectedValue(new DOMException("timed out", name));

      await expect(
        addSongToThread(
          `https://listen.cx/t/${CAPABILITY}`,
          SONG_URL,
          "request-1",
          fetcher,
        ),
      ).rejects.toThrow("The Thread took too long to respond. Try again.");
    },
  );
});
