import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { D1ThreadStore } from "./thread-db.js";
import { authorizeManagementCapability } from "./thread-security.js";
import { mutationFingerprint } from "./thread.js";
import type { Resolved } from "./resolve.js";

const store = new D1ThreadStore(env.DB);
const spotify = { provider: "spotify" as const, id: "4SN5Kkig8iJ8vdwsOoP7IO", storefront: "us" };
const track: Resolved = { title: "Cataracts", artist: "Freddie Gibbs, Madlib", artworkUrl: null, spotifyUrl: `https://open.spotify.com/track/${spotify.id}`, appleUrl: null, isrc: null, complete: false };
const add = (cap: string, revision: number, key = nanoid()) => store.add(cap, { expectedRevision: revision, requestKey: key, source: spotify, track });
async function setup() {
  const key = nanoid(22);
  const view = await store.create("Road trip", key);
  const authorization = await authorizeManagementCapability(store, view.publicCapability, key);
  if (!authorization) throw new Error("setup authorization failed");
  return { view, key, authorization };
}

describe("durable Thread mutations", () => {
  it("creates with a private capability and replays creation without duplicating rows", async () => {
    const key = nanoid(22);
    const first = await store.create("  Road trip ", key);
    const second = await store.create("Road trip", key);
    expect(second).toEqual(first);
    expect(first.revision).toBe(0);
    expect(JSON.stringify(first)).not.toContain(key);
    expect(JSON.stringify(first)).not.toContain("management_digest");
    await expect(store.create("Different", key)).rejects.toMatchObject({ code: "request_conflict" });
  });

  it("durably adds, reorders, removes and closes with one revision per accepted mutation", async () => {
    const { view, authorization } = await setup();
    await add(view.publicCapability, 0);
    await add(view.publicCapability, 1);
    let current = (await store.get(view.publicCapability))!;
    const ids = current.contributions.map(song => song.id);
    expect(current.revision).toBe(2);
    await store.manage(authorization, { kind: "reorder", ids: [...ids].reverse(), requestKey: "order", expectedRevision: 2 });
    current = (await new D1ThreadStore(env.DB).get(view.publicCapability))!;
    expect(current.contributions.map(song => song.id)).toEqual([...ids].reverse());
    expect(current.revision).toBe(3);
    await store.manage(authorization, { kind: "remove", id: ids[0]!, requestKey: "remove", expectedRevision: 3 });
    await store.manage(authorization, { kind: "close", requestKey: "close", expectedRevision: 4 });
    current = (await store.get(view.publicCapability))!;
    expect(current.revision).toBe(5);
    expect(current.closedAt).not.toBeNull();
    expect(current.contributions.map(song => song.id)).toEqual([ids[1]]);
    for (const publication of current.publications) {
      expect(publication).toMatchObject({ requestedRevision: 5, appliedRevision: null, status: "blocked", verifiedPlaylistId: null });
    }
    await expect(add(view.publicCapability, 5)).rejects.toMatchObject({ code: "closed" });
  });

  it("replays an add after removal without restoring it or contacting a provider", async () => {
    const { view, authorization } = await setup();
    const first = await add(view.publicCapability, 0, "same-key");
    const current = (await store.get(view.publicCapability))!;
    await store.manage(authorization, { kind: "remove", id: current.contributions[0]!.id, expectedRevision: 1, requestKey: "remove" });
    const replay = await add(view.publicCapability, 0, "same-key");
    expect(replay).toMatchObject({ revision: first.revision, replayed: true });
    const after = (await store.get(view.publicCapability))!;
    expect(after.revision).toBe(2);
    expect(after.contributions).toEqual([]);
    const fingerprint = await mutationFingerprint({ kind: "add", source: spotify });
    expect(await store.preflight(view.publicCapability, "same-key", fingerprint, 0)).toMatchObject({ replayed: true });
  });

  it("allows only one concurrent mutation at an expected revision and safely retries the loser", async () => {
    const { view } = await setup();
    const results = await Promise.allSettled([add(view.publicCapability, 0, "a"), add(view.publicCapability, 0, "b")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "stale_revision" } });
    const retryKey = results[0]?.status === "rejected" ? "a" : "b";
    await add(view.publicCapability, 1, retryKey);
    const current = (await store.get(view.publicCapability))!;
    expect(current.revision).toBe(2);
    expect(current.contributions).toHaveLength(2);
  });

  it("replays a request that finishes between preflight and the snapshot read", async () => {
    const { view } = await setup();
    const originalGet = store.get.bind(store);
    const spy = vi.spyOn(store, "get").mockImplementationOnce(async capability => {
      await add(capability, 0, "between-reads");
      return originalGet(capability);
    });
    try {
      expect(await add(view.publicCapability, 0, "between-reads")).toMatchObject({ revision: 1, replayed: true });
      expect((await originalGet(view.publicCapability))!.contributions).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns one receipt and one song for concurrent identical retries", async () => {
    const { view } = await setup();
    const results = await Promise.all([add(view.publicCapability, 0, "same"), add(view.publicCapability, 0, "same")]);
    expect(results.map(result => result.revision)).toEqual([1, 1]);
    expect((await store.get(view.publicCapability))!.contributions).toHaveLength(1);
  });

  it("rejects mismatched replay intent, incomplete orders and other Thread IDs", async () => {
    const { view, authorization } = await setup();
    const other = await setup();
    await add(view.publicCapability, 0, "song");
    await add(other.view.publicCapability, 0);
    const otherId = (await store.get(other.view.publicCapability))!.contributions[0]!.id;
    await expect(store.manage(authorization, { kind: "close", requestKey: "song", expectedRevision: 1 })).rejects.toMatchObject({ code: "request_conflict" });
    await expect(store.manage(authorization, { kind: "reorder", ids: [], requestKey: "incomplete", expectedRevision: 1 })).rejects.toMatchObject({ code: "invalid_order" });
    await expect(store.manage(authorization, { kind: "remove", id: otherId, requestKey: "other", expectedRevision: 1 })).rejects.toMatchObject({ code: "contribution_not_found" });
    expect((await store.get(view.publicCapability))!.revision).toBe(1);
  });

  it("rolls back the revision and receipt if a database write fails", async () => {
    const { view } = await setup();
    await env.DB.exec("CREATE TRIGGER test_reject_contribution BEFORE INSERT ON thread_contributions BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    try {
      await expect(add(view.publicCapability, 0, "retryable")).rejects.toThrow();
      expect((await store.get(view.publicCapability))!.revision).toBe(0);
    } finally {
      await env.DB.exec("DROP TRIGGER test_reject_contribution");
    }
    expect(await add(view.publicCapability, 0, "retryable")).toMatchObject({ revision: 1, replayed: false });
  });

  it("cannot mark a publication synced without an applied revision and verified playlist ID", async () => {
    const { view } = await setup();
    await expect(env.DB.prepare(`UPDATE thread_publications SET status = 'synced'
      WHERE thread_id = (SELECT id FROM threads WHERE public_capability = ?)`)
      .bind(view.publicCapability).run()).rejects.toThrow();
    const state = (await store.getDesiredState(view.publicCapability, "spotify"))!;
    expect(state.publication).toMatchObject({ requestedRevision: 0, appliedRevision: null, status: "blocked", verifiedPlaylistId: null });
  });

  it("preserves legacy rows while keeping their catalog verification unresolved", async () => {
    const cap = nanoid(22);
    await env.DB.prepare("INSERT INTO threads(public_capability, management_digest, title) VALUES (?, ?, 'Legacy')").bind(cap, "a".repeat(64)).run();
    await env.DB.prepare("INSERT INTO links(slug, title, artist) VALUES ('legacy1', 'Old song', 'Artist')").run();
    await env.DB.prepare(`INSERT INTO thread_contributions(thread_id, link_slug, request_key, input_fingerprint, source_provider, source_catalog_id, source_storefront, position) SELECT id, 'legacy1', 'old', 'hash', 'spotify', ?, 'us', 1 FROM threads WHERE public_capability = ?`).bind(spotify.id, cap).run();
    const current = (await store.get(cap))!;
    expect(current.contributions[0]?.source.verified).toBe(false);
    expect((await store.getDesiredState(cap, "spotify"))!.entries[0]?.identity.status).toBe("unresolved");
  });
});

