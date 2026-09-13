import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { makePkce } from "./music-auth.js";
import type {
  CollaborationIdentity,
  CollaborationSnapshot,
} from "./thread-collaboration.js";
import type { D1ThreadCollaborationStore } from "./thread-collaboration-db.js";
import { sha256 } from "./thread.js";

const PARTICIPANT_COOKIE = "listen_jam_participant";
const PARTICIPANT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface CollaborationAccount {
  id: string;
}
/**
 * Resolves a browser or signed-in account to the private identity used by the
 * collaboration store. Raw browser capabilities stay in an HttpOnly cookie;
 * only their digest crosses the database boundary.
 */
export class ThreadCollaborationService {
  constructor(
    readonly store: D1ThreadCollaborationStore,
    private readonly account?: (context: Context) => Promise<CollaborationAccount | null>,
  ) {}

  async identity(context: Context, createAnonymous = false): Promise<CollaborationIdentity | null> {
    const account = await this.account?.(context);
    if (account) return { kind: "account", accountId: account.id };

    let token = getCookie(context, PARTICIPANT_COOKIE);
    if (!token || !PARTICIPANT_TOKEN_PATTERN.test(token)) token = undefined;
    if (!token && createAnonymous) {
      token = (await makePkce()).challenge;
      setCookie(context, PARTICIPANT_COOKIE, token, {
        httpOnly: true,
        secure: new URL(context.req.url).protocol === "https:",
        sameSite: "Strict",
        path: "/",
        maxAge: 365 * 24 * 60 * 60,
      });
    }
    return token ? { kind: "anonymous", digest: await sha256(token) } : null;
  }

  async snapshot(context: Context, capability: string): Promise<CollaborationSnapshot | null> {
    return this.store.snapshot(capability, await this.identity(context, true));
  }
}
