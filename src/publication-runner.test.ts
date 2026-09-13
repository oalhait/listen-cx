import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { D1ThreadStore } from "./thread-db.js";
import { D1PublicationStore } from "./publication-db.js";
import { authorizeManagementCapability } from "./thread-security.js";
import { runPublication } from "./publication-runner.js";

async function setup() {
  const threads = new D1ThreadStore(env.DB);
  const secret = nanoid(22);
  const view = await threads.create("Drive", secret);
  const auth = (await authorizeManagementCapability(threads, view.publicCapability, secret))!;
  await threads.manage(auth, { kind: "connect", provider: "spotify", expectedRevision: 0, requestKey: "connect" });
  const publications = new D1PublicationStore(env.DB);
  const [target] = await publications.due(view.publicCapability);
  return { threads, auth, publications, target: target!, cap: view.publicCapability };
}
const id = "a".repeat(22);
const output = { revision: 1, playlistId: id, playlistUrl: `https://open.spotify.com/playlist/${id}` };

it("publishes an exact snapshot using a private destination key and schedules a newer revision", async () => {
  const { threads, auth, target, cap } = await setup();
  const publish = vi.fn(async input => {
    expect(input).toEqual({ playlistKey: target.publisherKey, title: "Drive", revision: 1, trackIds: [] });
    await threads.manage(auth, { kind: "close", expectedRevision: 1, requestKey: "close" });
    return output;
  });
  expect(await runPublication(env.DB, target.publisherKey, { spotify: publish })).toBeTypeOf("number");
  expect((await threads.get(cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: "pending", appliedRevision: 1, requestedRevision: 2 });
});

it("blocks unresolved identities without invoking a provider or dropping songs", async () => {
  const { threads, target, cap } = await setup();
  await threads.add(cap, { expectedRevision: 1, requestKey: "song", source: { provider: "apple", id: "123", storefront: "us" }, track: { title: "Song", artist: "Artist", artworkUrl: null, isrc: null, complete: false, spotifyUrl: null, appleUrl: "https://music.apple.com/us/song/123" } });
  const publish = vi.fn();
  expect(await runPublication(env.DB, target.publisherKey, { spotify: publish })).toBeNull();
  expect(publish).not.toHaveBeenCalled();
  expect((await threads.get(cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: "blocked", blockedReason: "identities_incomplete", appliedRevision: null });
});

it("requires adapter authorization and never publishes errors or unverified readbacks as success", async () => {
  const { threads, target, cap } = await setup();
  await runPublication(env.DB, target.publisherKey, {});
  expect((await threads.get(cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ blockedReason: "publisher_not_authorized" });
  await env.DB.prepare("UPDATE thread_publications SET status = 'pending', blocked_reason = NULL WHERE publisher_key = ?").bind(target.publisherKey).run();
  await runPublication(env.DB, target.publisherKey, { spotify: async () => ({ ...output, revision: 9 }) });
  expect((await threads.get(cap))!.publications.find(p => p.provider === "spotify")).toMatchObject({ status: "failed", appliedRevision: null, failureCode: "readback_invalid" });
});

it("honors rate limits and sanitizes unexpected provider errors", async () => {
  const { threads, publications, target, cap } = await setup();
  const publish = vi.fn(async () => { throw Object.assign(new Error("secret-token"), { code: "provider_error", status: 429, retryAfterSeconds: 120 }); });
  const now = Date.now();
  expect(await runPublication(env.DB, target.publisherKey, { spotify: publish })).toBeGreaterThanOrEqual(now + 120000);
  expect(await publications.due(cap)).toEqual([]);
  await runPublication(env.DB, target.publisherKey, { spotify: publish });
  expect(publish).toHaveBeenCalledTimes(1);
  const current = (await threads.get(cap))!;
  expect(JSON.stringify(current)).not.toContain("secret-token");
  expect(current.publications.find(p => p.provider === "spotify")!.failureCode).toBe("rate_limited");
});

async function subscribe(capability: string) {
  const accountId = crypto.randomUUID();
  const publisherKey = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO accounts(id, provider, provider_subject, label) VALUES (?, 'spotify', ?, 'Listener')")
    .bind(accountId, accountId).run();
  await env.DB.prepare(`INSERT INTO thread_subscriptions(account_id, thread_id, provider, publisher_key, requested_revision)
    SELECT ?, id, 'spotify', ?, revision FROM threads WHERE public_capability = ?`)
    .bind(accountId, publisherKey, capability).run();
  return publisherKey;
}

it("publishes each subscriber independently when the legacy destination is already synced", async () => {
  const { publications, target, cap } = await setup();
  await publications.verified(target.publisherKey, 1, id, output.playlistUrl);
  const first = await subscribe(cap);
  const second = await subscribe(cap);
  const publish = vi.fn(async input => ({ ...output, revision: input.revision }));
  await runPublication(env.DB, first, { spotify: publish });
  expect(await publications.target(first)).toMatchObject({ status: "synced", appliedRevision: 1 });
  expect(await publications.target(second)).toMatchObject({ status: "pending", appliedRevision: null });
  await runPublication(env.DB, first, { spotify: publish });
  expect(publish).toHaveBeenCalledTimes(1);
  await runPublication(env.DB, second, { spotify: publish });
  expect(publish.mock.calls.map(([input]) => input.playlistKey)).toEqual([first, second]);
  expect(await publications.target(target.publisherKey)).toMatchObject({ status: "synced", appliedRevision: 1 });
});

it("isolates subscriber provider failures and preserves newer website revisions", async () => {
  const { threads, auth, publications, cap } = await setup();
  const first = await subscribe(cap);
  const second = await subscribe(cap);
  await runPublication(env.DB, first, { spotify: async () => { throw { status: 401 }; } });
  expect(await publications.target(first)).toMatchObject({ status: "blocked", appliedRevision: null });
  expect(await publications.target(second)).toMatchObject({ status: "pending", appliedRevision: null });
  await runPublication(env.DB, second, { spotify: async () => {
    await threads.manage(auth, { kind: "close", expectedRevision: 1, requestKey: "close" });
    return output;
  } });
  expect(await publications.target(second)).toMatchObject({ status: "pending", appliedRevision: 1, requestedRevision: 2 });
  await publications.verified(second, 2, id, output.playlistUrl);
  await publications.failed(second, 1, "stale", false, Date.now() + 60000);
  expect(await publications.target(second)).toMatchObject({ status: "synced", appliedRevision: 2 });
  expect(await publications.target(first)).toMatchObject({ status: "pending", appliedRevision: null, requestedRevision: 2 });
});
