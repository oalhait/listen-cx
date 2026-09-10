import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1LinkStore } from "./db.js";
import { D1JamStore } from "./jam-db.js";
import { fingerprintJamContributionInput } from "./jam.js";
import {
  addTrackToJam,
  createJam,
  type JamActions,
} from "./jams.js";
import type { Resolved } from "./resolve.js";

const TRACK_URL = "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO";
const TRACK: Resolved = {
  isrc: null,
  complete: false,
  title: "Cataracts",
  artist: "Freddie Gibbs, Madlib",
  artworkUrl: null,
  spotifyUrl: TRACK_URL,
  appleUrl: null,
};

const resolver = { resolve: vi.fn().mockResolvedValue(TRACK) };
const store = new D1LinkStore(env.DB);
const jamStore = new D1JamStore(env.DB, { maxJams: 100 });
const actions = {
  resolver,
  store,
  jamStore,
  jamsEnabled: true,
  baseUrl: "https://listen.test",
} satisfies JamActions;

async function countRows(table: "links" | "thread_contributions"): Promise<number> {
  const result = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

async function createTestJam(): Promise<string> {
  return (await createJam(actions, "Race test")).jamId;
}

describe("Jam link cleanup", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    resolver.resolve.mockReset().mockResolvedValue(TRACK);
    await env.DB.prepare("DELETE FROM thread_contributions").run();
    await env.DB.prepare("DELETE FROM threads").run();
    await env.DB.prepare("DELETE FROM links").run();
  });

  it("rejects disabled Jam actions before touching storage or providers", async () => {
    const create = vi.spyOn(jamStore, "create");
    const preflight = vi.spyOn(jamStore, "preflightContribution");
    const disabledActions = { ...actions, jamsEnabled: false };

    await expect(createJam(disabledActions, "Disabled")).rejects.toMatchObject({
      code: "jams_disabled",
    });
    await expect(
      addTrackToJam(disabledActions, "invalid", TRACK_URL, "disabled-operation"),
    ).rejects.toMatchObject({ code: "jams_disabled" });
    expect(create).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("keeps one contribution and one link under concurrent identical requests", async () => {
    const jamId = await createTestJam();

    const results = await Promise.all([
      addTrackToJam(actions, jamId, TRACK_URL, "same-operation"),
      addTrackToJam(actions, jamId, TRACK_URL, "same-operation"),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["accepted", "existing"]);
    expect(await countRows("thread_contributions")).toBe(1);
    expect(await countRows("links")).toBe(1);
  });

  it("preserves a committed link when acceptance throws after the commit", async () => {
    const jamId = await createTestJam();
    const acceptContribution = jamStore.acceptContribution.bind(jamStore);
    vi.spyOn(jamStore, "acceptContribution").mockImplementationOnce(async (...args) => {
      const result = await acceptContribution(...args);
      expect(result.status).toBe("accepted");
      throw new Error("ambiguous post-commit failure");
    });

    await expect(
      addTrackToJam(actions, jamId, TRACK_URL, "ambiguous-operation"),
    ).rejects.toMatchObject({ code: "jam_storage_unavailable" });
    expect(await countRows("thread_contributions")).toBe(1);
    expect(await countRows("links")).toBe(1);

    await expect(
      addTrackToJam(actions, jamId, TRACK_URL, "ambiguous-operation"),
    ).resolves.toMatchObject({ status: "existing", position: 1 });
    expect(await countRows("links")).toBe(1);
  });

  it("removes a newly created link when acceptance fails before committing", async () => {
    const jamId = await createTestJam();
    vi.spyOn(jamStore, "acceptContribution").mockRejectedValueOnce(
      new Error("pre-commit failure"),
    );

    await expect(
      addTrackToJam(actions, jamId, TRACK_URL, "failed-operation"),
    ).rejects.toMatchObject({ code: "jam_storage_unavailable" });
    expect(await countRows("thread_contributions")).toBe(0);
    expect(await countRows("links")).toBe(0);
  });

  it("does not let cleanup failure mask the authoritative Jam error", async () => {
    const jamId = await createTestJam();
    vi.spyOn(jamStore, "acceptContribution").mockResolvedValueOnce({ status: "closed" });
    vi.spyOn(store, "deleteIfUnreferenced").mockRejectedValueOnce(
      new Error("cleanup unavailable"),
    );

    await expect(
      addTrackToJam(actions, jamId, TRACK_URL, "cleanup-failure"),
    ).rejects.toMatchObject({ code: "jam_closed" });
  });

  it("removes a race-loser link when acceptance finds an existing request", async () => {
    const jamId = await createTestJam();
    await addTrackToJam(actions, jamId, TRACK_URL, "existing-operation");
    const fingerprint = await fingerprintJamContributionInput({
      sourceProvider: "spotify",
      sourceCatalogId: "4SN5Kkig8iJ8vdwsOoP7IO",
      sourceStorefront: "us",
    });
    const existing = await jamStore.preflightContribution(
      jamId,
      "existing-operation",
      fingerprint,
    );
    if (existing.status !== "existing") throw new Error("Contribution not found");
    vi.spyOn(jamStore, "preflightContribution").mockResolvedValueOnce({ status: "continue" });
    vi.spyOn(jamStore, "acceptContribution").mockResolvedValueOnce(existing);

    await expect(
      addTrackToJam(actions, jamId, TRACK_URL, "existing-operation"),
    ).resolves.toMatchObject({ status: "existing" });
    expect(await countRows("thread_contributions")).toBe(1);
    expect(await countRows("links")).toBe(1);
  });

  it.each([
    ["conflict", "request_key_conflict"],
    ["full", "jam_full"],
    ["closed", "jam_closed"],
    ["limit_reached", "jam_contribution_limit_reached"],
    ["not_found", "jam_not_found"],
  ] as const)("removes a new link when acceptance returns %s", async (status, code) => {
    const jamId = await createTestJam();
    vi.spyOn(jamStore, "acceptContribution").mockResolvedValueOnce({ status });

    await expect(
      addTrackToJam(actions, jamId, TRACK_URL, `rejected-${status}`),
    ).rejects.toMatchObject({ code });
    expect(await countRows("thread_contributions")).toBe(0);
    expect(await countRows("links")).toBe(0);
  });
});
