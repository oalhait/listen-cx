import { describe, expect, it } from "vitest";
import { normalizeThreadTitle, normalizeRequestKey, isThreadCapability, mutationFingerprint, verifiedSource, desiredState } from "./thread.js";
import type { Resolved } from "./resolve.js";

const track: Resolved = { title: "Song", artist: "Artist", artworkUrl: null, isrc: null, complete: false, spotifyUrl: "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO", appleUrl: null };

describe("Thread contracts", () => {
  it("normalizes bounded titles and request keys", () => {
    expect(normalizeThreadTitle("  Road trip  ")).toBe("Road trip");
    expect(normalizeRequestKey("retry-123")).toBe("retry-123");
    for (const title of ["", " ", "x".repeat(81), "line\nbreak"]) expect(() => normalizeThreadTitle(title)).toThrow();
    for (const key of ["", "x".repeat(129), "key\u0000"]) expect(() => normalizeRequestKey(key)).toThrow();
  });
  it("requires historical 22-character capabilities", () => {
    expect(isThreadCapability("abcdefghijklmnopqrstuv")).toBe(true);
    expect(isThreadCapability("short")).toBe(false);
    expect(isThreadCapability("/".repeat(22))).toBe(false);
  });
  it("fingerprints intent independently of the revision used to retry", async () => {
    expect(await mutationFingerprint({ kind: "reorder", ids: [1, 2] })).not.toBe(await mutationFingerprint({ kind: "reorder", ids: [2, 1] }));
    expect(await mutationFingerprint({ kind: "close" })).toBe(await mutationFingerprint({ kind: "close" }));
  });
  it("verifies the resolved catalog identity only for the input provider", () => {
    expect(verifiedSource("https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO", track)).toMatchObject({ provider: "spotify", id: "4SN5Kkig8iJ8vdwsOoP7IO" });
    expect(() => verifiedSource("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", track)).toThrow();
    expect(() => verifiedSource("https://music.apple.com/us/song/123", track)).toThrow();
  });
  it("keeps unresolved and legacy songs in the desired provider order", () => {
    const snapshot = { publicCapability: "abcdefghijklmnopqrstuv", title: "Road trip", revision: 4, closedAt: null, contributions: [
      { id: 7, title: "Apple song", artist: "A", linkSlug: "2345678", artworkUrl: null, source: { provider: "apple" as const, id: "123", storefront: "gb", verified: true } },
      { id: 9, title: "Spotify song", artist: "B", linkSlug: "2345679", artworkUrl: null, source: { provider: "spotify" as const, id: "4SN5Kkig8iJ8vdwsOoP7IO", storefront: "us", verified: true } },
      { id: 10, title: "Legacy song", artist: "C", linkSlug: "234567a", artworkUrl: null, source: { provider: "spotify" as const, id: "4uLU6hMCjMI75M1A2tKUQC", storefront: "us", verified: false } },
    ], publications: [] };
    const state = desiredState(snapshot, "spotify");
    expect(state.revision).toBe(4);
    expect(state.entries.map(entry => entry.contributionId)).toEqual([7, 9, 10]);
    expect(state.entries.map(entry => entry.identity.status)).toEqual(["unresolved", "verified", "unresolved"]);
    expect(state.identitiesComplete).toBe(false);
    expect(state.entries[0]?.identity).not.toHaveProperty("id");
  });
});
