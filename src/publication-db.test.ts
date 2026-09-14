import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { nanoid } from "nanoid";
import { D1ThreadStore } from "./thread-db.js";
import { D1PublicationStore } from "./publication-db.js";
import { authorizeManagementCapability } from "./thread-security.js";
import { D1AccountStore } from "./account-db.js";

it("keeps newer revisions pending when an earlier provider readback completes", async () => {
  const threads = new D1ThreadStore(env.DB);
  const publications = new D1PublicationStore(env.DB);
  const secret = nanoid(22);
  const view = await threads.create("Drive", secret);
  const auth = (await authorizeManagementCapability(threads, view.publicCapability, secret))!;
  await threads.manage(auth, { kind: "connect", provider: "spotify", expectedRevision: 0, requestKey: "connect" });
  const [target] = await publications.due();
  expect(target).toMatchObject({ capability: view.publicCapability, provider: "spotify" });
  expect(target!.publisherKey).not.toBe(view.publicCapability);
  await threads.manage(auth, { kind: "close", expectedRevision: 1, requestKey: "close" });
  await publications.verified(target!.publisherKey, 1, "a".repeat(22), `https://open.spotify.com/playlist/${"a".repeat(22)}`);
  expect((await threads.get(view.publicCapability))!.publications.find(p => p.provider === "spotify")!).toMatchObject({ status: "pending", appliedRevision: 1, requestedRevision: 2 });
  await publications.verified(target!.publisherKey, 2, "a".repeat(22), `https://open.spotify.com/playlist/${"a".repeat(22)}`);
  expect((await threads.get(view.publicCapability))!.publications.find(p => p.provider === "spotify")!).toMatchObject({ status: "synced", appliedRevision: 2 });
  await publications.failed(target!.publisherKey, 1, "old_failure", false, Date.now() + 60000);
  expect((await threads.get(view.publicCapability))!.publications.find(p => p.provider === "spotify")!.status).toBe("synced");
  await publications.verified(target!.publisherKey, 1, "a".repeat(22), `https://open.spotify.com/playlist/${"a".repeat(22)}`);
  expect((await threads.get(view.publicCapability))!.publications.find(p => p.provider === "spotify")!.appliedRevision).toBe(2);
});

it("retains retry deadlines and refuses destination replacement or invalid listener links", async () => {
  const threads = new D1ThreadStore(env.DB);
  const publications = new D1PublicationStore(env.DB);
  const secret = nanoid(22);
  const view = await threads.create("Drive", secret);
  const auth = (await authorizeManagementCapability(threads, view.publicCapability, secret))!;
  await threads.manage(auth, { kind: "connect", provider: "spotify", expectedRevision: 0, requestKey: "connect" });
  const [target] = await publications.due();
  await publications.failed(target!.publisherKey, 1, "rate_limited", false, Date.now() + 60000);
  expect(await publications.due()).toEqual([]);
  await expect(publications.verified(target!.publisherKey, 1, "a".repeat(22), "https://evil.test/")).rejects.toThrow();
  await publications.verified(target!.publisherKey, 1, "a".repeat(22), `https://open.spotify.com/playlist/${"a".repeat(22)}`);
  await publications.verified(target!.publisherKey, 1, "b".repeat(22), `https://open.spotify.com/playlist/${"b".repeat(22)}`);
  expect((await threads.get(view.publicCapability))!.publications.find(p => p.provider === "spotify")!.verifiedPlaylistId).toBe("a".repeat(22));
});

it("accepts only provider playlist links and exact Spotify destination IDs", async () => {
  const { isPlaylistUrl } = await import("./publication-db.js");
  expect(isPlaylistUrl("apple", "p.abc", "https://music.apple.com/us/playlist/drive/pl.u-abc")).toBe(true);
  expect(isPlaylistUrl("apple", "p.abc", "https://music.apple.com/us/playlist/pl.u-abc")).toBe(true);
  for (const url of ["http://music.apple.com/us/playlist/drive/pl.u-abc", "https://music.apple.com.evil.test/us/playlist/drive/pl.u-abc", "https://user:secret@music.apple.com/us/playlist/drive/pl.u-abc", "https://music.apple.com/us/song/123"]) {
    expect(isPlaylistUrl("apple", "p.abc", url)).toBe(false);
  }
  expect(isPlaylistUrl("spotify", "a".repeat(22), `https://open.spotify.com/playlist/${"b".repeat(22)}`)).toBe(false);
});