describe("Thread provider connections", () => {
  it("locks remove and reorder after Apple connects, but still accepts additions and close", async () => {
    const { view, authorization } = await setup();
    await add(view.publicCapability, 0);
    const id = (await store.get(view.publicCapability))!.contributions[0]!.id;
    await store.manage(authorization, { kind: "connect", provider: "apple", requestKey: "connect", expectedRevision: 1 });
    expect((await store.get(view.publicCapability))!.publications.find(p => p.provider === "apple")).toMatchObject({ connected: true, status: "pending", requestedRevision: 2 });
    for (const intent of [{ kind: "remove" as const, id }, { kind: "reorder" as const, ids: [id] }]) {
      await expect(store.manage(authorization, { ...intent, requestKey: intent.kind, expectedRevision: 2 })).rejects.toMatchObject({ code: "apple_append_only" });
    }
    expect((await store.get(view.publicCapability))!.revision).toBe(2);
    await add(view.publicCapability, 2);
    await store.manage(authorization, { kind: "close", requestKey: "close", expectedRevision: 3 });
    expect((await store.get(view.publicCapability))!.revision).toBe(4);
  });

  it("keeps Spotify editable and replays earlier edits after Apple connects", async () => {
    const { view, authorization } = await setup();
    await add(view.publicCapability, 0);
    const id = (await store.get(view.publicCapability))!.contributions[0]!.id;
    await store.manage(authorization, { kind: "connect", provider: "spotify", requestKey: "spotify", expectedRevision: 1 });
    const remove = { kind: "remove" as const, id, requestKey: "remove", expectedRevision: 2 };
    await store.manage(authorization, remove);
    await store.manage(authorization, { kind: "connect", provider: "apple", requestKey: "apple", expectedRevision: 3 });
    expect(await store.manage(authorization, remove)).toEqual({ revision: 3, replayed: true });
    expect((await store.get(view.publicCapability))!.revision).toBe(4);
  });

  it("serializes a connection racing an edit and never exposes private publisher keys", async () => {
    const { view, authorization } = await setup();
    await add(view.publicCapability, 0);
    const id = (await store.get(view.publicCapability))!.contributions[0]!.id;
    const results = await Promise.allSettled([
      store.manage(authorization, { kind: "connect", provider: "apple", requestKey: "connect", expectedRevision: 1 }),
      store.manage(authorization, { kind: "remove", id, requestKey: "remove", expectedRevision: 1 }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const current = (await store.get(view.publicCapability))!;
    expect(current.revision).toBe(2);
    expect(JSON.stringify(current)).not.toContain("publisherKey");
    expect(JSON.stringify(current)).not.toContain("publisher_key");
  });
});
