import { D1ProfileStore } from "./profile-db.js";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { D1AccountStore, type Account, type Subscription } from "./account-db.js";
import { currentAccount } from "./account-session.js";
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
const appleBrowserCookie = "listen_apple_browser";
type PendingLogin = { provider: Provider; verifier: string; redirectUri: string; returnTo: string; accountId: string | null; sessionHash: string | null };

function publicAccount(account: Account) {
  return { provider: account.provider, label: account.label, connected: Boolean(account.credentials),
    browserOnly: account.provider === "apple" && account.subject.startsWith("browser:") };
}

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
  const profiles = new D1ProfileStore(env.DB);
  const origin = new URL(baseUrl).origin;
  const appleAvailable = () => availableConnections(env).includes("apple");
  const current = (c: Context) => currentAccount(c, env.DB);
  async function validateConnection(owner: Account, target: Account) {
    const connections = await store.connections(owner.id);
    if (connections.some(value => value.provider === target.provider && value.id !== target.id)
      || (target.groupId !== owner.groupId && (await store.connections(target.id)).length > 1)) {
      throw new ThreadError(409, "different_account", "This music account is already connected elsewhere, or a different account for this provider is connected here.");
    }
  }
  async function appleBrowser(c: Context) {
    let browser = getCookie(c, appleBrowserCookie);
    if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) browser = (await makePkce()).challenge;
    setCookie(c, appleBrowserCookie, browser, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "Lax", path: "/", maxAge: 365 * 86400 });
    return browser;
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
  async function binding(c: Context, account: Account, purpose = "apple-library-grant"): Promise<string> {
    return JSON.stringify(await seal(env.PUBLISHER_ENCRYPTION_KEY!, purpose, {
      accountId: account.id, sessionHash: await sha256(getCookie(c, sessionCookie)!), expiresAt: Date.now() + 1800000,
    }));
  }
  async function validateBinding(c: Context, account: Account, value: unknown, purpose = "apple-library-grant") {
    if (typeof value !== "string" || value.length > 2000) throw new ThreadError(403, "session_changed", "Your account changed. Refresh settings before connecting music.");
    try {
      const grant = await unseal<{ accountId: string; sessionHash: string; expiresAt: number }>(env.PUBLISHER_ENCRYPTION_KEY!, purpose, JSON.parse(value));
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
  async function session(c: Context, account: Account, previousHash: string | null, grant?: { stateHash: string; browserHash: string }) {
    const token = (await makePkce()).challenge;
    const tokenHash = await sha256(token);
    const expiresAt = Date.now() + 30 * 86400000;
    if (grant) {
      if (!await store.completeOAuthSession(grant.stateHash, grant.browserHash, account.id, tokenHash, expiresAt)) throw new Error("session_changed");
    } else if (previousHash) {
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
    const connections = account ? await store.connections(account.id) : [];
    const spotify = connections.find(value => value.provider === "spotify" && value.credentials);
    if (spotify && await profiles.claimSeed(spotify.id)) {
      try {
        const token = await env.THREAD_PUBLISHER.getByName(`account_${spotify.id}`).getAccountSpotifyToken(spotify.id);
        const provider = await getSpotifyAccount(token);
        if (provider.accountId === spotify.subject) await profiles.seed(spotify.id, provider.profile);
      } catch {}
    }
    return c.json({ account: account ? publicAccount(account) : null, profile: account ? await profiles.get(account.id) : null,
      connections: connections.map(publicAccount),
      profileBinding: account ? await binding(c, account, "profile-edit-grant") : null,
      authorizationBinding: account ? await binding(c, account) : null,
      available: { spotify: availableConnections(env).includes("spotify"), apple: appleAvailable() },
      subscriptions: (await Promise.all(connections.map(value => store.subscriptions(value.id)))).flat().map(publicSubscription) });
  });
  app.post("/api/account/profile", async c => {
    const account = await signedIn(c);
    const body = await fields(c, ["displayName", "avatarUrl", "profileBinding"]);
    await validateBinding(c, account, body.profileBinding, "profile-edit-grant");
    return c.json({ profile: await profiles.update(account.id, { displayName: body.displayName, avatarUrl: body.avatarUrl }) });
  });
  app.post("/account/sign-out", async c => {
    await fields(c, []);
    const token = getCookie(c, sessionCookie);
    if (token) await store.deleteSession(await sha256(token));
    const appleBrowser = getCookie(c, appleBrowserCookie);
    if (appleBrowser) await store.cancelOAuth(await sha256(appleBrowser));
    deleteCookie(c, sessionCookie, { path: "/" });
    deleteCookie(c, browserCookie, { path: "/" });
    return c.json({ signedOut: true });
  });
  app.post("/account/:provider/start", async c => {
    const provider = c.req.param("provider");
    if (provider !== "spotify" && provider !== "apple") throw new ThreadError(404, "not_found", "Music provider not found.");
    if (provider === "apple" ? !appleAvailable() : !availableConnections(env).includes("spotify")) throw new ThreadError(503, "provider_unavailable", "This sign-in option is not available yet.");
    if (provider === "apple" && (!env.APPLE_SIGN_IN_CLIENT_ID || !env.APPLE_SIGN_IN_KEY_ID || !env.APPLE_SIGN_IN_TEAM_ID || !env.APPLE_SIGN_IN_PRIVATE_KEY_P8)) {
      throw new ThreadError(503, "use_musickit", "Connect directly with the Apple Music button in settings.");
    }
    const body = await fields(c, ["returnTo"]);
    const returnTo = typeof body.returnTo === "string" && isThreadCapability(body.returnTo) ? body.returnTo : "";
    const account = await current(c);
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
        await profiles.seed(account.id, profile.profile);
        credentials = { clientId: env.SPOTIFY_CLIENT_ID!, accountId: profile.accountId, tokens };
      } else {
        const { exchangeAppleSignIn } = await import("./apple-sign-in.js");
        const identity = await exchangeAppleSignIn({ clientId: env.APPLE_SIGN_IN_CLIENT_ID!, keyId: env.APPLE_SIGN_IN_KEY_ID!,
          teamId: env.APPLE_SIGN_IN_TEAM_ID!, privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY_P8!, redirectUri: pending.redirectUri, code, nonce: pending.verifier });
        account = await store.upsert("apple", identity.subject, "Apple Music");
      }
      const existing = await current(c);
      if (pending.accountId) {
        if (existing?.id !== pending.accountId || pending.sessionHash !== await sha256(getCookie(c, sessionCookie) ?? "")) throw new Error();
        await validateConnection(existing, account);
      } else if (existing && existing.id !== account.id) throw new Error();
      if (credentials) await saveCredentials(account, credentials);
      if (pending.accountId && !await store.linkAccounts(pending.accountId, account.id, pending.sessionHash!)) throw new Error();
      await session(c, pending.accountId ? existing! : account, pending.sessionHash);
      return c.redirect(`/settings${pending.returnTo ? `?thread=${encodeURIComponent(pending.returnTo)}` : ""}`, 303);
    } catch {
      return c.redirect("/settings?sign_in=failed", 303);
    }
  });
  app.post("/account/apple/prepare", async c => {
    await fields(c, []);
    if (await current(c)) throw new ThreadError(409, "session_changed", "Your account changed. Refresh settings before connecting music.");
    const developerToken = await appleDeveloperToken(env);
    const browser = await appleBrowser(c);
    const browserHash = await sha256(browser);
    const nonce = crypto.randomUUID();
    const completionNonce = crypto.randomUUID();
    const expiresAt = Date.now() + 1800000;
    const grant = { browserHash, nonce, completionNonce, expiresAt };
    const authorizationBinding = JSON.stringify(await seal(env.PUBLISHER_ENCRYPTION_KEY!, "apple-browser-grant", grant));
    await store.putOAuth(await sha256(nonce), browserHash, authorizationBinding, expiresAt);
    await store.putOAuth(await sha256(completionNonce), browserHash, authorizationBinding, expiresAt);
    return c.json({ developerToken, authorizationBinding });
  });
  app.post("/account/apple/token", async c => {
    const account = await signedIn(c);
    const body = await fields(c, ["authorizationBinding"]);
    await validateBinding(c, account, body.authorizationBinding);
    const developerToken = await appleDeveloperToken(env);
    await appleBrowser(c);
    return c.json({ developerToken, authorizationBinding: body.authorizationBinding });
  });
  app.post("/account/apple/authorize", async c => {
    const owner = await current(c);
    let account = owner;
    const body = await fields(c, ["musicUserToken", "authorizationBinding"]);
    if (typeof body.musicUserToken !== "string") throw new ThreadError(400, "invalid_input", "Authorize Apple Music first.");
    const newSession = !account;
    let completion: { stateHash: string; browserHash: string } | undefined;
    if (owner) {
      await validateBinding(c, owner, body.authorizationBinding);
      account = (await store.connections(owner.id)).find(value => value.provider === "apple") ?? null;
      if (!account) {
        const browser = getCookie(c, appleBrowserCookie);
        if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new ThreadError(403, "session_changed", "Refresh settings before connecting Apple Music.");
        account = await store.upsert("apple", `browser:${await sha256(browser)}`, "Apple Music");
      }
      await validateConnection(owner, account);
    }
    else {
      try {
        const browser = getCookie(c, appleBrowserCookie);
        if (!browser || typeof body.authorizationBinding !== "string" || body.authorizationBinding.length > 2000) throw new Error();
        const browserHash = await sha256(browser);
        const grant = await unseal<{ browserHash: string; nonce: string; completionNonce: string; expiresAt: number }>(env.PUBLISHER_ENCRYPTION_KEY!, "apple-browser-grant", JSON.parse(body.authorizationBinding));
        if (grant.browserHash !== browserHash || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()
          || typeof grant.nonce !== "string" || typeof grant.completionNonce !== "string" || !await store.consumeOAuth(await sha256(grant.nonce), browserHash)) throw new Error();
        completion = { stateHash: await sha256(grant.completionNonce), browserHash };
        account = await store.upsert("apple", `browser:${browserHash}`, "Apple Music");
      } catch { throw new ThreadError(403, "session_changed", "This Apple Music connection expired. Refresh settings and try again."); }
    }
    await env.THREAD_PUBLISHER.getByName(`account_${account.id}`).authorizeAccountApple(account.id, body.musicUserToken);
    if (owner && !await store.linkAccounts(owner.id, account.id, await sha256(getCookie(c, sessionCookie)!))) {
      throw new ThreadError(403, "session_changed", "Your account changed. Refresh settings before connecting music.");
    }
    if (newSession) await session(c, account, null, completion);
    for (const subscription of await store.subscriptions(account.id)) {
      if (subscription.connected) { await store.retry(account.id, subscription.capability); onChange(subscription.capability); }
    }
    return c.json({ authorized: true });
  });
  app.get("/api/threads/:capability/subscription", async c => {
    const account = await current(c);
    const connections = account ? await store.connections(account.id) : [];
    return c.json({ account: account ? publicAccount(account) : null,
      connections: await Promise.all(connections.map(async value => ({ account: publicAccount(value),
        subscription: publicSubscription(await store.subscription(value.id, c.req.param("capability"))) }))),
      subscription: account ? publicSubscription(await store.subscription(account.id, c.req.param("capability"))) : null });
  });
  app.post("/api/threads/:capability/subscription", async c => {
    const owner = await signedIn(c);
    const body = await fields(c, ["action", "provider"]);
    const provider = body.provider ?? owner.provider;
    if (provider !== "apple" && provider !== "spotify") throw new ThreadError(400, "invalid_input", "Choose Apple Music or Spotify.");
    const account = (await store.connections(owner.id)).find(value => value.provider === provider);
    if (!account) throw new ThreadError(403, "authorization_required", "Connect this music provider in settings first.");
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
