import { describe, expect, it, vi } from "vitest";
import { ApplePublisher, type Destination, type DestinationStore } from "./publisher";

const desired = (trackIds = ["11", "11", "22"], revision = 0) => ({ playlistKey: "thread-one", revision, title: "Our songs", trackIds });
const publicUrl = "https://music.apple.com/us/playlist/our-songs/pl.shared";

function fixture() {
  const rows = new Map<string, Destination>();
  const store: DestinationStore = {
    get: async key => structuredClone(rows.get(key)),
    set: async (key, row) => { rows.set(key, structuredClone(row)); },
  };
  let tracks: string[] = [];
  let marker = "";
  let url = publicUrl;
  let next: string | undefined;
  let pageSize: number | undefined;
  let mutationFailure: "before" | "after" | "auth" | "limit" | undefined;
  const calls: { path: string; method: string; body: any }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(input));
    const path = parsed.pathname + parsed.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    expect(parsed.origin).toBe("https://api.music.apple.com");
    expect(new Headers(init?.headers).get("Music-User-Token")).toBe("private-user-token");
    if (method === "POST") {
      expect(rows.get("thread-one")?.intent).toBeTruthy();
      if (mutationFailure === "auth") return new Response("private-user-token provider diagnostic", { status: 401 });
      if (mutationFailure === "limit") return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
      if (mutationFailure === "before") throw new Error("private-user-token transport");
      if (path.endsWith("/tracks")) tracks.push(...body.data.map((item: { id: string }) => item.id));
      else {
        expect(body.attributes.isPublic).toBe(true);
        marker = body.attributes.description;
        tracks = body.relationships.tracks.data.map((item: { id: string }) => item.id);
      }
      if (mutationFailure === "after") throw new Error("private-user-token transport");
      return path.endsWith("/tracks") ? new Response(null, { status: 204 }) : Response.json({ data: [{ id: "p.created" }] });
    }
    if (parsed.pathname.endsWith("/tracks")) {
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const pageTracks = pageSize ? tracks.slice(offset, offset + pageSize) : tracks;
      return Response.json({
        data: pageTracks.map(id => ({ id: `i.${id}`, type: "library-songs", attributes: { playParams: { catalogId: id } } })),
        next: next ?? (pageSize && offset + pageSize < tracks.length ? `${parsed.pathname}?offset=${offset + pageSize}` : undefined),
      });
    }
    return Response.json({ data: [{ id: "p.created", attributes: { isPublic: true, description: { standard: marker } }, relationships: { catalog: { data: [{ id: "pl.shared", attributes: { url } }] } } }] });
  }) as typeof fetch;
  const publisher = () => new ApplePublisher({ store, credentials: async () => ({ developerToken: "private-developer-token", musicUserToken: "private-user-token" }), fetcher, now: () => 1000 });
  return { rows, store, calls, fetcher, publisher, setTracks: (ids: string[]) => { tracks = ids; }, setFailure: (value: typeof mutationFailure) => { mutationFailure = value; }, setUrl: (value: string) => { url = value; }, setNext: (value: string) => { next = value; }, setPageSize: (value: number) => { pageSize = value; } };
}

