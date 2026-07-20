import { describe, expect, it, vi } from "vitest";
import { createListenLink } from "./api";

describe("createListenLink", () => {
  it("posts the clipboard URL and returns the generated link", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ link: "https://listen.cx/Abc2345" }), {
        status: 200,
      }),
    );

    await expect(
      createListenLink("https://open.spotify.com/track/abc", fetcher),
    ).resolves.toBe("https://listen.cx/Abc2345");
    expect(fetcher).toHaveBeenCalledWith(
      "https://listen.cx/create",
      expect.objectContaining({
        body: JSON.stringify({ url: "https://open.spotify.com/track/abc" }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("surfaces the service error when link creation fails", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "That doesn't look like a Spotify or Apple Music track link.",
        }),
        {
          status: 422,
        },
      ),
    );

    await expect(createListenLink("not a music URL", fetcher)).rejects.toThrow(
      "That doesn't look like a Spotify or Apple Music track link.",
    );
  });

  it("rejects malformed successful responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ slug: "Abc2345" })));

    await expect(
      createListenLink("https://music.apple.com/us/song/example/1", fetcher),
    ).rejects.toThrow("listen.cx returned an invalid response.");
  });

  it("returns a helpful error when the request times out", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(new DOMException("Timed out", "TimeoutError"));

    await expect(
      createListenLink(
        "https://open.spotify.com/track/abc",
        fetcher,
        AbortSignal.abort(new DOMException("Timed out", "TimeoutError")),
      ),
    ).rejects.toThrow("listen.cx took too long to respond. Try again.");
  });
});
