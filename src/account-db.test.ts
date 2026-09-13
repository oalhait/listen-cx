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

it.each(["spotify", "apple"] as const)("links a second provider from a %s session without replacing either identity", async provider => {
  const prefix = nanoid();
  const store = new D1AccountStore(env.DB);
  const anchor = await store.upsert(provider, `${prefix}:anchor`, "Anchor", "encrypted:anchor");
  const target = await store.upsert(provider === "spotify" ? "apple" : "spotify", `${prefix}:target`, "Target", "encrypted:target");
  expect(anchor.groupId).toBe(anchor.id);
  expect(target.groupId).toBe(target.id);
  expect(await store.connections(anchor.id)).toEqual([anchor]);
  expect(await store.connections("missing")).toEqual([]);
  await store.createSession(anchor.id, `${prefix}:anchor-session`, Date.now() + 60_000);
  await store.createSession(target.id, `${prefix}:target-session`, Date.now() + 60_000);
  expect(await store.linkAccounts(anchor.id, target.id, `${prefix}:anchor-session`)).toBe(true);
  expect(await store.linkAccounts(anchor.id, target.id, `${prefix}:anchor-session`)).toBe(true);
  const linkedTarget = { ...target, groupId: anchor.groupId };
  expect(await store.account(target.id)).toEqual(linkedTarget);
  expect(await store.connections(anchor.id)).toEqual(expect.arrayContaining([anchor, linkedTarget]));
  expect(await store.connections(target.id)).toEqual(await store.connections(anchor.id));
  expect(await store.session(`${prefix}:anchor-session`)).toEqual(anchor);
  expect(await store.session(`${prefix}:target-session`)).toEqual(linkedTarget);
});

it("requires the anchor's unexpired session for new links and idempotent links", async () => {
  const prefix = nanoid();
  const store = new D1AccountStore(env.DB);
  const anchor = await store.upsert("spotify", `${prefix}:anchor`, "Anchor");
  const target = await store.upsert("apple", `${prefix}:target`, "Target");
  await store.createSession(target.id, `${prefix}:target-session`, Date.now() + 60_000);
  await store.createSession(anchor.id, `${prefix}:expired-session`, Date.now() - 1);
  for (const session of ["missing", `${prefix}:target-session`, `${prefix}:expired-session`]) {
    expect(await store.linkAccounts(anchor.id, target.id, session)).toBe(false);
    expect(await store.account(target.id)).toEqual(target);
  }
  await store.createSession(anchor.id, `${prefix}:revoked-session`, Date.now() + 60_000);
  await store.deleteSession(`${prefix}:revoked-session`);
  expect(await store.linkAccounts(anchor.id, target.id, `${prefix}:revoked-session`)).toBe(false);
  expect(await store.account(target.id)).toEqual(target);
  await store.createSession(anchor.id, `${prefix}:active-session`, Date.now() + 60_000);
  expect(await store.linkAccounts("missing", target.id, `${prefix}:active-session`)).toBe(false);
  expect(await store.linkAccounts(anchor.id, "missing", `${prefix}:active-session`)).toBe(false);
  expect(await store.linkAccounts(anchor.id, target.id, `${prefix}:active-session`)).toBe(true);
  await store.deleteSession(`${prefix}:active-session`);
  expect(await store.linkAccounts(anchor.id, target.id, `${prefix}:active-session`)).toBe(false);
});

it("rejects same-provider replacement and cannot take an account from another linked group", async () => {
  const prefix = nanoid();
  const store = new D1AccountStore(env.DB);
  const anchor = await store.upsert("spotify", `${prefix}:anchor`, "Anchor");
  const apple = await store.upsert("apple", `${prefix}:apple`, "Apple");
  const otherSpotify = await store.upsert("spotify", `${prefix}:other`, "Other Spotify");
  const otherApple = await store.upsert("apple", `${prefix}:other`, "Other Apple");
  await store.createSession(anchor.id, `${prefix}:anchor-session`, Date.now() + 60_000);
  await store.createSession(otherSpotify.id, `${prefix}:other-session`, Date.now() + 60_000);
  expect(await store.linkAccounts(anchor.id, otherSpotify.id, `${prefix}:anchor-session`)).toBe(false);
  expect(await store.linkAccounts(anchor.id, apple.id, `${prefix}:anchor-session`)).toBe(true);
  expect(await store.linkAccounts(anchor.id, otherApple.id, `${prefix}:anchor-session`)).toBe(false);
  expect(await store.linkAccounts(otherSpotify.id, apple.id, `${prefix}:other-session`)).toBe(false);
  expect(await store.connections(otherSpotify.id)).toEqual([otherSpotify]);
  expect(await store.account(otherApple.id)).toEqual(otherApple);
  await expect(env.DB.prepare("UPDATE accounts SET group_id = ? WHERE id = ?")
    .bind(anchor.groupId, otherApple.id).run()).rejects.toThrow();
});

