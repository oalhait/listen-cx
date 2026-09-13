import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { D1ThreadStore } from "./thread-db.js";
import { D1PublicationStore } from "./publication-db.js";
import { authorizeManagementCapability, managementCookie, isSameOriginAction, THREAD_SECURITY_HEADERS, type ManagementAuthorization } from "./thread-security.js";
import { isThreadCapability, sha256, ThreadError } from "./thread.js";
import { availableConnections } from "./publishing-bindings.js";
import { MusicAuthError, unseal, type Sealed } from "./music-auth.js";
import { appleDeveloperToken, type OAuthReturn } from "./music-connection-store.js";
import { musicConnectionsPage } from "./music-connections-page.js";
import { readBoundedJson, isRecord } from "./request.js";
import type { RuntimeEnv } from "./thread-publisher.js";
import type { Provider } from "./urls.js";

const callbackPath = "/connections/spotify/callback";
const cookieName = "listen_spotify_browser";

function spotifyReturnPage(capability: string, result: "authorized" | "error"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spotify connection — listen.cx</title><script src="/music-connection-return.js" type="module"></script></head><body><p>${result === "authorized" ? "Spotify authorization finished." : "Spotify authorization did not finish."}</p><a id="continue-connection" href="/t/${capability}/manage/apps?spotify=${result}">Continue to your Thread</a></body></html>`;
}

export async function connectionTarget(env: RuntimeEnv, capability: string, provider: Provider): Promise<string> {
  const row = await env.DB.withSession("first-primary").prepare(`SELECT p.publisher_key AS publisherKey FROM thread_publications p
    JOIN threads t ON t.id = p.thread_id WHERE t.public_capability = ? AND p.provider = ?`).bind(capability, provider).first<{ publisherKey: string }>();
  if (!row?.publisherKey) throw new ThreadError(404, "not_found", "Thread not found.");
  return row.publisherKey;
}

export async function requireMusicConnection(env: RuntimeEnv, authorization: ManagementAuthorization, provider: Provider): Promise<void> {
  const key = await connectionTarget(env, authorization.publicCapability, provider);
  if (!availableConnections(env).includes(provider) || !(await env.THREAD_PUBLISHER.getByName(key).connectionStatus(key, provider)).authorized) {
    throw new ThreadError(403, "authorization_required", "Connect your music account before starting sync.");
  }
}

export function createMusicConnectionsApp(env: RuntimeEnv, baseUrl: string, onChange: (capability: string) => void) {
  const app = new Hono();
  const threads = new D1ThreadStore(env.DB);
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(THREAD_SECURITY_HEADERS)) c.header(name, value);
    if (c.req.method === "POST" && !isSameOriginAction(c.req.raw, baseUrl)) return c.json({ error: "Use this site's music connection controls.", code: "forbidden_origin" }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ThreadError) return c.json({ error: error.message, code: error.code }, error.status);
    const code = error instanceof MusicAuthError ? error.code : "connection_failed";
    return c.json({ error: "Could not connect the account. Try again with the account that owns this Thread's playlist.", code }, 400);
  });
  async function manager(c: Context, capability: string) {
    const secret = managementCookie(c, capability);
    const auth = secret ? await authorizeManagementCapability(threads, capability, secret) : null;
    if (!auth) throw new ThreadError(403, "forbidden", "Open this Thread's private management link to connect music apps.");
    return auth;
  }
  async function fields(c: Context, allowed: string[]) {
    const parsed = await readBoundedJson(c.req.raw, 16_000);
    if (!parsed.ok) throw new ThreadError(parsed.status, "invalid_input", "Send a valid music connection request.");
    if (!isRecord(parsed.value) || Object.keys(parsed.value).some(key => !allowed.includes(key))) throw new ThreadError(400, "invalid_input", "Send a valid music connection request.");
    return parsed.value;
  }
  async function snapshot(capability: string) {
    const thread = await threads.get(capability);
    if (!thread) throw new ThreadError(404, "not_found", "Thread not found.");
    const providers = await Promise.all(thread.publications.map(async publication => {
      const key = await connectionTarget(env, capability, publication.provider);
      return { provider: publication.provider, available: availableConnections(env).includes(publication.provider), connected: publication.connected,
        ...await env.THREAD_PUBLISHER.getByName(key).connectionStatus(key, publication.provider) };
    }));
    return { thread, providers };
  }
  app.get("/t/:capability/manage/apps", async c => {
    const cap = c.req.param("capability");
    await manager(c, cap);
    const data = await snapshot(cap);
    c.header("Referrer-Policy", "strict-origin");
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'self' https://js-cdn.music.apple.com; connect-src 'self' https://*.apple.com https://*.mzstatic.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src https://*.apple.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    return c.html(musicConnectionsPage(data.thread, data.providers));
  });
  app.get("/t/:capability/manage/apps/status", async c => {
    const cap = c.req.param("capability");
    await manager(c, cap);
    return c.json(await snapshot(cap));
  });
  app.post("/t/:capability/manage/apps/spotify/start", async c => {
    const cap = c.req.param("capability");
    await manager(c, cap);
    await fields(c, []);
    if (!availableConnections(env).includes("spotify")) throw new ThreadError(503, "provider_unavailable", "Spotify is not available yet.");
    const browser = crypto.randomUUID();
    const key = await connectionTarget(env, cap, "spotify");
    const redirectUri = env.SPOTIFY_REDIRECT_URI ?? `${new URL(baseUrl).origin}${callbackPath}`;
    const result = await env.THREAD_PUBLISHER.getByName(key).beginSpotifyConnection(key, cap, await sha256(browser), redirectUri);
    setCookie(c, cookieName, browser, { httpOnly: true, secure: new URL(baseUrl).protocol === "https:", sameSite: "Lax", path: "/", maxAge: 600 });
    return c.json({ url: result.url });
  });
  app.get(callbackPath, async c => {
    let target: OAuthReturn | undefined;
    try {
      const state = c.req.query("state") ?? "";
      const browser = getCookie(c, cookieName);
      if (!browser || state.length > 3000 || !state.startsWith("threads.")) throw new Error();
      target = await unseal<OAuthReturn>(env.PUBLISHER_ENCRYPTION_KEY!, "spotify-return", JSON.parse(atob(state.slice(8))) as Sealed);
      if (!isThreadCapability(target.capability) || !Number.isSafeInteger(target.expiresAt) || target.expiresAt <= Date.now()
        || typeof target.nonce !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(target.publisherKey)) throw new Error();
      if (await connectionTarget(env, target.capability, "spotify") !== target.publisherKey) throw new Error();
      const code = c.req.query("code");
      if (!code || code.length > 2000 || c.req.query("error")) throw new Error();
      await env.THREAD_PUBLISHER.getByName(target.publisherKey).finishSpotifyConnection(target.publisherKey, target.nonce, await sha256(browser), code);
      deleteCookie(c, cookieName, { path: "/" });
      await env.DB.withSession("first-primary").prepare(`UPDATE thread_publications SET status = 'pending', blocked_reason = NULL, failure_code = NULL
        WHERE publisher_key = ? AND connected = 1 AND status != 'synced'`).bind(target.publisherKey).run();
      onChange(target.capability);
      return c.html(spotifyReturnPage(target.capability, "authorized"));
    } catch {
      deleteCookie(c, cookieName, { path: "/" });
      if (target && isThreadCapability(target.capability)) return c.html(spotifyReturnPage(target.capability, "error"));
      return c.json({ error: "This sign-in link expired. Start again from your Thread.", code: "invalid_callback" }, 400);
    }
  });
  app.post("/t/:capability/manage/apps/apple/token", async c => {
    await manager(c, c.req.param("capability"));
    await fields(c, []);
    return c.json({ developerToken: await appleDeveloperToken(env) });
  });
  app.post("/t/:capability/manage/apps/apple/authorize", async c => {
    const cap = c.req.param("capability");
    const authorization = await manager(c, cap);
    const body = await fields(c, ["musicUserToken"]);
    if (typeof body.musicUserToken !== "string") throw new ThreadError(400, "invalid_input", "Authorize Apple Music to continue.");
    const key = await connectionTarget(env, cap, "apple");
    await env.THREAD_PUBLISHER.getByName(key).authorizeAppleConnection(key, body.musicUserToken);
    await new D1PublicationStore(env.DB).retry(authorization, "apple");
    onChange(cap);
    return c.json({ authorized: true });
  });
  return app;
}
