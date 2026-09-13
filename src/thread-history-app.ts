import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { currentAccount } from "./account-session.js";
import { D1ThreadHistoryStore, type HistoryOwner } from "./thread-history-db.js";
import { D1ThreadStore } from "./thread-db.js";
import { threadHistoryPage } from "./thread-history-page.js";
import { makePkce } from "./music-auth.js";
import { isRecord, readBoundedJson } from "./request.js";
import { sha256, ThreadError } from "./thread.js";
import { authorizeManagementCapability, isSameOriginAction, setManagementCookie, THREAD_SECURITY_HEADERS } from "./thread-security.js";

const cookieName = "listen_thread_history";

export class ThreadHistoryService {
  readonly store: D1ThreadHistoryStore;
  constructor(private readonly db: D1Database) { this.store = new D1ThreadHistoryStore(db); }

  async owner(c: Context, create = false): Promise<HistoryOwner> {
    const account = await currentAccount(c, this.db);
    let token = getCookie(c, cookieName);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) token = undefined;
    if (!token && create && !account) {
      token = (await makePkce()).challenge;
      setCookie(c, cookieName, token, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:",
        sameSite: "Lax", path: "/", maxAge: 365 * 86400 });
    }
    return { accountId: account?.id ?? null, browserDigest: token ? await sha256(token) : null };
  }

  async prepare(c: Context): Promise<void> { await this.owner(c, true); }

  async remember(c: Context, capability: string): Promise<void> {
    await this.store.remember(capability, await this.owner(c, true));
  }
}

export function createThreadHistoryApp(db: D1Database, baseUrl: string, history: ThreadHistoryService) {
  const app = new Hono();
  for (const path of ["/threads", "/api/my-threads", "/api/my-threads/*"]) app.use(path, async (c, next) => {
    for (const [name, value] of Object.entries(THREAD_SECURITY_HEADERS)) c.header(name, value);
    if (c.req.method === "POST" && !isSameOriginAction(c.req.raw, baseUrl)) return c.json({ error: "Use this site's Thread history controls." }, 403);
    await next();
  });
  app.onError((error, c) => error instanceof ThreadError
    ? c.json({ error: error.message, code: error.code }, error.status)
    : c.json({ error: "Could not load your Threads. Try again." }, 500));
  const snapshot = async (c: Context) => {
    const owner = await history.owner(c);
    return { signedIn: Boolean(owner.accountId), hasBrowserHistory: Boolean(owner.browserDigest), threads: await history.store.list(owner) };
  };
  app.get("/threads", async c => {
    await history.prepare(c);
    return c.html(threadHistoryPage());
  });
  app.get("/api/my-threads", async c => c.json(await snapshot(c)));
  app.post("/api/my-threads/import", async c => {
    const body = await readBoundedJson(c.req.raw);
    if (!body.ok || !isRecord(body.value) || Object.keys(body.value).some(key => !["capability", "managementCapability"].includes(key))) {
      throw new ThreadError(400, "invalid_input", "Paste a valid private management link.");
    }
    const { capability, managementCapability } = body.value;
    if (typeof capability !== "string" || typeof managementCapability !== "string"
      || !await authorizeManagementCapability(new D1ThreadStore(db), capability, managementCapability)) {
      throw new ThreadError(403, "invalid_management_link", "This private management link could not be verified.");
    }
    await history.remember(c, capability);
    setManagementCookie(c, capability, managementCapability);
    return c.json({ saved: true });
  });
  app.post("/api/my-threads/save", async c => {
    const body = await readBoundedJson(c.req.raw);
    if (!body.ok || !isRecord(body.value) || Object.keys(body.value).length) throw new ThreadError(400, "invalid_input", "Send an empty request.");
    const owner = await history.owner(c);
    if (!owner.accountId) throw new ThreadError(401, "sign_in_required", "Sign in to save your history across devices.");
    if (owner.browserDigest) await history.store.saveBrowserHistory(owner.accountId, owner.browserDigest);
    return c.json(await snapshot(c));
  });
  return app;
}
