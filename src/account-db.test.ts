import { env } from "cloudflare:workers";
import { nanoid } from "nanoid";
import { expect, it } from "vitest";
import { D1AccountStore } from "./account-db.js";
import { D1ThreadStore } from "./thread-db.js";

it("keeps provider accounts separate and preserves credentials unless explicitly replaced", async () => {
  const store = new D1AccountStore(env.DB);
  const account = await store.upsert("spotify", "listener", "First", "encrypted:first");
  expect(await store.upsert("spotify", "listener", "Renamed")).toEqual({ ...account, label: "Renamed" });
  expect((await store.upsert("apple", "listener", "Apple")).id).not.toBe(account.id);
  await store.setCredentials(account.id, "encrypted:next");
  expect((await store.account(account.id))!.credentials).toBe("encrypted:next");
  expect((await store.upsert("spotify", "listener", "Last", "encrypted:last")).credentials).toBe("encrypted:last");
  expect(await store.account("missing")).toBeNull();
  await expect(env.DB.prepare("UPDATE accounts SET provider = 'apple' WHERE id = ?").bind(account.id).run()).rejects.toThrow();
});

it("resolves only unexpired sessions and revokes a session without affecting another", async () => {
  const store = new D1AccountStore(env.DB);
  const account = await store.upsert("spotify", "listener", "Listener");
  await store.createSession(account.id, "active-hash", Date.now() + 60_000);
  await store.createSession(account.id, "other-hash", Date.now() + 60_000);
  await store.createSession(account.id, "expired-hash", Date.now() - 1);
  expect(await store.session("active-hash")).toEqual(account);
  expect(await store.session("expired-hash")).toBeNull();
  expect(await store.session("missing-hash")).toBeNull();
  await store.deleteSession("active-hash");
  expect(await store.session("active-hash")).toBeNull();
  expect(await store.session("other-hash")).toEqual(account);
});

it("consumes OAuth state only once for its initiating browser before expiry", async () => {
  const store = new D1AccountStore(env.DB);
  await store.putOAuth("state-hash", "browser-hash", "encrypted:payload", Date.now() + 60_000);
  expect(await store.consumeOAuth("state-hash", "wrong-browser")).toBeNull();
  const results = await Promise.all([
    store.consumeOAuth("state-hash", "browser-hash"),
    store.consumeOAuth("state-hash", "browser-hash"),
  ]);
  expect(results.filter(Boolean)).toEqual([{ payload: "encrypted:payload" }]);
  await store.putOAuth("expired", "browser-hash", "encrypted:payload", Date.now() - 1);
  expect(await store.consumeOAuth("expired", "browser-hash")).toBeNull();
});

it("creates independent subscriber destinations without changing the collaborative Thread revision", async () => {
  const store = new D1AccountStore(env.DB);
  const threads = new D1ThreadStore(env.DB);
  const thread = await threads.create("Together", nanoid(22));
  const first = await store.upsert("spotify", "first", "First");
  const second = await store.upsert("spotify", "second", "Second");
  const apple = await store.upsert("apple", "third", "Third");
  const subscription = await store.subscribe(first.id, thread.publicCapability);
  expect(subscription).toMatchObject({ accountId: first.id, capability: thread.publicCapability, provider: "spotify", connected: true, requestedRevision: 0, appliedRevision: null, status: "pending" });
  expect(await store.subscribe(first.id, thread.publicCapability)).toEqual(subscription);
  expect((await store.subscribe(second.id, thread.publicCapability)).publisherKey).not.toBe(subscription.publisherKey);
  expect((await store.subscribe(apple.id, thread.publicCapability)).provider).toBe("apple");
  expect(await store.subscriptions(first.id)).toEqual([subscription]);
  expect((await threads.get(thread.publicCapability))!.revision).toBe(0);
  expect(await store.subscription("missing", thread.publicCapability)).toBeNull();
  await expect(store.subscribe(first.id, nanoid(22))).rejects.toMatchObject({ code: "not_found" });
});

it("queues connected subscribers on revisions and reuses a disconnected destination when resubscribed", async () => {
  const store = new D1AccountStore(env.DB);
  const thread = await new D1ThreadStore(env.DB).create("Together", nanoid(22));
  const account = await store.upsert("spotify", "first", "First");
  const subscription = await store.subscribe(account.id, thread.publicCapability);
  await env.DB.prepare(`UPDATE thread_subscriptions SET status = 'synced', applied_revision = 0,
    verified_playlist_id = 'existing', verified_playlist_url = 'https://open.spotify.com/playlist/existing'
    WHERE publisher_key = ?`).bind(subscription.publisherKey).run();
  expect((await store.subscribe(account.id, thread.publicCapability)).status).toBe("synced");
  await env.DB.prepare("UPDATE threads SET revision = revision + 1 WHERE public_capability = ?").bind(thread.publicCapability).run();
  expect(await store.subscription(account.id, thread.publicCapability)).toMatchObject({ status: "pending", requestedRevision: 1, appliedRevision: 0 });
  await store.unsubscribe(account.id, thread.publicCapability);
  expect(await store.subscription(account.id, thread.publicCapability)).toMatchObject({ connected: false });
  await env.DB.prepare("UPDATE threads SET revision = revision + 1 WHERE public_capability = ?").bind(thread.publicCapability).run();
  expect((await store.subscription(account.id, thread.publicCapability))!.requestedRevision).toBe(1);
  expect(await store.subscribe(account.id, thread.publicCapability)).toMatchObject({ connected: true, requestedRevision: 2, status: "pending", publisherKey: subscription.publisherKey, verifiedPlaylistId: "existing" });
});

it("retries only the account's connected subscription while retaining the provider deadline", async () => {
  const store = new D1AccountStore(env.DB);
  const thread = await new D1ThreadStore(env.DB).create("Together", nanoid(22));
  const first = await store.upsert("spotify", "first", "First");
  const second = await store.upsert("spotify", "second", "Second");
  const subscription = await store.subscribe(first.id, thread.publicCapability);
  await store.subscribe(second.id, thread.publicCapability);
  const deadline = Date.now() + 60_000;
  await env.DB.prepare("UPDATE thread_subscriptions SET status = 'failed', failure_code = 'rate_limited', next_attempt_at = ?").bind(deadline).run();
  await store.retry(first.id, thread.publicCapability);
  expect(await store.subscription(first.id, thread.publicCapability)).toMatchObject({ status: "pending", failureCode: null, nextAttemptAt: deadline });
  expect(await store.subscription(second.id, thread.publicCapability)).toMatchObject({ status: "failed" });
  await store.unsubscribe(first.id, thread.publicCapability);
  await store.retry(first.id, thread.publicCapability);
  expect((await store.subscription(first.id, thread.publicCapability))!.connected).toBe(false);
  expect((await store.subscribe(first.id, thread.publicCapability)).nextAttemptAt).toBe(deadline);
  await expect(env.DB.prepare("UPDATE thread_subscriptions SET provider = 'apple' WHERE publisher_key = ?").bind(subscription.publisherKey).run()).rejects.toThrow();
});