it("lets a manager retry a closed Thread publication without bypassing a provider retry deadline", async () => {
  const threads = new D1ThreadStore(env.DB);
  const publications = new D1PublicationStore(env.DB);
  const secret = nanoid(22);
  const view = await threads.create("Retry", secret);
  const auth = (await authorizeManagementCapability(threads, view.publicCapability, secret))!;
  await threads.manage(auth, { kind: "connect", provider: "spotify", expectedRevision: 0, requestKey: "connect" });
  await threads.manage(auth, { kind: "close", expectedRevision: 1, requestKey: "close" });
  const [target] = await publications.due(view.publicCapability);
  const retryAt = Date.now() + 60000;
  await publications.failed(target!.publisherKey, 2, "rate_limited", false, retryAt);
  await expect(publications.retry({ publicCapability: view.publicCapability } as never, "spotify")).rejects.toThrow();
  await publications.retry(auth, "spotify");
  expect(await publications.due(view.publicCapability)).toEqual([]);
  const current = (await threads.get(view.publicCapability))!;
  expect(current.revision).toBe(2);
  expect(current.publications.find(p => p.provider === "spotify")!.status).toBe("pending");
  expect((await publications.target(target!.publisherKey))!.nextAttemptAt).toBe(retryAt);
});

it("propagates a shared Apple publication block to listeners and resets both on manager retry", async () => {
  const threads = new D1ThreadStore(env.DB);
  const publications = new D1PublicationStore(env.DB);
  const accounts = new D1AccountStore(env.DB);
  const secret = nanoid(22);
  const view = await threads.create("Shared failure", secret);
  const auth = (await authorizeManagementCapability(threads, view.publicCapability, secret))!;
  const account = await accounts.upsert("apple", "shared-failure-listener", "Listener");
  const subscription = await accounts.subscribe(account.id, view.publicCapability);
  const target = (await publications.due(view.publicCapability)).find(item => !item.accountId && item.provider === "apple")!;

  await publications.failed(target.publisherKey, 0, "publisher_not_authorized", true, 0);

  expect(await accounts.subscription(account.id, view.publicCapability)).toMatchObject({
    publisherKey: subscription.publisherKey, status: "blocked", blockedReason: "publisher_not_authorized",
  });
  await publications.retry(auth, "apple");
  expect(await publications.canonical(view.publicCapability, "apple")).toMatchObject({ status: "pending" });
  expect(await accounts.subscription(account.id, view.publicCapability)).toMatchObject({ status: "pending", blockedReason: null });
});

it("does not reset Apple listeners when a manager retries Spotify", async () => {
  const threads = new D1ThreadStore(env.DB);
  const publications = new D1PublicationStore(env.DB);
  const accounts = new D1AccountStore(env.DB);
  const secret = nanoid(22);
  const view = await threads.create("Provider-specific retry", secret);
  const auth = (await authorizeManagementCapability(threads, view.publicCapability, secret))!;
  const account = await accounts.upsert("apple", "provider-specific-listener", "Listener");
  const subscription = await accounts.subscribe(account.id, view.publicCapability);
  await threads.manage(auth, { kind: "connect", provider: "spotify", expectedRevision: 0, requestKey: "connect" });
  await env.DB.prepare(`UPDATE thread_subscriptions SET status = 'blocked', blocked_reason = 'publisher_not_authorized'
    WHERE publisher_key = ?`).bind(subscription.publisherKey).run();

  await publications.retry(auth, "spotify");

  expect(await accounts.subscription(account.id, view.publicCapability)).toMatchObject({
    status: "blocked", blockedReason: "publisher_not_authorized",
  });
});
