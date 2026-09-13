import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createApp } from "./app.js";
import { D1LinkStore } from "./db.js";
import { D1ThreadStore } from "./thread-db.js";
import { D1AccountStore } from "./account-db.js";
import { createThreadHistoryApp, ThreadHistoryService } from "./thread-history-app.js";
import { sha256 } from "./thread.js";

const origin = "https://staging.listen.cx";
const threads = new D1ThreadStore(env.DB);
const history = new ThreadHistoryService(env.DB);
const app = createApp({ store: new D1LinkStore(env.DB), threadStore: threads, resolver: { resolve: async () => null }, baseUrl: origin,
  history, connections: createThreadHistoryApp(env.DB, origin, history) });
const key = () => crypto.randomUUID().replaceAll("-", "").slice(0, 22);
const post = (path: string, body: unknown, cookie = "") => app.request(origin + path, { method: "POST",
  headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-Listen-Action": "thread" }, body: JSON.stringify(body) });
const get = (path: string, cookie = "") => app.request(origin + path, { headers: { Cookie: cookie } });
const cookieOf = (response: Response, prefix: string) => response.headers.getSetCookie().find(value => value.startsWith(prefix + "="))!.split(";")[0]!;
async function account() {
  const store = new D1AccountStore(env.DB);
  const value = await store.upsert("spotify", crypto.randomUUID(), "Music account");
  const token = btoa(crypto.randomUUID()).slice(0, 43);
  await store.createSession(value.id, await sha256(token), Date.now() + 600000);
  return { id: value.id, cookie: `listen_account=${token}` };
}

it("automatically remembers created Threads in this browser, including creation retries", async () => {
  const body = { title: "My first Thread", creationKey: key() };
  const response = await post("/api/threads", body);
  expect(response.status).toBe(201);
  const historyCookie = cookieOf(response, "listen_thread_history");
  expect(response.headers.getSetCookie().join(";")).toContain("HttpOnly");
  expect(response.headers.getSetCookie().join(";")).toContain("Secure");
  await post("/api/threads", body, historyCookie);
  const list = await get("/api/my-threads", historyCookie);
  expect(list.headers.get("cache-control")).toBe("private, no-store");
  const result = await list.json() as { threads: { title: string; songCount: number }[] };
  expect(result.threads).toHaveLength(1);
  expect(result.threads[0]).toMatchObject({ title: body.title, songCount: 0 });
  expect(JSON.stringify(result)).not.toContain(body.creationKey);
  expect(await (await get("/api/my-threads")).json()).toMatchObject({ threads: [] });
});

it("keeps account history across sessions and separates it from other accounts or browser cookies", async () => {
  const owner = await account();
  const other = await account();
  await post("/api/threads", { title: "Account Thread", creationKey: key() }, owner.cookie);
  expect(await (await get("/api/my-threads", owner.cookie)).json()).toMatchObject({ signedIn: true, threads: [{ title: "Account Thread" }] });
  expect(await (await get("/api/my-threads", other.cookie)).json()).toMatchObject({ threads: [] });
  expect(await (await get("/api/my-threads", "listen_account=invalid")).json()).toMatchObject({ signedIn: false, threads: [] });
  const store = new D1AccountStore(env.DB);
  const token = btoa(crypto.randomUUID()).slice(0, 43);
  await store.createSession(owner.id, await sha256(token), Date.now() + 600000);
  expect(await (await get("/api/my-threads", `listen_account=${token}`)).json()).toMatchObject({ threads: [{ title: "Account Thread" }] });
});

it("recovers historical Threads only with a verified private management capability", async () => {
  const secret = key();
  const old = await threads.create("Recovered older Thread", secret);
  expect(await (await get("/api/my-threads")).json()).toMatchObject({ threads: [] });
  expect((await post("/api/my-threads/import", { capability: old.publicCapability, managementCapability: key() })).status).toBe(403);
  const response = await post("/api/my-threads/import", { capability: old.publicCapability, managementCapability: secret });
  expect(response.status).toBe(200);
  const cookie = cookieOf(response, "listen_thread_history");
  expect(await (await get("/api/my-threads", cookie)).json()).toMatchObject({ threads: [{ title: "Recovered older Thread" }] });
  const text = await (await get("/api/my-threads", cookie)).text();
  expect(text).not.toContain(secret);
  expect(text).not.toContain("browser_digest");
  expect((await app.request(origin + "/api/my-threads/import", { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify({ capability: old.publicCapability, managementCapability: secret }) })).status).toBe(403);
});

it("remembers an older Thread when its existing manager opens it, but never from a sharing link", async () => {
  const secret = key();
  const old = await threads.create("Existing manager", secret);
  expect((await get(`/t/${old.publicCapability}`)).headers.get("set-cookie")).toBeNull();
  const managed = await get(`/t/${old.publicCapability}`, `thread_manage_${old.publicCapability}=${secret}`);
  const cookie = cookieOf(managed, "listen_thread_history");
  expect(await (await get("/api/my-threads", cookie)).json()).toMatchObject({ threads: [{ title: "Existing manager" }] });
});

it("saves anonymous history to an account only through an explicit signed-in action and deduplicates it", async () => {
  const response = await post("/api/threads", { title: "Before signing in", creationKey: key() });
  const browserCookie = cookieOf(response, "listen_thread_history");
  expect((await post("/api/my-threads/save", {}, browserCookie)).status).toBe(401);
  const owner = await account();
  expect(await (await get("/api/my-threads", owner.cookie)).json()).toMatchObject({ threads: [] });
  const combined = `${owner.cookie}; ${browserCookie}`;
  expect((await post("/api/my-threads/save", {}, combined)).status).toBe(200);
  await post("/api/my-threads/save", {}, combined);
  expect(await (await get("/api/my-threads", owner.cookie)).json()).toMatchObject({ threads: [{ title: "Before signing in" }] });
  const result = await (await get("/api/my-threads", combined)).json() as { threads: unknown[] };
  expect(result.threads).toHaveLength(1);
});

it("prepares browser history before creation so separate tabs reuse the same browser identity", async () => {
  const page = await get("/threads/new");
  const cookie = cookieOf(page, "listen_thread_history");
  expect((await get("/threads/new", cookie)).headers.get("set-cookie")).toBeNull();
  expect((await get("/threads", cookie)).headers.get("set-cookie")).toBeNull();
  await post("/api/threads", { title: "Tab one", creationKey: key() }, cookie);
  await post("/api/threads", { title: "Tab two", creationKey: key() }, cookie);
  const result = await (await get("/api/my-threads", cookie)).json() as { threads: { title: string }[] };
  expect(result.threads.map(thread => thread.title)).toEqual(["Tab two", "Tab one"]);
});
