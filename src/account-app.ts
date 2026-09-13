import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { D1AccountStore, type Account, type Subscription } from "./account-db.js";
import { accountPage } from "./account-page.js";
import { appleDeveloperToken } from "./music-connection-store.js";
import { exchangeSpotifyCode, getSpotifyAccount, makePkce, MusicAuthError, seal, spotifyAuthorizeUrl, unseal, type Sealed } from "./music-auth.js";
import { availableConnections } from "./publishing-bindings.js";
import { isSameOriginAction, THREAD_SECURITY_HEADERS } from "./thread-security.js";
import { isThreadCapability, sha256, ThreadError } from "./thread.js";
import { isRecord, readBoundedJson } from "./request.js";
import type { RuntimeEnv } from "./thread-publisher.js";
import type { Provider } from "./urls.js";

const sessionCookie = "listen_account";
const browserCookie = "listen_login_browser";
type PendingLogin = { provider: Provider; verifier: string; redirectUri: string; returnTo: string; accountId: string | null; sessionHash: string | null };

export function publicSubscription(value: Subscription | null) {
  if (!value) return null;
  return { capability: value.capability, title: value.title, provider: value.provider, connected: value.connected,
    status: value.status, requestedRevision: value.requestedRevision, appliedRevision: value.appliedRevision,
    blockedReason: value.blockedReason, failureCode: value.failureCode,
    verifiedPlaylistId: value.verifiedPlaylistId, verifiedPlaylistUrl: value.verifiedPlaylistUrl };
}