describe("ApplePublisher", () => {
  it.each([false, true])("recovers an empty creation from explicit playlist tracks before appending to the same playlist, pending: %s", async pending => {
    const f = fixture();
    let empty = true;
    let provideEvidence = !pending;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/tracks") && empty) return new Response(null, { status: 404 });
      if (init?.method === "POST" && url.pathname.endsWith("/tracks")) empty = false;
      const response = await f.fetcher(input, init);
      if (url.searchParams.get("include") === "tracks" && provideEvidence) {
        const data = await response.json() as any;
        data.data[0].relationships.tracks = { data: [], meta: { total: 0 } };
        return Response.json(data);
      }
      return response;
    }) as typeof fetch;
    const publisher = () => new ApplePublisher({ store: f.store, fetcher,
      credentials: async () => ({ developerToken: "private-developer-token", musicUserToken: "private-user-token" }) });
    if (pending) await expect(publisher().reconcile(desired([]))).rejects.toMatchObject({ status: 404 });
    else expect(await publisher().reconcile(desired([]))).toMatchObject({ providerPlaylistId: "p.created", appliedTrackIds: [], appliedRevision: 0 });
    provideEvidence = true;
    expect(await publisher().reconcile(desired(["11", "11", "22"], 1))).toMatchObject({ providerPlaylistId: "p.created", appliedTrackIds: ["11", "11", "22"], appliedRevision: 1 });
    expect(f.calls.filter(call => call.method === "POST").map(call => call.path)).toEqual([
      "/v1/me/library/playlists", "/v1/me/library/playlists/p.created/tracks",
    ]);
  });

  it.each([
    { tracks: { data: [], meta: { total: 1 } } },
    { tracks: { data: [], next: "/v1/me/library/playlists/p.created/tracks?offset=1", meta: { total: 0 } } },
    { tracks: { data: [] } },
    { tracks: { data: [{ id: "i.11" }], meta: { total: 0 } } },
    { tracks: null },
    { tracks: { data: [], meta: { total: 0 } }, id: "p.other" },
    { tracks: { data: [], meta: { total: 0 } }, description: "another playlist" },
  ])("does not infer empty tracks from a 404 without complete zero-track evidence: %j", async evidence => {
    const f = fixture();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/tracks")) return new Response(null, { status: 404 });
      const response = await f.fetcher(input, init);
      if (url.searchParams.get("include") === "tracks") {
        const data = await response.json() as any;
        data.data[0].relationships.tracks = evidence.tracks;
        if ("id" in evidence) data.data[0].id = evidence.id;
        if ("description" in evidence) data.data[0].attributes.description = evidence.description;
        return Response.json(data);
      }
      return response;
    }) as typeof fetch;
    const publisher = new ApplePublisher({ store: f.store, fetcher,
      credentials: async () => ({ developerToken: "private-developer-token", musicUserToken: "private-user-token" }) });
    await expect(publisher.reconcile(desired([]))).rejects.toMatchObject({ code: "provider_error", status: 404 });
    await expect(publisher.reconcile(desired(["11"], 1))).rejects.toMatchObject({ code: "provider_error", status: 404 });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(f.rows.get("thread-one")?.appliedRevision).toBeNull();
  });

  it("creates a public playlist at revision zero and preserves exact ordered duplicates", async () => {
    const f = fixture();
    const result = await f.publisher().reconcile(desired());
    expect(result).toMatchObject({ providerPlaylistId: "p.created", appliedRevision: 0, appliedTrackIds: ["11", "11", "22"], verifiedUrl: publicUrl, intent: null });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });

  it("reads the known prefix before appending only the suffix to the same playlist", async () => {
    const f = fixture();
    await f.publisher().reconcile(desired());
    f.calls.length = 0;
    await f.publisher().reconcile(desired(["11", "11", "22", "11"], 1));
    const write = f.calls.findIndex(call => call.method === "POST");
    expect(f.calls.slice(0, write).some(call => call.path.endsWith("/tracks"))).toBe(true);
    expect(f.calls[write]).toMatchObject({ path: "/v1/me/library/playlists/p.created/tracks", body: { data: [{ id: "11", type: "songs" }] } });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });

  it.each([["11", "22"], ["22", "11", "11"]])("refuses removals and reorders before any provider call: %j", async (...ids) => {
    const f = fixture();
    await f.publisher().reconcile(desired());
    f.calls.length = 0;
    await expect(f.publisher().reconcile(desired(ids, 1))).rejects.toMatchObject({ code: "append_only" });
    expect(f.calls).toHaveLength(0);
  });

  it("fences provider prefix drift without writing", async () => {
    const f = fixture();
    await f.publisher().reconcile(desired());
    f.setTracks(["11", "22", "11"]);
    f.calls.length = 0;
    await expect(f.publisher().reconcile(desired(["11", "11", "22", "33"], 1))).rejects.toMatchObject({ code: "provider_drift" });
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
  });

  it("recovers an ambiguous append after restart only from exact readback", async () => {
    const f = fixture();
    await f.publisher().reconcile(desired());
    f.setFailure("after");
    const update = desired(["11", "11", "22", "33"], 1);
    await expect(f.publisher().reconcile(update)).rejects.toMatchObject({ code: "ambiguous_write" });
    expect(f.rows.get("thread-one")?.intent?.kind).toBe("append");
    f.setFailure(undefined);
    f.calls.length = 0;
    expect(await f.publisher().reconcile(update)).toMatchObject({ appliedRevision: 1, intent: null });
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
  });

  it("never retries an ambiguous append when provider still has the old prefix", async () => {
    const f = fixture();
    await f.publisher().reconcile(desired());
    f.setFailure("before");
    const update = desired(["11", "11", "22", "33"], 1);
    await expect(f.publisher().reconcile(update)).rejects.toMatchObject({ code: "ambiguous_write" });
    f.setFailure(undefined);
    f.calls.length = 0;
    await expect(f.publisher().reconcile(update)).rejects.toMatchObject({ code: "append_unresolved" });
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
  });

  it("permanently fences creation with an unknown outcome across restart", async () => {
    const f = fixture();
    f.setFailure("after");
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "ambiguous_write" });
    f.setFailure(undefined);
    f.calls.length = 0;
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "create_unresolved" });
    expect(f.calls).toHaveLength(0);
  });

  it("sanitizes authorization failures and permits retry after a definite rejection", async () => {
    const f = fixture();
    f.setFailure("auth");
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "provider_error", status: 401, message: "provider_error" });
    expect(JSON.stringify([...f.rows.values()])).not.toContain("private-");
    expect(f.rows.get("thread-one")?.intent).toBeNull();
    f.setFailure(undefined);
    expect(await f.publisher().reconcile(desired())).toMatchObject({ appliedRevision: 0 });
  });

  it("persists rate limits across restart and makes no request before the deadline", async () => {
    const f = fixture();
    f.setFailure("limit");
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ status: 429, retryAfterSeconds: 120 });
    expect(f.rows.get("thread-one")?.retryNotBefore).toBe(121000);
    f.calls.length = 0;
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(f.calls).toHaveLength(0);
  });

  it.each(["http://music.apple.com/us/playlist/test/pl.shared", "https://music.apple.com.evil.test/us/playlist/test/pl.shared", "https://music.apple.com/us/album/test/123", "https://user@music.apple.com/us/playlist/test/pl.shared"]) ("withholds a destination for invalid public URLs: %s", async url => {
    const f = fixture();
    f.setUrl(url);
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "public_url_unverified" });
    expect(f.rows.get("thread-one")?.verifiedUrl).toBeNull();
  });

  it("rejects cross-origin pagination before credentials can leave Apple", async () => {
    const f = fixture();
    f.setNext("https://evil.test/tracks");
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "invalid_provider_response" });
    expect(f.calls).toHaveLength(3);
  });

  it("rechecks provider state before returning an already applied revision", async () => {
    const f = fixture();
    await f.publisher().reconcile(desired());
    f.setTracks(["11", "22"]);
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "provider_drift" });
  });

  it("preserves duplicate order across same-origin track pages", async () => {
    const f = fixture();
    f.setPageSize(1);
    expect(await f.publisher().reconcile(desired())).toMatchObject({ appliedTrackIds: ["11", "11", "22"] });
    expect(f.calls.some(call => call.path.endsWith("?offset=2"))).toBe(true);
  });

  it("bounds pagination and rejects repeated cursors", async () => {
    const f = fixture();
    f.setNext("/v1/me/library/playlists/p.created/tracks?offset=0");
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "invalid_provider_response" });
    expect(f.calls).toHaveLength(4);
  });

  it("refuses unresolved library identities instead of guessing catalog IDs", async () => {
    const f = fixture();
    await f.publisher().reconcile(desired());
    f.setTracks(["11", "i.unknown", "22"]);
    await expect(f.publisher().reconcile(desired())).rejects.toMatchObject({ code: "unresolved_track" });
  });

  it("sanitizes credential callback errors before reserving a mutation", async () => {
    const f = fixture();
    const publisher = new ApplePublisher({ store: f.store, fetcher: f.fetcher, credentials: async () => { throw new Error("private-credentials"); } });
    await expect(publisher.reconcile(desired())).rejects.toMatchObject({ code: "credentials_unavailable", status: 401, message: "credentials_unavailable" });
    expect(f.rows.get("thread-one")?.intent).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("never writes when the store cannot persist mutation intent", async () => {
    const f = fixture();
    const publisher = new ApplePublisher({
      store: { get: f.store.get, set: async (key, row) => { if (row.intent) throw new Error("storage unavailable"); await f.store.set(key, row); } },
      fetcher: f.fetcher, credentials: async () => ({ developerToken: "developer", musicUserToken: "user" }),
    });
    await expect(publisher.reconcile(desired())).rejects.toMatchObject({ code: "publisher_unavailable", status: 503, message: "publisher_unavailable" });
    expect(f.calls).toHaveLength(0);
  });

  it("rejects stale revisions and conflicting content without provider writes", async () => {
    const f = fixture();
    await f.publisher().reconcile(desired(["11"], 1));
    f.calls.length = 0;
    await expect(f.publisher().reconcile(desired(["11"], 0))).rejects.toMatchObject({ code: "stale_revision" });
    await expect(f.publisher().reconcile(desired(["11", "22"], 1))).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.calls).toHaveLength(0);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid revisions: %s", async revision => {
    const f = fixture();
    await expect(f.publisher().reconcile(desired(["11"], revision))).rejects.toMatchObject({ code: "invalid_desired", status: 400 });
    expect(f.rows.size).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
});
