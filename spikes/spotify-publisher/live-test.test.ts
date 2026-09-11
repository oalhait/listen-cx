import { describe, expect, it } from "vitest";
import { controlClient, runPhase, type Manifest } from "./live-test";

const ids = ["A", "B", "C", "D"].map(id => id.repeat(22));
const manifest: Manifest = { playlistKey: "live-acceptance", publisherId: "friend-owner", appMode: "development", trackIds: ids as [string, string, string, string] };
const playlistId = "P".repeat(22);
function fixture() {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let revision = 1;
  let actual = ids.slice(0, 3);
  let currentId = playlistId;
  let authorized = true;
  let failure: string | undefined;
  let created = false;
  const request = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    calls.push({ path, method, body });
    if (path === "/control/status") return { authorized, publisherId: manifest.publisherId, appMode: manifest.appMode, destinations: created ? [{ playlistKey: manifest.playlistKey, providerPlaylistId: playlistId, revision, createUnresolved: false }] : [] };
    if (failure) throw new Error(failure);
    if (path === "/control/desired") {
      const desired = body as { revision: number; trackIds: string[] };
      revision = desired.revision; actual = desired.trackIds; created = true;
      return { providerPlaylistId: currentId, appliedRevision: revision };
    }
    return { playlistKey: manifest.playlistKey, providerPlaylistId: currentId, publisherId: manifest.publisherId, revision, appliedRevision: revision, trackUris: actual.map(id => `spotify:track:${id}`), snapshotId: String(revision), observedAt: 1234, matchesDesired: true };
  };
  return { request, calls, setAuthorized: (value: boolean) => { authorized = value; }, setFailure: (value: string) => { failure = value; }, setId: (value: string) => { currentId = value; }, drift: () => { actual = [ids[3]!]; } };
}

describe("operator live-test phases with fixture responses", () => {
  it("publishes separate revisions and verifies fresh same-ID readback", async () => {
    const f = fixture();
    const initial = await runPhase({ manifest, phase: "initial", publish: true, request: f.request });
    expect(initial.verified).toBe(true);
    expect(f.calls.filter(call => call.method === "PUT")).toHaveLength(1);
    const updated = await runPhase({ manifest, phase: "updated", publish: true, initial, request: f.request });
    expect(updated.verified).toBe(true);
    expect(updated.observation.trackUris).toEqual([ids[2], ids[0], ids[3]].map(id => `spotify:track:${id}`));
    expect(updated.listenerVerification).toBe("pending");
  });
  it("requires confirmed identity and mode before any publication", async () => {
    const f = fixture(); f.setAuthorized(false);
    await expect(runPhase({ manifest, phase: "initial", publish: true, request: f.request })).rejects.toThrow("publisher_confirmation_required");
    expect(f.calls).toHaveLength(1);
    f.setAuthorized(true);
    await expect(runPhase({ manifest: { ...manifest, publisherId: "other" }, phase: "initial", publish: true, request: f.request })).rejects.toThrow("publisher_confirmation_required");
    await expect(runPhase({ manifest: { ...manifest, appMode: "extended-quota" }, phase: "initial", publish: true, request: f.request })).rejects.toThrow("publisher_confirmation_required");
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
  });
  it("requires matching verified initial evidence before the update", async () => {
    const f = fixture();
    await expect(runPhase({ manifest, phase: "updated", publish: true, request: f.request })).rejects.toThrow("initial_evidence_required");
    expect(f.calls).toHaveLength(0);
    const initial = await runPhase({ manifest, phase: "initial", publish: true, request: f.request });
    await expect(runPhase({ manifest: { ...manifest, trackIds: [...ids].reverse() as Manifest["trackIds"] }, phase: "updated", publish: true, initial, request: f.request })).rejects.toThrow("initial_evidence_required");
    const fresh = fixture();
    await expect(runPhase({ manifest, phase: "updated", publish: true, initial, request: fresh.request })).rejects.toThrow("destination_identity_changed");
    expect(fresh.calls.every(call => call.method === "GET")).toBe(true);
  });
  it("captures drift and changed playlist identity as failed evidence", async () => {
    const f = fixture();
    const initial = await runPhase({ manifest, phase: "initial", publish: true, request: f.request });
    f.calls.length = 0; f.drift();
    const drifted = await runPhase({ manifest, phase: "initial", request: f.request });
    expect(drifted.verified).toBe(false);
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    f.setId("Q".repeat(22));
    expect((await runPhase({ manifest, phase: "updated", publish: true, initial, request: f.request })).verified).toBe(false);
  });
  it.each(["create_unresolved", "ambiguous_write", "rate_limited"])("does not automatically retry %s or advance to another phase", async failure => {
    const f = fixture(); f.setFailure(failure);
    await expect(runPhase({ manifest, phase: "initial", publish: true, request: f.request })).rejects.toThrow(failure);
    expect(f.calls.filter(call => call.method === "PUT")).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
  });
  it("rejects invalid or duplicate fixture tracks before any requests", async () => {
    const f = fixture();
    await expect(runPhase({ manifest: { ...manifest, trackIds: [ids[0]!, ids[0]!, ids[2]!, ids[3]!] }, phase: "initial", request: f.request })).rejects.toThrow("invalid_manifest");
    expect(f.calls).toHaveLength(0);
  });
  it("keeps operator credentials on the fixed control host and surfaces rate limits without retry", async () => {
    let calls = 0;
    const token = "operator-secret-".repeat(4);
    const client = controlClient(token, (async (input, init) => {
      calls++;
      expect(String(input)).toBe("https://listen-cx-spotify-spike-staging.omar-alhait.workers.dev/control/desired");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Response.json({ error: "rate_limited", detail: token }, { status: 429, headers: { "retry-after": "60" } });
    }) as typeof fetch);
    await expect(client("/control/desired", "PUT", {})).rejects.toThrow("rate_limited: HTTP 429; retry after 60 seconds");
    await expect(client("https://attacker.example/control/status")).rejects.toThrow("invalid_control_path");
    expect(calls).toBe(1);
  });
  it("reports unknown mutation outcomes without retrying or echoing transport secrets", async () => {
    let calls = 0;
    const token = "operator-secret-".repeat(4);
    const client = controlClient(token, (async () => { calls++; throw new Error(token); }) as typeof fetch);
    await expect(client("/control/desired", "PUT", {})).rejects.toThrow("control_write_outcome_unknown");
    expect(calls).toBe(1);
  });
});