export function createAccountApp(env: RuntimeEnv, baseUrl: string, onChange: (capability: string) => void) {
  const app = new Hono();
  const store = new D1AccountStore(env.DB);
  const origin = new URL(baseUrl).origin;
  const appleAvailable = () => Boolean(availableConnections(env).includes("apple") && env.APPLE_SIGN_IN_CLIENT_ID
    && env.APPLE_SIGN_IN_KEY_ID && env.APPLE_SIGN_IN_TEAM_ID && env.APPLE_SIGN_IN_PRIVATE_KEY_P8);
  async function current(c: Context): Promise<Account | null> {
    const token = getCookie(c, sessionCookie);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? store.session(await sha256(token)) : null;
  }
  async function signedIn(c: Context): Promise<Account> {
    const account = await current(c);
    if (!account) throw new ThreadError(401, "sign_in_required", "Sign in to your music account first.");
    return account;
  }
  async function fields(c: Context, allowed: string[]) {
    const parsed = await readBoundedJson(c.req.raw, 16000);
    if (!parsed.ok || !isRecord(parsed.value) || Object.keys(parsed.value).some(key => !allowed.includes(key))) {
      throw new ThreadError(400, "invalid_input", "Send a valid account request.");
    }
    return parsed.value;
  }
  async function binding(c: Context, account: Account): Promise<string> {
    return JSON.stringify(await seal(env.PUBLISHER_ENCRYPTION_KEY!, "apple-library-grant", {
      accountId: account.id, sessionHash: await sha256(getCookie(c, sessionCookie)!), expiresAt: Date.now() + 1800000,
    }));
  }
  async function validateBinding(c: Context, account: Account, value: unknown) {
    if (typeof value !== "string" || value.length > 2000) throw new ThreadError(403, "session_changed", "Your account changed. Refresh settings before connecting music.");
    try {
      const grant = await unseal<{ accountId: string; sessionHash: string; expiresAt: number }>(env.PUBLISHER_ENCRYPTION_KEY!, "apple-library-grant", JSON.parse(value));
      if (grant.accountId !== account.id || grant.sessionHash !== await sha256(getCookie(c, sessionCookie)!)
        || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) throw new Error();
    } catch { throw new ThreadError(403, "session_changed", "Your account changed. Refresh settings before connecting music."); }
  }
  async function saveCredentials(account: Account, value: unknown) {
    const encrypted = JSON.stringify(await seal(env.PUBLISHER_ENCRYPTION_KEY!, `account:${account.id}`, value));
    await env.THREAD_PUBLISHER.getByName(`account_${account.id}`).setAccountCredentials(account.id, encrypted);
    const subscriptions = await store.subscriptions(account.id);
    for (const subscription of subscriptions.filter(value => value.connected)) {
      await store.retry(account.id, subscription.capability);
      onChange(subscription.capability);
    }
  }
  async function session(c: Context, account: Account, previousHash: string | null) {
    const token = (await makePkce()).challenge;
    const tokenHash = await sha256(token);
    const expiresAt = Date.now() + 30 * 86400000;
    if (previousHash) {
      if (!await store.rotateSession(account.id, previousHash, tokenHash, expiresAt)) throw new Error("session_changed");
    } else {
      await store.createSession(account.id, tokenHash, expiresAt);
    }
    setCookie(c, sessionCookie, token, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "Lax", path: "/", maxAge: 30 * 86400 });
  }
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(THREAD_SECURITY_HEADERS)) c.header(name, value);
    if (c.req.method === "POST" && !isSameOriginAction(c.req.raw, baseUrl)) return c.json({ error: "Use this site's account controls.", code: "forbidden_origin" }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ThreadError) return c.json({ error: error.message, code: error.code }, error.status);
    return c.json({ error: "Could not finish connecting your account. Please try again.", code: error instanceof MusicAuthError ? error.code : "account_unavailable" }, 400);
  });
  app.get("/settings", c => {
    c.header("Referrer-Policy", "strict-origin");
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'self' https://js-cdn.music.apple.com; connect-src 'self' https://*.apple.com https://*.mzstatic.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src https://*.apple.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    return c.html(accountPage());
  });
  app.get("/api/account", async c => {
    const account = await current(c);
    return c.json({ account: account ? { provider: account.provider, label: account.label, connected: Boolean(account.credentials) } : null,
      authorizationBinding: account ? await binding(c, account) : null,
      available: { spotify: availableConnections(env).includes("spotify"), apple: appleAvailable() },
      subscriptions: account ? (await store.subscriptions(account.id)).map(publicSubscription) : [] });
  });
  app.post("/account/sign-out", async c => {
    await fields(c, []);
    const token = getCookie(c, sessionCookie);
    if (token) await store.deleteSession(await sha256(token));
    deleteCookie(c, sessionCookie, { path: "/" });
    deleteCookie(c, browserCookie, { path: "/" });
    return c.json({ signedOut: true });
  });
  app.post("/account/:provider/start", async c => {
    const provider = c.req.param("provider");
    if (provider !== "spotify" && provider !== "apple") throw new ThreadError(404, "not_found", "Music provider not found.");
    if (provider === "apple" ? !appleAvailable() : !availableConnections(env).includes("spotify")) throw new ThreadError(503, "provider_unavailable", "This sign-in option is not available yet.");
    const body = await fields(c, ["returnTo"]);
    const returnTo = typeof body.returnTo === "string" && isThreadCapability(body.returnTo) ? body.returnTo : "";
    const account = await current(c);
    if (account && account.provider !== provider) throw new ThreadError(409, "one_provider_only", "Sign out before choosing a different music provider.");
    const pkce = await makePkce();
    const state = `account.${crypto.randomUUID()}`;
    const previousBrowser = getCookie(c, browserCookie);
    const browser = previousBrowser && /^[a-f0-9-]{36}$/.test(previousBrowser) ? previousBrowser : crypto.randomUUID();
    const redirectUri = provider === "spotify" ? env.SPOTIFY_REDIRECT_URI ?? `${origin}/account/spotify/callback` : `${origin}/account/apple/callback`;
    const pending: PendingLogin = { provider, verifier: pkce.verifier, redirectUri, returnTo, accountId: account?.id ?? null,
      sessionHash: account ? await sha256(getCookie(c, sessionCookie)!) : null };
    const stateHash = await sha256(state);
    await store.putOAuth(stateHash, await sha256(browser), JSON.stringify(await seal(env.PUBLISHER_ENCRYPTION_KEY!, `login:${stateHash}`, pending)), Date.now() + 600000);
    setCookie(c, browserCookie, browser, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "Lax", path: "/", maxAge: 600 });
    if (provider === "spotify") return c.json({ url: spotifyAuthorizeUrl(env.SPOTIFY_CLIENT_ID!, redirectUri, state, pkce.challenge) });
    const { appleSignInUrl } = await import("./apple-sign-in.js");
    return c.json({ url: appleSignInUrl({ clientId: env.APPLE_SIGN_IN_CLIENT_ID!, redirectUri, state, nonce: pkce.verifier }) });
  });
  app.get("/account/:provider/callback", async c => {
    try {
      const provider = c.req.param("provider");
      const state = c.req.query("state") ?? "";
      const browser = getCookie(c, browserCookie);
      if (!browser || !/^account\.[a-f0-9-]{36}$/.test(state)) throw new Error();
      const stateHash = await sha256(state);
      const record = await store.consumeOAuth(stateHash, await sha256(browser));
      if (!record) throw new Error();
      const pending = await unseal<PendingLogin>(env.PUBLISHER_ENCRYPTION_KEY!, `login:${stateHash}`, JSON.parse(record.payload) as Sealed);
      if (pending.provider !== provider || c.req.query("error")) throw new Error();
      const code = c.req.query("code");
      if (!code || code.length > 4096) throw new Error();
      let account: Account;
      let credentials: unknown;
      if (provider === "spotify") {
        const tokens = await exchangeSpotifyCode({ clientId: env.SPOTIFY_CLIENT_ID!, code, verifier: pending.verifier, redirectUri: pending.redirectUri });
        const profile = await getSpotifyAccount(tokens.accessToken);
        account = await store.upsert("spotify", profile.accountId, profile.label);
        credentials = { clientId: env.SPOTIFY_CLIENT_ID!, accountId: profile.accountId, tokens };
      } else {
        const { exchangeAppleSignIn } = await import("./apple-sign-in.js");
        const identity = await exchangeAppleSignIn({ clientId: env.APPLE_SIGN_IN_CLIENT_ID!, keyId: env.APPLE_SIGN_IN_KEY_ID!,
          teamId: env.APPLE_SIGN_IN_TEAM_ID!, privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY_P8!, redirectUri: pending.redirectUri, code, nonce: pending.verifier });
        account = await store.upsert("apple", identity.subject, "Apple Music");
      }
      const existing = await current(c);
      if ((pending.accountId && (pending.accountId !== account.id || existing?.id !== pending.accountId)) || (existing && existing.id !== account.id)) throw new Error();
      if (credentials) await saveCredentials(account, credentials);
      await session(c, account, pending.sessionHash);
      return c.redirect(`/settings${pending.returnTo ? `?thread=${encodeURIComponent(pending.returnTo)}` : ""}`, 303);
    } catch {
      return c.redirect("/settings?sign_in=failed", 303);
    }
  });
  app.post("/account/apple/token", async c => {
    const account = await signedIn(c);
    if (account.provider !== "apple") throw new ThreadError(403, "one_provider_only", "This account uses Spotify.");
    const body = await fields(c, ["authorizationBinding"]);
    await validateBinding(c, account, body.authorizationBinding);
    return c.json({ developerToken: await appleDeveloperToken(env), authorizationBinding: body.authorizationBinding });
  });
  app.post("/account/apple/authorize", async c => {
    const account = await signedIn(c);
    if (account.provider !== "apple") throw new ThreadError(403, "one_provider_only", "This account uses Spotify.");
    const body = await fields(c, ["musicUserToken", "authorizationBinding"]);
    await validateBinding(c, account, body.authorizationBinding);
    if (typeof body.musicUserToken !== "string") throw new ThreadError(400, "invalid_input", "Authorize Apple Music first.");
    await env.THREAD_PUBLISHER.getByName(`account_${account.id}`).authorizeAccountApple(account.id, body.musicUserToken);
    for (const subscription of await store.subscriptions(account.id)) {
      if (subscription.connected) { await store.retry(account.id, subscription.capability); onChange(subscription.capability); }
    }
    return c.json({ authorized: true });
  });
  app.get("/api/threads/:capability/subscription", async c => {
    const account = await current(c);
    return c.json({ account: account ? { provider: account.provider, connected: Boolean(account.credentials) } : null,
      subscription: account ? publicSubscription(await store.subscription(account.id, c.req.param("capability"))) : null });
  });
  app.post("/api/threads/:capability/subscription", async c => {
    const account = await signedIn(c);
    const body = await fields(c, ["action"]);
    const cap = c.req.param("capability");
    if (body.action === "unsubscribe") await store.unsubscribe(account.id, cap);
    else if (body.action === "subscribe" || body.action === "retry") {
      if (!account.credentials) throw new ThreadError(403, "authorization_required", "Connect your music library in settings first.");
      if (body.action === "subscribe") await store.subscribe(account.id, cap);
      else await store.retry(account.id, cap);
      onChange(cap);
    } else throw new ThreadError(400, "invalid_input", "Choose subscribe, unsubscribe, or retry.");
    return c.json({ subscription: publicSubscription(await store.subscription(account.id, cap)) });
  });
  app.get("/t/:capability/manage/apps", c => c.redirect(`/settings?thread=${encodeURIComponent(c.req.param("capability"))}`, 303));
  return app;
}
