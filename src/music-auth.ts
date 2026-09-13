import { providerProfile, type PublicProfile } from "./profile.js";
export type Sealed = { iv: string; ciphertext: string };
export type SpotifyTokens = { accessToken: string; refreshToken: string; expiresAt: number };

export class MusicAuthError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(code);
    this.name = "MusicAuthError";
  }
}

const encoder = new TextEncoder();
const validToken = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,16000}$/.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const base64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
const base64url = (value: Uint8Array): string => base64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeBase64(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (bytes.byteLength > maxBytes || base64(bytes) !== value) throw new Error();
  return bytes;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const bytes = decodeBase64(secret, 32);
  if (bytes.byteLength !== 32) throw new Error();
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function associatedData(purpose: string): Uint8Array<ArrayBuffer> {
  if (typeof purpose !== "string" || !purpose || purpose.length > 2048) throw new Error();
  return encoder.encode(purpose);
}

export async function seal(secret: string, purpose: string, value: unknown): Promise<Sealed> {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    const bytes = encoder.encode(serialized);
    if (bytes.byteLength > 65536) throw new Error();
    const key = await encryptionKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData(purpose) }, key, bytes);
    return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  } catch { throw new MusicAuthError("authorization_unavailable", 503); }
}

export async function unseal<T>(secret: string, purpose: string, envelope: Sealed): Promise<T> {
  try {
    const iv = decodeBase64(envelope.iv, 12);
    const ciphertext = decodeBase64(envelope.ciphertext, 65552);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 16) throw new Error();
    const key = await encryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: associatedData(purpose) }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch { throw new MusicAuthError("authorization_required", 401); }
}

export async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  return { verifier, challenge };
}

function validateSpotifyClient(clientId: string, redirectUri?: string): void {
  if (!validToken(clientId) || clientId.length > 256) throw new MusicAuthError("authorization_unavailable", 503);
  if (redirectUri === undefined) return;
  try {
    const url = new URL(redirectUri);
    if (redirectUri.length > 2048 || url.username || url.password || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
  } catch { throw new MusicAuthError("authorization_unavailable", 503); }
}

export function spotifyAuthorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  validateSpotifyClient(clientId, redirectUri);
  if (!validToken(state) || state.length > 2048 || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new MusicAuthError("authorization_required", 401);
  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "playlist-modify-public",
    state, code_challenge_method: "S256", code_challenge: challenge,
  }).toString();
  return url.href;
}

async function requestJson(url: string, options: RequestInit, limit: number, invalidCode: string, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch { throw new MusicAuthError("authorization_unavailable", 502); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) {
      const seconds = Math.ceil(Number(response.headers.get("retry-after")));
      throw new MusicAuthError("rate_limited", 429, Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 60);
    }
    if ([400, 401, 403].includes(response.status)) throw new MusicAuthError("authorization_required", 401);
    throw new MusicAuthError("authorization_unavailable", 502);
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(body)) throw new Error();
    return body;
  } catch { throw new MusicAuthError(invalidCode, 502); }
}

async function spotifyTokenRequest(parameters: Record<string, string>, previousRefreshToken: string | undefined, fetcher: typeof fetch): Promise<SpotifyTokens> {
  const body = await requestJson("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(parameters),
  }, 16000, "invalid_token_response", fetcher);
  const refreshToken = body.refresh_token === undefined ? previousRefreshToken : body.refresh_token;
  if (!validToken(body.access_token) || !validToken(refreshToken)
    || typeof body.expires_in !== "number" || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0
    || body.token_type !== "Bearer"
    || (body.scope !== undefined && (typeof body.scope !== "string" || !body.scope.split(" ").includes("playlist-modify-public")))) {
    throw new MusicAuthError("invalid_token_response", 502);
  }
  const expiresAt = Date.now() + body.expires_in * 1000;
  if (!Number.isSafeInteger(expiresAt)) throw new MusicAuthError("invalid_token_response", 502);
  return { accessToken: body.access_token, refreshToken, expiresAt };
}

