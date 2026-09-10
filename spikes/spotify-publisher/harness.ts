import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { SpotifyPublisher, PublishingError, type Destination } from "../../src/publishing/spotify/publisher.ts";

type Config = {
  clientId: string;
  publisherId?: string;
  controlToken: string;
  appMode?: "development" | "extended-quota";
  redirectUri: string;
  stateDirectory: string;
  fetcher?: typeof fetch;
  now?: () => number;
};
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveJson(directory: string, name: string, value: unknown) {
  const target = join(directory, name);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, target);
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function createHarness(config: Config) {
  const redirect = new URL(config.redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/auth/callback" || redirect.search || redirect.hash || redirect.username || redirect.password) throw new Error("invalid_redirect_uri");
  if (!config.clientId || config.controlToken.length < 32 || (config.appMode !== undefined && !["development", "extended-quota"].includes(config.appMode))) throw new Error("missing_configuration");
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.stateDirectory, 0o700);
  const lockPath = join(config.stateDirectory, "publisher.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error("state_locked"); }
  await lock.writeFile(String(process.pid));
  const fetcher = config.fetcher ?? fetch;
  const now = config.now ?? Date.now;
  let closed = false;
  let origin = "";
  let pending: { state: string; verifier: string; expiresAt: number } | undefined;
  let tokenFlight: Promise<string> | undefined;
  const tokenPath = join(config.stateDirectory, "tokens.json");
  const statePath = join(config.stateDirectory, "destinations.json");
  try {
    const savedBinding = await readJson<{ clientId: string; publisherId?: string; appMode?: Config["appMode"] }>(join(config.stateDirectory, "binding.json"));
    if (savedBinding && (savedBinding.clientId !== config.clientId || (config.publisherId && savedBinding.publisherId && savedBinding.publisherId !== config.publisherId))) throw new Error("state_publisher_mismatch");
    const binding = { clientId: config.clientId, publisherId: savedBinding?.publisherId ?? config.publisherId, appMode: config.appMode ?? savedBinding?.appMode };
    await saveJson(config.stateDirectory, "binding.json", binding);
    let candidate: { publisherId: string; tokens: Tokens } | undefined;
    const rows = new Map(Object.entries(await readJson<Record<string, Destination>>(statePath) ?? {}));
    let tokens = await readJson<Tokens>(tokenPath);

    async function exchange(parameters: Record<string, string>): Promise<Tokens> {
      let response;
      try {
        response = await fetcher("https://accounts.spotify.com/api/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: config.clientId, ...parameters }),
          signal: AbortSignal.timeout(10_000), redirect: "error",
        });
      } catch { throw new PublishingError("authorization_unavailable", 502); }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PublishingError("authorization_required", 401);
      }
      let value;
      try { value = await response.json() as Record<string, unknown>; }
      catch { throw new PublishingError("invalid_token_response", 502); }
      const refreshToken = value.refresh_token ?? tokens?.refreshToken;
      if (typeof value.access_token !== "string" || typeof refreshToken !== "string" || typeof value.expires_in !== "number" || value.expires_in < 1
        || (value.scope !== undefined && (typeof value.scope !== "string" || !value.scope.split(" ").includes("playlist-modify-public")))) throw new PublishingError("invalid_token_response", 502);
      return { accessToken: value.access_token, refreshToken, expiresAt: now() + value.expires_in * 1000 };
    }

    async function accessToken(): Promise<string> {
      if (!tokens || !binding.publisherId || !binding.appMode) throw new PublishingError("authorization_required", 401);
      if (tokens.expiresAt > now() + 30_000) return tokens.accessToken;
      if (!tokenFlight) {
        tokenFlight = (async () => {
          const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: tokens!.refreshToken });
          await saveJson(config.stateDirectory, "tokens.json", refreshed);
          tokens = refreshed;
          return refreshed.accessToken;
        })().finally(() => { tokenFlight = undefined; });
      }
      return tokenFlight;
    }

    let storeWrite = Promise.resolve();
    const publisher = new SpotifyPublisher({
      accessToken, fetcher, now,
      store: {
        get: async key => structuredClone(rows.get(key)),
        set: async (key, row) => {
          const operation = storeWrite.then(async () => {
            const next = new Map(rows); next.set(key, structuredClone(row));
            await saveJson(config.stateDirectory, "destinations.json", Object.fromEntries(next));
            rows.set(key, structuredClone(row));
          });
          storeWrite = operation.catch(() => {});
          await operation;
        },
      },
    });

    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      const send = (status: number, value: unknown) => { response.statusCode = status; response.end(JSON.stringify(value)); };
      try {
        if (`http://${request.headers.host}` !== origin || (request.headers.origin && request.headers.origin !== origin)) throw new PublishingError("forbidden_origin", 403);
        const url = new URL(request.url ?? "/", origin);
        if (request.method === "GET" && url.pathname === "/auth/callback") {
          const state = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          if (!pending || !state || state !== pending.state || pending.expiresAt <= now() || !code || url.searchParams.has("error")) throw new PublishingError("invalid_oauth_callback", 400);
          const verifier = pending.verifier;
          pending = undefined;
          const authorized = await exchange({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier });
          const profile = await fetcher("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${authorized.accessToken}` }, signal: AbortSignal.timeout(10_000), redirect: "error" });
          if (!profile.ok) throw new PublishingError("publisher_verification_failed", 403);
          const me = await profile.json() as { id?: string };
          if (typeof me.id !== "string" || !me.id || (binding.publisherId && me.id !== binding.publisherId)) throw new PublishingError("publisher_mismatch", 403);
          if (!binding.publisherId || !binding.appMode) {
            candidate = { publisherId: me.id, tokens: authorized };
            send(200, { authorized: false, candidatePublisherId: me.id, confirmationRequired: true }); return;
          }
          await saveJson(config.stateDirectory, "tokens.json", authorized);
          tokens = authorized;
          send(200, { authorized: true, publisherId: binding.publisherId }); return;
        }
        const actual = Buffer.from(request.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${config.controlToken}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new PublishingError("control_authorization_required", 401);
        if (request.method === "POST" && url.pathname === "/auth/start") {
          pending = { state: randomBytes(32).toString("base64url"), verifier: randomBytes(64).toString("base64url"), expiresAt: now() + 10 * 60_000 };
          const authorization = new URL("https://accounts.spotify.com/authorize");
          authorization.search = new URLSearchParams({
            client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri,
            scope: "playlist-modify-public", state: pending.state, code_challenge_method: "S256",
            code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"),
          }).toString();
          send(200, { authorizationUrl: authorization.toString() }); return;
        }
        if (request.method === "GET" && url.pathname === "/status") {
          send(200, { appMode: binding.appMode ?? "unverified", appModeEvidence: "operator-reported", publisherId: binding.publisherId ?? null, candidatePublisherId: candidate?.publisherId ?? null, authorized: Boolean(tokens && binding.publisherId && binding.appMode), destinations: [...rows.values()].map(row => ({ playlistKey: row.desired.playlistKey, revision: row.desired.revision, providerPlaylistId: row.providerPlaylistId, appliedRevision: row.appliedRevision, createUnresolved: row.createUnresolved })) }); return;
        }
        if ((request.method === "PUT" && url.pathname === "/desired") || (request.method === "POST" && ["/recover-create", "/auth/confirm"].includes(url.pathname))) {
          let body = "";
          for await (const chunk of request) {
            body += String(chunk);
            if (Buffer.byteLength(body) > 64_000) throw new PublishingError("body_too_large", 413);
          }
          let value;
          try { value = JSON.parse(body); } catch { throw new PublishingError("invalid_json", 400); }
          if (url.pathname === "/auth/confirm") {
            if (!value || typeof value.publisherId !== "string" || !["development", "extended-quota"].includes(value.appMode)) throw new PublishingError("invalid_confirmation", 400);
            if (!candidate || candidate.publisherId !== value.publisherId || candidate.tokens.expiresAt <= now()) throw new PublishingError("publisher_mismatch", 403);
            binding.publisherId = candidate.publisherId;
            binding.appMode = value.appMode;
            await saveJson(config.stateDirectory, "binding.json", binding);
            await saveJson(config.stateDirectory, "tokens.json", candidate.tokens);
            tokens = candidate.tokens;
            candidate = undefined;
            send(200, { authorized: true, publisherId: binding.publisherId, appMode: binding.appMode }); return;
          }
          if (url.pathname === "/recover-create") {
            if (!value || typeof value.playlistKey !== "string" || typeof value.providerPlaylistId !== "string") throw new PublishingError("invalid_recovery", 400);
            const recovered = await publisher.recoverCreate(value.playlistKey, value.providerPlaylistId);
            send(200, { playlistKey: recovered.desired.playlistKey, providerPlaylistId: recovered.providerPlaylistId, appliedRevision: recovered.appliedRevision, createUnresolved: false }); return;
          }
          const result = await publisher.reconcile(value);
          send(200, { playlistKey: result.desired.playlistKey, providerPlaylistId: result.providerPlaylistId, appliedRevision: result.appliedRevision, url: `https://open.spotify.com/playlist/${result.providerPlaylistId}`, evidence: "authenticated-api-readback" }); return;
        }
        send(404, { error: "not_found" });
      } catch (error) {
        if (error instanceof PublishingError) {
          if (error.retryAfterSeconds) response.setHeader("Retry-After", String(error.retryAfterSeconds));
          send(error.status >= 400 && error.status <= 599 ? error.status : 502, { error: error.code });
        } else send(500, { error: "internal_error" });
      }
    });
    return {
      async listen(port = Number(redirect.port) || 80) {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("listen_failed");
        origin = `http://127.0.0.1:${address.port}`;
        return origin;
      },
      async close() {
        if (closed) return;
        closed = true;
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await storeWrite;
        await lock.close(); await unlink(lockPath);
      },
    };
  } catch (error) {
    await lock.close(); await unlink(lockPath); throw error;
  }
}