it("allows only one competing group to link a provider identity", async () => {
  const prefix = nanoid();
  const store = new D1AccountStore(env.DB);
  const first = await store.upsert("spotify", `${prefix}:first`, "First");
  const second = await store.upsert("spotify", `${prefix}:second`, "Second");
  const target = await store.upsert("apple", `${prefix}:target`, "Target");
  await store.createSession(first.id, `${prefix}:first-session`, Date.now() + 60_000);
  await store.createSession(second.id, `${prefix}:second-session`, Date.now() + 60_000);
  const results = await Promise.all([
    store.linkAccounts(first.id, target.id, `${prefix}:first-session`),
    store.linkAccounts(second.id, target.id, `${prefix}:second-session`),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const winner = results[0] ? first : second;
  expect((await store.account(target.id))!.groupId).toBe(winner.groupId);
});

it("preserves subscriber playlist IDs, publisher keys, credentials and revisions when linking", async () => {
  const prefix = nanoid();
  const store = new D1AccountStore(env.DB);
  const thread = await new D1ThreadStore(env.DB).create("Existing playlists", nanoid(22));
  const spotify = await store.upsert("spotify", `${prefix}:spotify`, "Spotify", "encrypted:spotify");
  const apple = await store.upsert("apple", `${prefix}:apple`, "Apple", "encrypted:apple");
  await store.subscribe(spotify.id, thread.publicCapability);
  await store.subscribe(apple.id, thread.publicCapability);
  await env.DB.prepare(`UPDATE thread_subscriptions SET status = 'synced', applied_revision = 0,
    verified_playlist_id = provider || '-existing', verified_playlist_url = 'https://example.com/' || provider WHERE account_id IN (?, ?)`)
    .bind(spotify.id, apple.id).run();
  const spotifySubscription = await store.subscription(spotify.id, thread.publicCapability);
  const appleSubscription = await store.subscription(apple.id, thread.publicCapability);
  await store.createSession(spotify.id, `${prefix}:session`, Date.now() + 60_000);
  expect(await store.linkAccounts(spotify.id, apple.id, `${prefix}:session`)).toBe(true);
  expect(await store.subscription(spotify.id, thread.publicCapability)).toEqual(spotifySubscription);
  expect(await store.subscription(apple.id, thread.publicCapability)).toEqual(appleSubscription);
  expect(await store.account(spotify.id)).toEqual(spotify);
  expect(await store.account(apple.id)).toEqual({ ...apple, groupId: spotify.groupId });
  expect((await new D1ThreadStore(env.DB).get(thread.publicCapability))!.revision).toBe(0);
});

it("assigns a singleton group to legacy-style raw account inserts", async () => {
  await env.DB.prepare("INSERT INTO accounts(id, provider, provider_subject, label) VALUES ('raw', 'apple', 'raw-subject', 'Raw')").run();
  expect(await new D1AccountStore(env.DB).account("raw")).toMatchObject({ id: "raw", groupId: "raw" });
});

it("backfills existing account groups while retaining stored provider identities and credentials", async () => {
  await env.DB.prepare(`CREATE TABLE legacy_group_accounts (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_subject TEXT NOT NULL, encrypted_credentials TEXT
  )`).run();
  await env.DB.prepare(`INSERT INTO legacy_group_accounts(id, provider, provider_subject, encrypted_credentials)
    VALUES ('existing-spotify', 'spotify', 'spotify-subject', 'encrypted:spotify'),
      ('existing-apple', 'apple', 'apple-subject', 'encrypted:apple')`).run();
  const migration = env.TEST_MIGRATIONS.find(migration => migration.name.includes("0009"))!;
  expect(migration).toBeDefined();
  await env.DB.batch(migration.queries.map(query => env.DB.prepare(query
    .replaceAll("accounts", "legacy_group_accounts")
    .replaceAll("account_default_group", "legacy_account_default_group"))));
  expect((await env.DB.prepare("SELECT * FROM legacy_group_accounts ORDER BY provider").all()).results).toEqual([
    { id: "existing-apple", provider: "apple", provider_subject: "apple-subject", encrypted_credentials: "encrypted:apple", group_id: "existing-apple" },
    { id: "existing-spotify", provider: "spotify", provider_subject: "spotify-subject", encrypted_credentials: "encrypted:spotify", group_id: "existing-spotify" },
  ]);
});
