import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { D1AccountStore } from "./account-db.js";
import { sha256 } from "./thread.js";

export async function currentAccount(c: Context, db: D1Database) {
  const token = getCookie(c, "listen_account");
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? new D1AccountStore(db).session(await sha256(token)) : null;
}
