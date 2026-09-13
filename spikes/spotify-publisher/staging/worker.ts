import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { SpotifyPublisher, PublishingError, validateDesired, type Destination } from "../../../src/publishing/spotify/publisher";

type Envelope = { iv: string; ciphertext: string };
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
type Invitation = { ticketHash: string; expiresAt: number };
type Flow = { stateHash: string; browserHash: string; expiresAt: number; verifier: Envelope };
type Candidate = { candidateId: string; publisherId: string; expiresAt: number; tokens: Envelope };
type Publisher = { clientId: string; publisherId: string; appMode: "development" | "extended-quota"; tokens: Envelope };
type Failure = { status: number; message: string };
type AuthorizationFailure = {
  phase: "token_exchange" | "publisher_profile";
  kind: "timeout" | "redirect" | "network" | "provider_response" | "unknown";
  status: number | null;
  observedAt: number;
};

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Strict-Transport-Security": "max-age=31536000",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: responseHeaders });
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const digest = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
const redirected = (response: Response) => response.status >= 300 && response.status < 400;
const transportFailureKind = (error: unknown): AuthorizationFailure["kind"] => {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "network";
  return "unknown";
};

async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new PublishingError("body_too_large", 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function input(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new PublishingError("json_required", 415);
  let value;
  try { value = JSON.parse(await boundedText(request.body, 64000)); }
  catch (error) { if (error instanceof PublishingError) throw error; throw new PublishingError("invalid_json", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublishingError("invalid_json", 400);
  return value;
}

function validateRequest(request: Request, env: Cloudflare.Env) {
  if (env.DEPLOYMENT_STAGE !== "staging" || !env.SPOTIFY_CLIENT_ID || (typeof env.OPERATOR_TOKEN !== "string" || env.OPERATOR_TOKEN.length < 32) || !/^[a-f0-9]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY ?? "")) throw new PublishingError("staging_not_configured", 503);
  const url = new URL(request.url);
  const browserPath = ["/auth/invite", "/auth/start", "/auth/callback"].some(path => url.pathname.startsWith(path));
  const expectedOrigin = browserPath ? env.PUBLIC_ORIGIN : env.CONTROL_ORIGIN;
  if (url.protocol !== "https:" || url.origin !== expectedOrigin) throw new PublishingError("invalid_origin", 400);
  if (request.headers.has("origin") && request.headers.get("origin") !== expectedOrigin) throw new PublishingError("forbidden_origin", 403);
  if (url.pathname.startsWith("/control/")) {
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${env.OPERATOR_TOKEN}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new PublishingError("operator_authorization_required", 401);
  }
}

function failureResponse(error: unknown): Response {
  if (!(error instanceof PublishingError)) return json({ error: "internal_error" }, 500);
  const response = json({ error: error.code }, error.status >= 400 && error.status <= 599 ? error.status : 502);
  if (error.retryAfterSeconds) response.headers.set("Retry-After", String(error.retryAfterSeconds));
  return response;
}

export class SpotifySpike extends DurableObject<Cloudflare.Env> {
  private publisher: SpotifyPublisher;
  private operationBusy = false;
  private refreshFlight: Promise<string> | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.publisher = new SpotifyPublisher({
      accessToken: () => this.accessToken(),
      store: {
        get: key => this.ctx.storage.get<Destination>(`destination:${key}`),
        set: (key, value) => this.ctx.storage.put(`destination:${key}`, value),
      },
    });
  }

  private async seal(value: unknown, purpose: string): Promise<Envelope> {
    const key = await crypto.subtle.importKey("raw", Buffer.from(this.env.TOKEN_ENCRYPTION_KEY, "hex"), "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${this.env.SPOTIFY_CLIENT_ID}:${purpose}`) }, key, new TextEncoder().encode(JSON.stringify(value)));
    return { iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") };
  }

  private async unseal<T>(envelope: Envelope, purpose: string): Promise<T> {
    try {
      const key = await crypto.subtle.importKey("raw", Buffer.from(this.env.TOKEN_ENCRYPTION_KEY, "hex"), "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64"), additionalData: new TextEncoder().encode(`${this.env.SPOTIFY_CLIENT_ID}:${purpose}`) }, key, Buffer.from(envelope.ciphertext, "base64"));
      return JSON.parse(new TextDecoder().decode(plaintext)) as T;
    } catch { throw new PublishingError("stored_credentials_unavailable", 503); }
  }

  private async exchange(parameters: Record<string, string>, previousRefreshToken?: string): Promise<Tokens> {
    let response;
    try {
      response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.env.SPOTIFY_CLIENT_ID, ...parameters }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      });
    } catch (error) {
      await this.rememberAuthorizationFailure("token_exchange", transportFailureKind(error));
      throw new PublishingError("authorization_unavailable", 502);
    }
    if (redirected(response)) {
      await response.body?.cancel();
      await this.rememberAuthorizationFailure("token_exchange", "redirect", response.status);
      throw new PublishingError("authorization_unavailable", 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      await this.rememberAuthorizationFailure("token_exchange", "provider_response", response.status);
      throw new PublishingError("authorization_required", 401);
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await boundedText(response.body, 16000)); }
    catch { throw new PublishingError("invalid_token_response", 502); }
    const refreshToken = body.refresh_token ?? previousRefreshToken;
    if (typeof body.access_token !== "string" || typeof refreshToken !== "string" || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0
      || (body.scope !== undefined && (typeof body.scope !== "string" || !body.scope.split(" ").includes("playlist-modify-public")))) throw new PublishingError("invalid_token_response", 502);
    return { accessToken: body.access_token, refreshToken, expiresAt: Date.now() + body.expires_in * 1000 };
  }

  private async rememberAuthorizationFailure(phase: AuthorizationFailure["phase"], kind: AuthorizationFailure["kind"], status: number | null = null) {
    await this.ctx.storage.put<AuthorizationFailure>("lastAuthorizationFailure", { phase, kind, status, observedAt: Date.now() });
  }

  private async tokenTransport(): Promise<Response> {
    let response;
    try {
      response = await fetch("https://accounts.spotify.com/api/token", { method: "GET", signal: AbortSignal.timeout(10000), redirect: "manual" });
    } catch (error) {
      return json({ reachable: false, kind: transportFailureKind(error) }, 502);
    }
    const status = response.status;
    await response.body?.cancel();
    return redirected(response) ? json({ reachable: false, kind: "redirect", status }, 502) : json({ reachable: true, status });
  }

  private async accessToken(): Promise<string> {
    const publisher = await this.ctx.storage.get<Publisher>("publisher");
    if (!publisher || publisher.clientId !== this.env.SPOTIFY_CLIENT_ID) throw new PublishingError("authorization_required", 401);
    const tokens = await this.unseal<Tokens>(publisher.tokens, "tokens");
    if (tokens.expiresAt > Date.now() + 30000) return tokens.accessToken;
    if (!this.refreshFlight) {
      this.refreshFlight = (async () => {
        const refreshed = await this.exchange({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, tokens.refreshToken);
        const encrypted = await this.seal(refreshed, "tokens");
        await this.ctx.storage.put("publisher", { ...publisher, tokens: encrypted });
        return refreshed.accessToken;
      })().finally(() => { this.refreshFlight = undefined; });
    }
    return this.refreshFlight;
  }

  private async invitation(): Promise<Response> {
    const ticket = random();
    const invitation: Invitation = { ticketHash: await digest(ticket), expiresAt: Date.now() + 600000 };
    await this.ctx.storage.transaction(async tx => {
      await tx.put("invitation", invitation);
      await tx.delete(["flow", "candidate"]);
    });
    return json({ inviteUrl: `${this.env.PUBLIC_ORIGIN}/auth/invite?ticket=${ticket}`, expiresAt: invitation.expiresAt }, 201);
  }

  private async landing(url: URL): Promise<Response> {
    const ticket = url.searchParams.get("ticket") ?? "";
    if (!/^[a-f0-9]{64}$/.test(ticket)) throw new PublishingError("invalid_invitation", 400);
    const invitation = await this.ctx.storage.get<Invitation>("invitation");
    if (!invitation || invitation.expiresAt <= Date.now() || invitation.ticketHash !== await digest(ticket)) throw new PublishingError("invalid_invitation", 400);
    const csrf = random();
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Spotify publisher</title><body><h1>Connect Spotify publisher</h1><p>Connect the Spotify account that will publish the shared test playlist. Omar will confirm it before publishing.</p><form method="post" action="/auth/start"><input type="hidden" name="ticket" value="${ticket}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Continue with Spotify</button></form></body></html>`;
    return new Response(html, { headers: { ...responseHeaders, "Referrer-Policy": "same-origin", "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.spotify.com", "Set-Cookie": `__Host-spotify-invite=${csrf}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` } });
  }

  private async start(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== this.env.PUBLIC_ORIGIN) throw new PublishingError("forbidden_origin", 403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") throw new PublishingError("form_required", 415);
    const form = new URLSearchParams(await boundedText(request.body, 2000));
    const csrf = form.get("csrf") ?? "";
    const browser = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith("__Host-spotify-invite="))?.slice("__Host-spotify-invite=".length) ?? "";
    if (!/^[a-f0-9]{64}$/.test(csrf) || !/^[a-f0-9]{64}$/.test(browser) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(browser))) throw new PublishingError("invalid_invitation_browser", 400);
    return this.begin(form.get("ticket") ?? "");
  }

  private async begin(ticket: string): Promise<Response> {
    if (!/^[a-f0-9]{64}$/.test(ticket)) throw new PublishingError("invalid_invitation", 400);
    const ticketHash = await digest(ticket);
    const browser = random(), oauthState = random(), verifier = random();
    const flow: Flow = { stateHash: await digest(oauthState), browserHash: await digest(browser), expiresAt: Date.now() + 600000, verifier: await this.seal(verifier, "verifier") };
    await this.ctx.storage.transaction(async tx => {
      const invitation = await tx.get<Invitation>("invitation");
      if (!invitation || invitation.expiresAt <= Date.now() || invitation.ticketHash !== ticketHash) throw new PublishingError("invalid_invitation", 400);
      await tx.put("flow", flow);
      await tx.delete("invitation");
    });
    const authorization = new URL("https://accounts.spotify.com/authorize");
    authorization.search = new URLSearchParams({ client_id: this.env.SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: `${this.env.PUBLIC_ORIGIN}/auth/callback`,
      scope: "playlist-modify-public", state: oauthState, code_challenge_method: "S256", code_challenge: Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url") }).toString();
    return new Response(null, { status: 302, headers: { ...responseHeaders, Location: authorization.toString(), "Set-Cookie": `__Host-spotify-spike=${browser}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` } });
  }

  private async callback(request: Request, url: URL): Promise<Response> {
    const oauthState = url.searchParams.get("state") ?? "";
    const browser = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith("__Host-spotify-spike="))?.slice("__Host-spotify-spike=".length) ?? "";
    if (!/^[a-f0-9]{64}$/.test(oauthState) || !/^[a-f0-9]{64}$/.test(browser)) throw new PublishingError("invalid_callback", 400);
    const stateHash = await digest(oauthState), browserHash = await digest(browser);
    const flow = await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<Flow>("flow");
      if (!current || current.expiresAt <= Date.now() || current.stateHash !== stateHash || current.browserHash !== browserHash) throw new PublishingError("invalid_callback", 400);
      await tx.delete("flow");
      return current;
    });
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) throw new PublishingError("authorization_denied", 400);
    const verifier = await this.unseal<string>(flow.verifier, "verifier");
    const tokens = await this.exchange({ grant_type: "authorization_code", code, redirect_uri: `${this.env.PUBLIC_ORIGIN}/auth/callback`, code_verifier: verifier });
    let profile;
    try { profile = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(10000), redirect: "manual" }); }
    catch (error) {
      await this.rememberAuthorizationFailure("publisher_profile", transportFailureKind(error));
      throw new PublishingError("publisher_verification_unavailable", 502);
    }
    if (redirected(profile)) {
      await profile.body?.cancel();
      await this.rememberAuthorizationFailure("publisher_profile", "redirect", profile.status);
      throw new PublishingError("publisher_verification_unavailable", 502);
    }
    if (!profile.ok) {
      let message = "Provider rejected publisher verification";
      try {
        const text = await boundedText(profile.body, 8000);
        let value; try { const body = JSON.parse(text); value = body?.error?.message ?? body?.error ?? body?.message; } catch { value = text; }
        if (typeof value === "string") {
          for (const secret of [tokens.accessToken, tokens.refreshToken, code, verifier, oauthState, browser, this.env.OPERATOR_TOKEN]) value = value.split(secret).join("[redacted]");
          message = value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9._~-]{32,}/g, "[redacted]").slice(0, 400);
        }
      } catch { message = "Provider error response unavailable"; }
      await this.ctx.storage.put<Failure>("lastVerificationFailure", { status: profile.status, message });
      await this.rememberAuthorizationFailure("publisher_profile", "provider_response", profile.status);
      throw new PublishingError("publisher_verification_failed", profile.status);
    }
    let me: { id?: unknown };
    try { me = JSON.parse(await boundedText(profile.body, 16000)); } catch { throw new PublishingError("invalid_profile_response", 502); }
    if (typeof me.id !== "string" || !me.id) throw new PublishingError("invalid_profile_response", 502);
    const existing = await this.ctx.storage.get<Publisher>("publisher");
    if (existing && (existing.clientId !== this.env.SPOTIFY_CLIENT_ID || existing.publisherId !== me.id)) throw new PublishingError("publisher_mismatch", 403);
    const candidate: Candidate = { candidateId: random(), publisherId: me.id, expiresAt: tokens.expiresAt, tokens: await this.seal(tokens, "tokens") };
    await this.ctx.storage.transaction(async tx => { await tx.put("candidate", candidate); await tx.delete(["lastVerificationFailure", "lastAuthorizationFailure"]); });
    const response = json({ authorizationReceived: true, message: "Spotify authorization received. Omar must confirm the publisher before publishing." });
    response.headers.set("Set-Cookie", "__Host-spotify-spike=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    return response;
  }

  private async confirm(value: Record<string, unknown>): Promise<Response> {
    if (typeof value.candidateId !== "string" || typeof value.publisherId !== "string" || !["development", "extended-quota"].includes(String(value.appMode))) throw new PublishingError("invalid_confirmation", 400);
    const candidate = await this.ctx.storage.get<Candidate>("candidate");
    if (!candidate || candidate.expiresAt <= Date.now()) throw new PublishingError("confirmation_expired", 409);
    if (candidate.candidateId !== value.candidateId || candidate.publisherId !== value.publisherId) throw new PublishingError("publisher_mismatch", 403);
    await this.unseal<Tokens>(candidate.tokens, "tokens");
    const publisher: Publisher = { clientId: this.env.SPOTIFY_CLIENT_ID, publisherId: candidate.publisherId, appMode: value.appMode as Publisher["appMode"], tokens: candidate.tokens };
    await this.ctx.storage.transaction(async tx => { await tx.put("publisher", publisher); await tx.delete("candidate"); });
    return json({ authorized: true, publisherId: publisher.publisherId, appMode: publisher.appMode });
  }

  async dispatch(value: { url: string; method: string; headers: [string, string][]; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const response = await this.handle(new Request(value.url, { method: value.method, headers: value.headers, body: value.body }));
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }

  async handle(request: Request): Promise<Response> {
    try {
      validateRequest(request, this.env);
      const url = new URL(request.url);
      if (url.pathname === "/control/status" && request.method === "GET") {
        const publisher = await this.ctx.storage.get<Publisher>("publisher");
        const candidate = await this.ctx.storage.get<Candidate>("candidate");
        const destinations = await this.ctx.storage.list<Destination>({ prefix: "destination:" });
        return json({ authorized: Boolean(publisher && publisher.clientId === this.env.SPOTIFY_CLIENT_ID), publisherId: publisher?.publisherId ?? null, appMode: publisher?.appMode ?? "unverified",
          candidate: candidate ? { candidateId: candidate.candidateId, publisherId: candidate.publisherId, expiresAt: candidate.expiresAt } : null,
          lastAuthorizationFailure: await this.ctx.storage.get<AuthorizationFailure>("lastAuthorizationFailure") ?? null,
          lastVerificationFailure: await this.ctx.storage.get<Failure>("lastVerificationFailure") ?? null,
          destinations: [...destinations.values()].map(row => ({ playlistKey: row.desired.playlistKey, providerPlaylistId: row.providerPlaylistId, appliedRevision: row.appliedRevision, revision: row.desired.revision, createUnresolved: row.createUnresolved })) });
      }
      if (this.operationBusy) throw new PublishingError("publisher_busy", 409);
      this.operationBusy = true;
      try {
        if (url.pathname === "/control/readback" && request.method === "GET") return json(await this.publisher.observe(url.searchParams.get("playlistKey") ?? ""));
        if (url.pathname === "/control/token-transport" && request.method === "GET") return await this.tokenTransport();
        if (url.pathname === "/control/publisher-transport" && request.method === "GET") {
          const publisher = await this.ctx.storage.get<Publisher>("publisher");
          return json({ reachable: true, publisherMatches: Boolean(publisher && publisher.publisherId === await this.publisher.probePublisher()) });
        }
        if (url.pathname === "/control/desired" && request.method === "PUT") {
          const desired = await input(request); validateDesired(desired);
          const result = await this.publisher.reconcile(desired);
          return json({ playlistKey: result.desired.playlistKey, providerPlaylistId: result.providerPlaylistId, appliedRevision: result.appliedRevision, url: `https://open.spotify.com/playlist/${result.providerPlaylistId}` });
        }
        if (url.pathname === "/control/recover-create" && request.method === "POST") {
          const value = await input(request);
          if (typeof value.playlistKey !== "string" || typeof value.providerPlaylistId !== "string") throw new PublishingError("invalid_recovery", 400);
          const result = await this.publisher.recoverCreate(value.playlistKey, value.providerPlaylistId);
          return json({ providerPlaylistId: result.providerPlaylistId, appliedRevision: result.appliedRevision, createUnresolved: result.createUnresolved });
        }
        if (url.pathname === "/control/invitations" && request.method === "POST") return await this.invitation();
        if (url.pathname === "/auth/invite" && request.method === "GET") return await this.landing(url);
        if (url.pathname === "/auth/start" && request.method === "POST") return await this.start(request);
        if (url.pathname === "/auth/callback" && request.method === "GET") return await this.callback(request, url);
        if (url.pathname === "/control/confirm" && request.method === "POST") return await this.confirm(await input(request));
        return json({ error: "not_found" }, 404);
      } finally { this.operationBusy = false; }
    } catch (error) { return failureResponse(error); }
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    try {
      validateRequest(request, env);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/auth/callback" && url.searchParams.get("state")?.startsWith("threads.")) {
        url.pathname = "/connections/spotify/callback";
        return new Response(null, { status: 302, headers: { Location: url.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
      }
      if (url.pathname === "/health" && request.method === "GET") return json({ service: "spotify-publisher-spike", stage: "staging" });
      if (!url.pathname.startsWith("/control/") && !["/auth/invite", "/auth/start", "/auth/callback"].includes(url.pathname)) return json({ error: "not_found" }, 404);
      const result = await env.SPOTIFY_STATE.getByName("publisher").dispatch({ url: request.url, method: request.method, headers: [...request.headers], body: request.body ? await boundedText(request.body, 64000) : undefined });
      return new Response(result.body, { status: result.status, headers: result.headers });
    } catch (error) { return failureResponse(error); }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
