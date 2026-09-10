import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { createApp } from "./app.js";
import { D1ThreadStore } from "./thread-db.js";
import { D1LinkStore } from "./db.js";
import type { Resolved } from "./resolve.js";

const baseUrl = "https://listen.test";
const threadStore = new D1ThreadStore(env.DB);
const track: Resolved = { title: "Cataracts", artist: "Freddie Gibbs, Madlib", artworkUrl: null, spotifyUrl: "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO", appleUrl: null, isrc: null, complete: false };
const resolve = vi.fn<(_: string) => Promise<Resolved | null>>();
const app = createApp({ resolver: { resolve }, store: new D1LinkStore(env.DB), threadStore, baseUrl });
const post = (path: string, body: unknown, cookie?: string) => app.request(baseUrl + path, {
  method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json", "X-Listen-Action": "thread", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
});
async function create() {
  const creationKey = nanoid(22);
  const response = await post("/api/threads", { title: "Road trip", creationKey });
  expect(response.status).toBe(201);
  const body = await response.json() as { thread: { publicCapability: string }; publicUrl: string; managementUrl: string };
  return { ...body, creationKey, cookie: response.headers.get("Set-Cookie")!.split(";")[0]!, cap: body.thread.publicCapability };
}
const add = (cap: string, expectedRevision: number, requestKey = nanoid()) => post(`/api/threads/${cap}/contributions`, { url: track.spotifyUrl, expectedRevision, requestKey });

beforeEach(() => { resolve.mockReset().mockResolvedValue(track); });

describe("Thread HTTP contract", () => {
  it("creates a Thread with separate public and fragment-only management links", async () => {
    const created = await create();
    expect(created.publicUrl).toBe(`${baseUrl}/t/${created.cap}`);
    expect(created.managementUrl).toBe(`${created.publicUrl}#manage=${created.creationKey}`);
    expect(created.cap).not.toBe(created.creationKey);
    const read = await app.request(`/api/threads/${created.cap}`);
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    expect(read.headers.get("Referrer-Policy")).toBe("no-referrer");
    const data = await read.text();
    expect(data).not.toContain(created.creationKey);
    expect(data).not.toContain("managementDigest");
    expect(JSON.parse(data).publications).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "spotify", status: "blocked", appliedRevision: null, verifiedPlaylistId: null }),
      expect.objectContaining({ provider: "apple", status: "blocked", appliedRevision: null, verifiedPlaylistId: null }),
    ]));
  });

  it("adds a source track and replays without another provider call", async () => {
    const { cap } = await create();
    expect((await add(cap, 0, "song")).status).toBe(200);
    expect((await add(cap, 0, "song")).status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    const current = (await threadStore.get(cap))!;
    expect(current.contributions[0]?.source).toMatchObject({ provider: "spotify", verified: true });
    expect(current.revision).toBe(1);
    expect((await threadStore.getDesiredState(cap, "apple"))!.entries).toHaveLength(1);
    expect((await threadStore.getDesiredState(cap, "apple"))!.entries[0]?.identity.status).toBe("unresolved");
  });

  it("requires management authorization and isolates management cookies between Threads", async () => {
    const owner = await create();
    const other = await create();
    await add(owner.cap, 0);
    const id = (await threadStore.get(owner.cap))!.contributions[0]!.id;
    const path = `/t/${owner.cap}/manage/mutate`;
    const action = { kind: "remove", id, expectedRevision: 1, requestKey: "remove" };
    expect((await post(path, action)).status).toBe(403);
    expect((await post(path, action, other.cookie)).status).toBe(403);
    expect((await post(path, action, owner.cookie)).status).toBe(200);
    expect((await post(path, action, owner.cookie)).status).toBe(200);
    expect((await threadStore.get(owner.cap))!.revision).toBe(2);
  });

  it("activates management only with the separate secret and never puts it in HTML", async () => {
    const { cap, creationKey } = await create();
    const page = await app.request(`${baseUrl}/t/${cap}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).not.toContain(creationKey);
    expect((await post(`/t/${cap}/manage/activate`, { managementCapability: cap })).status).toBe(403);
    const response = await post(`/t/${cap}/manage/activate`, { managementCapability: creationKey });
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
  });

  it("rejects stale edits before provider access and closes the collaboration", async () => {
    const { cap, cookie } = await create();
    await add(cap, 0);
    resolve.mockClear();
    expect((await add(cap, 0)).status).toBe(409);
    expect(resolve).not.toHaveBeenCalled();
    const response = await post(`/t/${cap}/manage/mutate`, { kind: "close", expectedRevision: 1, requestKey: "close" }, cookie);
    expect(response.status).toBe(200);
    expect((await add(cap, 2)).status).toBe(410);
    expect((await app.request(`/api/threads/${cap}`)).status).toBe(200);
  });

  it("returns useful provider failures without changing the Thread", async () => {
    const { cap } = await create();
    resolve.mockResolvedValueOnce(null);
    expect((await add(cap, 0)).status).toBe(404);
    resolve.mockRejectedValueOnce(new Error("private upstream detail"));
    const failure = await add(cap, 0);
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain("private upstream detail");
    resolve.mockResolvedValueOnce({ ...track, spotifyUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" });
    expect((await add(cap, 0)).status).toBe(422);
    expect((await threadStore.get(cap))!.revision).toBe(0);
  });

  it("rejects cross-origin, oversized and unsupported public mutations", async () => {
    const { cap } = await create();
    const response = await app.request(baseUrl + `/api/threads/${cap}/contributions`, {
      method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json", "X-Listen-Action": "thread" }, body: JSON.stringify({ url: track.spotifyUrl, expectedRevision: 0, requestKey: "csrf" }),
    });
    expect(response.status).toBe(403);
    expect((await post(`/api/threads/${cap}/contributions`, { url: "x".repeat(5000), expectedRevision: 0, requestKey: "big" })).status).toBe(413);
    expect((await post(`/api/threads/${cap}/contributions`, { url: "https://spotify.link/example", expectedRevision: 0, requestKey: "unsupported" })).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("never accepts public playlist targets or publication status reports", async () => {
    const { cap, cookie } = await create();
    expect((await post(`/api/threads/${cap}/contributions`, { url: track.spotifyUrl, expectedRevision: 0, requestKey: "target", spotifyPlaylistId: "someone-elses-playlist" })).status).toBe(400);
    for (const path of [`/api/threads/${cap}/publish`, `/t/${cap}/manage/publications`, `/api/threads/${cap}/publications/spotify`]) {
      expect((await post(path, { appliedRevision: 1, verifiedPlaylistId: "arbitrary", status: "synced" }, cookie)).status).toBe(404);
    }
    expect((await threadStore.get(cap))!.publications.every(publication => publication.status === "blocked")).toBe(true);
  });
});
