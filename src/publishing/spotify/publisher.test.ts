import { describe, expect, it, vi } from "vitest";
import { SpotifyPublisher, type Destination } from "./publisher";

const A = "A".repeat(22), B = "B".repeat(22), C = "C".repeat(22), D = "D".repeat(22);
const playlistId = "P".repeat(22);
const desired = (revision = 1, trackIds = [A, B, C]) => ({ playlistKey: "acceptance", revision, trackIds });

function fixture() {
  const rows = new Map<string, Destination>();
  let tracks: string[] = [];
  let marker = "";
  let snapshot = 0;
  let now = 1_000;
  const calls: { path: string; method: string; body: any }[] = [];
  const faults: ((path: string, method: string, body: any) => Response | undefined | Promise<Response | undefined>)[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    const fault = await faults[0]?.(path, method, body);
    if (fault) return fault;
    if (path === "/me") return Response.json({ id: "publisher" });
    if (path === "/me/playlists") {
      marker = body.description;
      return Response.json({ id: playlistId }, { status: 201 });
    }
    if (path === `/playlists/${playlistId}`) return Response.json({ id: playlistId, owner: { id: "publisher" }, public: true, description: marker, snapshot_id: String(snapshot) });
    if (path.endsWith("/items")) {
      if (method === "PUT") { tracks = [...body.uris]; snapshot++; }
      if (method === "POST") { tracks.push(...body.uris); snapshot++; }
      if (method === "GET") {
        const offset = Number(url.searchParams.get("offset"));
        return Response.json({ items: tracks.slice(offset, offset + 50).map(uri => ({ item: { uri, type: "track" } })), total: tracks.length, next: offset + 50 < tracks.length ? "ignored" : null });
      }
      return Response.json({ snapshot_id: String(snapshot) });
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  const store = {
    get: async (key: string) => structuredClone(rows.get(key)),
    set: async (key: string, row: Destination) => { rows.set(key, structuredClone(row)); },
  };
  const make = () => new SpotifyPublisher({ fetcher: fetcher as typeof fetch, accessToken: async () => "secret", store, sleep: async () => {}, now: () => now });
  return { publisher: make(), make, rows, calls, faults, fetcher, advance: (ms: number) => { now += ms; }, tracks: () => tracks };
}

describe("Spotify publisher contract", () => {
  it("creates an empty revision-zero Thread using its title and a non-spike ownership marker", async () => {
    const f = fixture();
    await expect(f.publisher.reconcile({ ...desired(0, []), title: "Late night drives" })).resolves.toMatchObject({ appliedRevision: 0 });
    expect(f.calls.find(call => call.path === "/me/playlists")?.body.name).toBe("Late night drives");
    expect(f.rows.get("acceptance")?.marker).toMatch(/^listen\.cx Spotify publishing [a-f0-9-]+$/);
    await expect(f.publisher.observe("acceptance")).resolves.toMatchObject({ revision: 0, appliedRevision: 0, trackUris: [], matchesDesired: true });
  });

  it("uses the default Thread name for existing spike callers without a title", async () => {
    const f = fixture();
    await f.publisher.reconcile(desired());
    expect(f.calls.find(call => call.path === "/me/playlists")?.body.name).toBe("listen.cx Thread");
  });

  it("rejects conflicting titles at the same revision before trusting an applied revision", async () => {
    const f = fixture();
    await f.publisher.reconcile({ ...desired(), title: "Road trip" });
    f.calls.length = 0;
    await expect(f.publisher.reconcile({ ...desired(), title: "Other trip" })).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(f.publisher.reconcile(desired())).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.calls).toHaveLength(0);
  });

  it("treats an omitted and explicit default title as the same desired state", async () => {
    const f = fixture();
    await f.publisher.reconcile(desired());
    f.calls.length = 0;
    await expect(f.publisher.reconcile({ ...desired(), title: "listen.cx Thread" })).resolves.toMatchObject({ appliedRevision: 1 });
    expect(f.calls).toHaveLength(0);
  });

  it.each([null, 42, "", " ", "x".repeat(81), "line\nbreak"])("rejects invalid titles before provider requests: %j", async title => {
    const f = fixture();
    await expect(f.publisher.reconcile({ ...desired(), title })).rejects.toMatchObject({ code: "invalid_desired" });
    expect(f.calls).toHaveLength(0);
  });

  it("reads current provider contents without rewriting drift or trusting an applied revision", async () => {
    const f = fixture();
    await f.publisher.reconcile(desired());
    f.tracks().splice(0, 3, `spotify:track:${D}`);
    f.calls.length = 0;
    await f.publisher.reconcile(desired());
    expect(f.calls).toHaveLength(0);
    const observed = await f.publisher.observe("acceptance");
    expect(observed).toMatchObject({ providerPlaylistId: playlistId, publisherId: "publisher", appliedRevision: 1, revision: 1, trackUris: [`spotify:track:${D}`], matchesDesired: false, snapshotId: "1", observedAt: 1000 });
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    expect(f.rows.get("acceptance")?.appliedRevision).toBe(1);
  });

  it("refuses absent destinations and unstable provider snapshots as readback evidence", async () => {
    const f = fixture();
    await expect(f.publisher.observe("missing")).rejects.toMatchObject({ code: "destination_unavailable" });
    await f.publisher.reconcile(desired());
    let snapshot = 0;
    f.faults.push(path => path === `/playlists/${playlistId}` ? Response.json({ owner: { id: "publisher" }, public: true, description: f.rows.get("acceptance")!.marker, snapshot_id: String(snapshot++) }) : undefined);
    await expect(f.publisher.observe("acceptance")).rejects.toMatchObject({ code: "readback_unstable" });
  });

  it("preserves readback rate limits across restarts without touching playlist contents", async () => {
    const f = fixture();
    await f.publisher.reconcile(desired());
    f.calls.length = 0;
    f.faults.push(() => Response.json({}, { status: 429, headers: { "retry-after": "60" } }));
    await expect(f.publisher.observe("acceptance")).rejects.toMatchObject({ status: 429 });
    await expect(f.make().observe("acceptance")).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.method).toBe("GET");
    expect(f.rows.get("acceptance")?.appliedRevision).toBe(1);
  });
  it("creates one public Thread playlist and verifies [A,B,C] then [C,A,D] at the same ID", async () => {
    const f = fixture();
    expect(await f.publisher.reconcile(desired())).toMatchObject({ providerPlaylistId: playlistId, appliedRevision: 1 });
    expect(await f.publisher.reconcile(desired(2, [C, A, D]))).toMatchObject({ providerPlaylistId: playlistId, appliedRevision: 2 });
    expect(f.tracks()).toEqual([C, A, D].map(id => `spotify:track:${id}`));
    expect(f.calls.filter(c => c.path === "/me/playlists")).toHaveLength(1);
    expect(f.calls.find(c => c.path === "/me/playlists")?.body).toMatchObject({ public: true, collaborative: false });
  });

  it("performs no provider requests for identical applied revision and rejects stale or conflicting revisions", async () => {
    const f = fixture();
    await f.publisher.reconcile(desired(2));
    f.calls.length = 0;
    await f.publisher.reconcile(desired(2));
    await expect(f.publisher.reconcile(desired(1))).rejects.toMatchObject({ code: "stale_revision" });
    await expect(f.publisher.reconcile(desired(2, [A]))).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.calls).toHaveLength(0);
  });

  it("preserves duplicates over multiple write/read batches and clears to empty", async () => {
    const f = fixture();
    const ids = Array.from({ length: 205 }, (_, i) => i % 2 ? A : B);
    await f.publisher.reconcile(desired(1, ids));
    expect(f.tracks()).toEqual(ids.map(id => `spotify:track:${id}`));
    expect(f.calls.filter(c => ["PUT", "POST"].includes(c.method) && c.path.endsWith("/items")).map(c => c.body.uris.length)).toEqual([100, 100, 5]);
    await f.publisher.reconcile(desired(2, []));
    expect(f.tracks()).toEqual([]);
    expect(f.rows.get("acceptance")?.appliedRevision).toBe(2);
  });

  it.each([401, 403])("does not retry a %i create failure and permits a later authorized retry", async status => {
    const f = fixture();
    f.faults.push((path) => path === "/me/playlists" ? Response.json({}, { status }) : undefined);
    await expect(f.publisher.reconcile(desired())).rejects.toMatchObject({ code: "provider_error", status });
    expect(f.calls.filter(c => c.path === "/me/playlists")).toHaveLength(1);
    expect(f.rows.get("acceptance")?.appliedRevision).toBeNull();
    f.faults.length = 0;
    await expect(f.publisher.reconcile(desired())).resolves.toMatchObject({ appliedRevision: 1 });
  });

  it("honors persisted Retry-After without looping on 429 writes", async () => {
    const f = fixture();
    f.faults.push(path => path === "/me/playlists" ? Response.json({}, { status: 429, headers: { "retry-after": "60" } }) : undefined);
    await expect(f.publisher.reconcile(desired())).rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
    const n = f.calls.length;
    await expect(f.make().reconcile(desired())).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
    expect(f.calls).toHaveLength(n);
    f.advance(60_000); f.faults.length = 0;
    await expect(f.publisher.reconcile(desired())).resolves.toMatchObject({ appliedRevision: 1 });
  });

  it.each(["network", "500", "invalid-json"])("blocks duplicate creation after ambiguous %s even after restart", async fault => {
    const f = fixture();
    f.faults.push(path => {
      if (path !== "/me/playlists") return;
      if (fault === "network") throw new Error("connection lost");
      return fault === "500" ? new Response("failure", { status: 500 }) : new Response("invalid");
    });
    await expect(f.publisher.reconcile(desired())).rejects.toBeDefined();
    f.faults.length = 0;
    await expect(f.make().reconcile(desired())).rejects.toMatchObject({ code: "create_unresolved" });
    expect(f.calls.filter(c => c.path === "/me/playlists")).toHaveLength(1);
  });

  it("uses an edge-supported redirect mode and treats provider redirects as unavailable", async () => {
    const f = fixture();
    f.faults.push(() => new Response(null, { status: 302, headers: { Location: "https://attacker.example/provider" } }));
    await expect(f.publisher.reconcile(desired())).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });
    expect(f.fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("never replays ambiguous append and repairs with a full replacement on explicit retry", async () => {
    const f = fixture();
    const ids = Array(105).fill(A);
    let lost = false;
    f.faults.push((path, method, body) => {
      if (path.endsWith("/items") && method === "POST" && !lost) {
        lost = true; f.tracks().push(...body.uris); throw new Error("response lost after append");
      }
      return undefined;
    });
    await expect(f.publisher.reconcile(desired(1, ids))).rejects.toMatchObject({ code: "ambiguous_write" });
    expect(f.rows.get("acceptance")?.appliedRevision).toBeNull();
    expect(f.calls.filter(c => c.method === "POST" && c.path.endsWith("/items"))).toHaveLength(1);
    await f.make().reconcile(desired(1, ids));
    expect(f.tracks()).toHaveLength(105);
    expect(f.calls.filter(c => c.method === "PUT")).toHaveLength(2);
  });

  it("waits for delayed readback but never marks a persistent mismatch applied", async () => {
    const f = fixture(); let reads = 0;
    f.faults.push((path, method) => path.endsWith("/items") && method === "GET" && reads++ === 0 ? Response.json({ items: [], total: 0, next: null }) : undefined);
    await f.publisher.reconcile(desired());
    expect(reads).toBe(2);
    f.faults[0] = (path, method) => path.endsWith("/items") && method === "GET" ? Response.json({ items: [], total: 0, next: null }) : undefined;
    await expect(f.publisher.reconcile(desired(2, [D]))).rejects.toMatchObject({ code: "readback_mismatch" });
    expect(f.rows.get("acceptance")?.appliedRevision).toBe(1);
  });

  it("rejects concurrent reconciliation so a later request cannot race an in-flight revision", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.faults.push(async path => { if (path === "/me") await gate; return undefined; });
    const first = f.publisher.reconcile(desired());
    await expect(f.publisher.reconcile(desired(2, [D]))).rejects.toMatchObject({ code: "busy" });
    release(); await first;
    await f.publisher.reconcile(desired(2, [D]));
    expect(f.rows.get("acceptance")?.appliedRevision).toBe(2);
  });

  it("refuses an existing destination owned by a different publisher", async () => {
    const f = fixture(); await f.publisher.reconcile(desired());
    f.faults.push(path => path === "/me" ? Response.json({ id: "other" }) : undefined);
    const writes = f.calls.filter(c => c.method !== "GET").length;
    await expect(f.publisher.reconcile(desired(2))).rejects.toMatchObject({ code: "publisher_mismatch" });
    expect(f.calls.filter(c => c.method !== "GET")).toHaveLength(writes);
  });

  it("recovers an unknown create only by verifying the publisher and saved ownership marker", async () => {
    const f = fixture();
    f.faults.push(path => { if (path === "/me/playlists") throw new Error("response lost"); return undefined; });
    await expect(f.publisher.reconcile(desired())).rejects.toBeDefined();
    f.faults[0] = path => path === `/playlists/${playlistId}` ? Response.json({ id: playlistId, owner: { id: "publisher" }, public: true, description: "an existing personal playlist", snapshot_id: "1" }) : undefined;
    await expect(f.publisher.recoverCreate("acceptance", playlistId)).rejects.toMatchObject({ code: "destination_mismatch" });
    expect(f.rows.get("acceptance")?.createUnresolved).toBe(true);
    f.faults[0] = path => path === `/playlists/${playlistId}` ? Response.json({ id: playlistId, owner: { id: "publisher" }, public: true, description: f.rows.get("acceptance")?.marker, snapshot_id: "1" }) : undefined;
    expect(await f.publisher.recoverCreate("acceptance", playlistId)).toMatchObject({ providerPlaylistId: playlistId, createUnresolved: false, appliedRevision: null });
    expect(f.calls.filter(c => c.method !== "GET")).toHaveLength(1);
  });

  it("refuses to claim applied when snapshots change across readback", async () => {
    const f = fixture(); let snapshot = 0;
    f.faults.push(path => path === `/playlists/${playlistId}` ? Response.json({ id: playlistId, owner: { id: "publisher" }, public: true, description: f.rows.get("acceptance")?.marker, snapshot_id: String(snapshot++) }) : undefined);
    await expect(f.publisher.reconcile(desired())).rejects.toMatchObject({ code: "readback_mismatch" });
    expect(f.rows.get("acceptance")?.appliedRevision).toBeNull();
  });

  it("does not mistake unavailable or relinked tracks for exact ordered identity", async () => {
    const f = fixture();
    f.faults.push((path, method) => path.endsWith("/items") && method === "GET" ? Response.json({ items: [{ item: null }, { item: { type: "track", uri: `spotify:track:${D}`, linked_from: { uri: `spotify:track:${A}` } } }], total: 2, next: null }) : undefined);
    await expect(f.publisher.reconcile(desired(1, [B, A]))).rejects.toMatchObject({ code: "readback_mismatch" });
    expect(f.rows.get("acceptance")?.appliedRevision).toBeNull();
  });

  it("persists create intent before making a provider mutation", async () => {
    const f = fixture();
    f.faults.push(path => { if (path === "/me/playlists") expect(f.rows.get("acceptance")).toMatchObject({ createUnresolved: true, providerPlaylistId: null }); return undefined; });
    await f.publisher.reconcile(desired());
  });

  it.each([-1, 1.5])("rejects invalid revision %s before provider requests", async revision => {
    const f = fixture(); await expect(f.publisher.reconcile(desired(revision))).rejects.toMatchObject({ code: "invalid_desired" });
    expect(f.calls).toHaveLength(0);
  });
});
