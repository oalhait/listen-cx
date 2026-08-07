import { describe, expect, it, vi } from "vitest";
import { loadAddToThreadDefaults } from "./add-to-thread-defaults";

const SONG_URL = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";

describe("loadAddToThreadDefaults", () => {
  it("still prefills the clipboard song when remembered storage fails", async () => {
    await expect(
      loadAddToThreadDefaults(
        vi.fn().mockResolvedValue(SONG_URL),
        vi.fn().mockRejectedValue(new Error("storage unavailable")),
      ),
    ).resolves.toEqual({ threadUrl: "", songUrl: SONG_URL });
  });
});