export async function exchangeSpotifyCode(
  credentials: { clientId: string; redirectUri: string; code: string; verifier: string },
  fetcher: typeof fetch = fetch,
): Promise<SpotifyTokens> {
  validateSpotifyClient(credentials.clientId, credentials.redirectUri);
  if (!validToken(credentials.code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(credentials.verifier)) throw new MusicAuthError("authorization_required", 401);
  return spotifyTokenRequest({
    client_id: credentials.clientId, grant_type: "authorization_code", redirect_uri: credentials.redirectUri,
    code: credentials.code, code_verifier: credentials.verifier,
  }, undefined, fetcher);
}

export async function refreshSpotifyTokens(
  credentials: { clientId: string; refreshToken: string },
  fetcher: typeof fetch = fetch,
): Promise<SpotifyTokens> {
  validateSpotifyClient(credentials.clientId);
  if (!validToken(credentials.refreshToken)) throw new MusicAuthError("authorization_required", 401);
  return spotifyTokenRequest({
    client_id: credentials.clientId, grant_type: "refresh_token", refresh_token: credentials.refreshToken,
  }, credentials.refreshToken, fetcher);
}

export async function getSpotifyAccount(accessToken: string, fetcher: typeof fetch = fetch): Promise<{ id: string; label: string; accountId: string; profile: PublicProfile }> {
  if (!validToken(accessToken)) throw new MusicAuthError("authorization_required", 401);
  const body = await requestJson("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${accessToken}` } }, 65536, "invalid_provider_response", fetcher);
  if (!validToken(body.id) || body.id.length > 256) throw new MusicAuthError("invalid_provider_response", 502);
  const accountId = body.account_id === undefined ? body.id : body.account_id;
  if (!validToken(accountId) || accountId.length > 256) throw new MusicAuthError("invalid_provider_response", 502);
  const label = typeof body.display_name === "string" && body.display_name.trim() && body.display_name.length <= 256
    && !/[\x00-\x1f\x7f]/.test(body.display_name) ? body.display_name : body.id;
  return { id: body.id, label, accountId, profile: providerProfile(body) };
}

export async function signAppleDeveloperToken(
  credentials: { keyId: string; teamId: string; privateKey: string },
  now = Date.now(),
): Promise<string> {
  try {
    if (!/^[A-Z0-9]{10}$/.test(credentials.keyId) || !/^[A-Z0-9]{10}$/.test(credentials.teamId)
      || typeof credentials.privateKey !== "string" || credentials.privateKey.length > 16000
      || !Number.isSafeInteger(now) || now < 0) throw new Error();
    const pem = credentials.privateKey.replace(/\\n/g, "\n").trim();
    const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/.exec(pem);
    if (!match) throw new Error();
    const key = await crypto.subtle.importKey("pkcs8", decodeBase64(match[1]!.replace(/\s/g, ""), 12000), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const iat = Math.floor(now / 1000);
    const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: credentials.keyId })));
    const payload = base64url(encoder.encode(JSON.stringify({ iss: credentials.teamId, iat, exp: iat + 900 })));
    const message = `${header}.${payload}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(message));
    return `${message}.${base64url(new Uint8Array(signature))}`;
  } catch { throw new MusicAuthError("authorization_unavailable", 503); }
}

export async function applePreflight(
  developerToken: string,
  musicUserToken: string,
  playlistId?: string,
  fetcher: typeof fetch = fetch,
): Promise<{ storefront: string }> {
  if (!validToken(developerToken) || !validToken(musicUserToken)) throw new MusicAuthError("authorization_required", 401);
  if (playlistId !== undefined && !/^p\.[A-Za-z0-9.-]{1,200}$/.test(playlistId)) throw new MusicAuthError("destination_mismatch", 403);
  const options = { headers: { Authorization: `Bearer ${developerToken}`, "Music-User-Token": musicUserToken } };
  const body = await requestJson("https://api.music.apple.com/v1/me/storefront", options, 65536, "invalid_provider_response", fetcher);
  const storefront = Array.isArray(body.data) ? body.data[0] : undefined;
  if (!isRecord(storefront) || typeof storefront.id !== "string" || !/^[a-z]{2}$/.test(storefront.id)) throw new MusicAuthError("invalid_provider_response", 502);
  if (playlistId) {
    const result = await requestJson(`https://api.music.apple.com/v1/me/library/playlists/${playlistId}`, options, 65536, "invalid_provider_response", fetcher);
    const playlist = Array.isArray(result.data) ? result.data[0] : undefined;
    if (!isRecord(playlist) || playlist.id !== playlistId || !isRecord(playlist.attributes) || playlist.attributes.canEdit !== true) throw new MusicAuthError("destination_mismatch", 403);
  }
  return { storefront: storefront.id };
}
