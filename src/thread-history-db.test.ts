import { env } from "cloudflare:workers";
import { nanoid } from "nanoid";
import { expect, it } from "vitest";
import { D1AccountStore } from "./account-db.js";
import { D1ThreadStore } from "./thread-db.js";
import { D1ThreadHistoryStore } from "./thread-history-db.js";

it("unions both linked accounts and the current browser without exposing another account's history", async () => {
  const prefix = nanoid();
  const accounts = new D1AccountStore(env.DB);
  const history = new D1ThreadHistoryStore(env.DB);
  const threads = new D1ThreadStore(env.DB);
  const spotify = await accounts.upsert("spotify", `${prefix}:spotify`, "Spotify");
  const apple = await accounts.upsert("apple", `${prefix}:apple`, "Apple");
  const unrelated = await accounts.upsert("apple", `${prefix}:unrelated`, "Unrelated");
  const spotifyThread = await threads.create("Spotify history", nanoid(22));
  const appleThread = await threads.create("Apple history", nanoid(22));
  const browserThread = await threads.create("Browser history", nanoid(22));
  const unrelatedThread = await threads.create("Private history", nanoid(22));
  await history.remember(spotifyThread.publicCapability, { accountId: spotify.id, browserDigest: null });
  await history.remember(appleThread.publicCapability, { accountId: apple.id, browserDigest: null });
  await history.remember(spotifyThread.publicCapability, { accountId: apple.id, browserDigest: null });
  await history.remember(browserThread.publicCapability, { accountId: null, browserDigest: `${prefix}:browser` });
  await history.remember(unrelatedThread.publicCapability, { accountId: unrelated.id, browserDigest: null });
  expect((await history.list({ accountId: spotify.id, browserDigest: null })).map(entry => entry.capability))
    .toEqual([spotifyThread.publicCapability]);
  await accounts.createSession(spotify.id, `${prefix}:session`, Date.now() + 60_000);
  expect(await accounts.linkAccounts(spotify.id, apple.id, `${prefix}:session`)).toBe(true);
  for (const accountId of [spotify.id, apple.id]) {
    const entries = await history.list({ accountId, browserDigest: `${prefix}:browser` });
    expect(entries.map(entry => entry.capability)).toEqual([
      browserThread.publicCapability, appleThread.publicCapability, spotifyThread.publicCapability,
    ]);
    expect(entries.every(entry => entry.songCount === 0 && entry.closedAt === null)).toBe(true);
  }
  expect((await history.list({ accountId: unrelated.id, browserDigest: null })).map(entry => entry.capability))
    .toEqual([unrelatedThread.publicCapability]);
  expect((await history.list({ accountId: null, browserDigest: `${prefix}:browser` })).map(entry => entry.capability))
    .toEqual([browserThread.publicCapability]);
  expect(await history.list({ accountId: "missing", browserDigest: null })).toEqual([]);
});

it("includes connected subscriptions once and keeps owned Threads identified as owner", async () => {
  const prefix = nanoid();
  const accounts = new D1AccountStore(env.DB);
  const history = new D1ThreadHistoryStore(env.DB);
  const threads = new D1ThreadStore(env.DB);
  const spotify = await accounts.upsert("spotify", `${prefix}:spotify`, "Spotify");
  const apple = await accounts.upsert("apple", `${prefix}:apple`, "Apple");
  await accounts.createSession(spotify.id, `${prefix}:session`, Date.now() + 60_000);
  expect(await accounts.linkAccounts(spotify.id, apple.id, `${prefix}:session`)).toBe(true);
  const owned = await threads.create("Owned", nanoid(22));
  const subscribed = await threads.create("Subscribed", nanoid(22));
  const disconnected = await threads.create("Disconnected", nanoid(22));
  await history.remember(owned.publicCapability, { accountId: spotify.id, browserDigest: null });
  await accounts.subscribe(spotify.id, owned.publicCapability);
  await accounts.subscribe(spotify.id, subscribed.publicCapability);
  await accounts.subscribe(apple.id, subscribed.publicCapability);
  await accounts.subscribe(apple.id, disconnected.publicCapability);
  await accounts.unsubscribe(apple.id, disconnected.publicCapability);

  expect(await history.list({ accountId: apple.id, browserDigest: null })).toEqual(expect.arrayContaining([
    expect.objectContaining({ capability: owned.publicCapability, relationship: "owner" }),
    expect.objectContaining({ capability: subscribed.publicCapability, relationship: "subscriber" }),
  ]));
  expect((await history.list({ accountId: apple.id, browserDigest: null })).filter(entry => entry.capability === subscribed.publicCapability)).toHaveLength(1);
  expect((await history.list({ accountId: apple.id, browserDigest: null })).some(entry => entry.capability === disconnected.publicCapability)).toBe(false);
});

it("keeps browser history saved before linking visible to either provider login", async () => {
  const prefix = nanoid();
  const accounts = new D1AccountStore(env.DB);
  const history = new D1ThreadHistoryStore(env.DB);
  const spotify = await accounts.upsert("spotify", `${prefix}:spotify`, "Spotify");
  const apple = await accounts.upsert("apple", `${prefix}:apple`, "Apple");
  const thread = await new D1ThreadStore(env.DB).create("Saved from browser", nanoid(22));
  await history.remember(thread.publicCapability, { accountId: null, browserDigest: `${prefix}:browser` });
  await history.saveBrowserHistory(apple.id, `${prefix}:browser`);
  await accounts.createSession(spotify.id, `${prefix}:session`, Date.now() + 60_000);
  expect(await accounts.linkAccounts(spotify.id, apple.id, `${prefix}:session`)).toBe(true);
  await history.saveBrowserHistory(spotify.id, `${prefix}:browser`);
  for (const accountId of [spotify.id, apple.id]) {
    expect((await history.list({ accountId, browserDigest: null })).map(entry => entry.capability))
      .toEqual([thread.publicCapability]);
  }
  expect((await env.DB.prepare("SELECT account_id FROM thread_history WHERE account_id IS NOT NULL").all()).results)
    .toEqual(expect.arrayContaining([{ account_id: apple.id }, { account_id: spotify.id }]));
});
