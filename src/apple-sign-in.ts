import { MusicAuthError } from "./music-auth";

type Authorization = { clientId: string; redirectUri: string; state: string; nonce: string };
type Exchange = Omit<Authorization, "state"> & { teamId: string; keyId: string; privateKey: string; code: string };

const issuer = "https://appleid.apple.com";
const encoder = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const token = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decode(value: string, limit: number): Uint8Array<ArrayBuffer> {
  if (!value || value.length > Math.ceil(limit * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
  if (bytes.length > limit || encode(bytes) !== value) throw new Error();
  return bytes;
}

function validateClient(clientId: string, redirectUri: string): void {
  try {
    if (!token(clientId, 256) || !/^[A-Za-z0-9.-]+$/.test(clientId) || typeof redirectUri !== "string" || redirectUri.length > 2048) throw new Error();
    const url = new URL(redirectUri);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname.includes(".")
      || url.hostname.endsWith(".localhost") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new Error();
  } catch { throw new MusicAuthError("authorization_unavailable", 503); }
}

export function appleSignInUrl(parameters: Authorization): string {
  validateClient(parameters.clientId, parameters.redirectUri);
  if (!token(parameters.state, 2048) || !token(parameters.nonce, 256)) throw new MusicAuthError("authorization_required", 401);
  const url = new URL(`${issuer}/auth/authorize`);
  url.search = new URLSearchParams({
    client_id: parameters.clientId, redirect_uri: parameters.redirectUri, response_type: "code", response_mode: "query",
    state: parameters.state, nonce: parameters.nonce,
  }).toString();
  return url.href;
}

async function clientSecret(credentials: Exchange): Promise<string> {
  try {
    if (!/^[A-Z0-9]{10}$/.test(credentials.keyId) || !/^[A-Z0-9]{10}$/.test(credentials.teamId)
      || typeof credentials.privateKey !== "string" || credentials.privateKey.length > 16000) throw new Error();
    const pem = credentials.privateKey.replace(/\\n/g, "\n").trim();
    const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/.exec(pem);
    if (!match) throw new Error();
    const encoded = match[1]!.replace(/\s/g, "");
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    if (btoa(String.fromCharCode(...bytes)) !== encoded) throw new Error();
    const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const iat = Math.floor(Date.now() / 1000);
    const header = encode(encoder.encode(JSON.stringify({ alg: "ES256", kid: credentials.keyId })));
    const payload = encode(encoder.encode(JSON.stringify({ iss: credentials.teamId, sub: credentials.clientId, aud: issuer, iat, exp: iat + 300 })));
    const message = `${header}.${payload}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(message));
    return `${message}.${encode(new Uint8Array(signature))}`;
  } catch { throw new MusicAuthError("authorization_unavailable", 503); }
}

async function requestJson(url: string, options: RequestInit, invalidCode: string, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MusicAuthError("authorization_unavailable", 502));
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, 10_000);
  });
  const request = async () => {
    let response: Response;
    try { response = await fetcher(url, { ...options, redirect: "manual", signal: controller.signal }); }
    catch { throw new MusicAuthError("authorization_unavailable", 502); }
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new MusicAuthError("authorization_unavailable", 502);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        const seconds = Math.ceil(Number(response.headers.get("retry-after")));
        throw new MusicAuthError("rate_limited", 429, Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 60);
      }
      if ([400, 401, 403].includes(response.status)) throw new MusicAuthError("authorization_required", 401);
      throw new MusicAuthError("authorization_unavailable", 502);
    }
    try {
      if (!response.body) throw new Error();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw new Error();
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isRecord(body)) throw new Error();
      return body;
    } catch { throw new MusicAuthError(invalidCode, 502); }
    finally { void reader?.cancel().catch(() => {}); }
  };
  try { return await Promise.race([request(), timeout]); }
  finally { clearTimeout(timer); }
}

async function verifyHash(claim: unknown, value: unknown): Promise<void> {
  if (claim === undefined) return;
  if (!token(value, 16000) || typeof claim !== "string") throw new Error();
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))).slice(0, 16);
  if (claim !== encode(hash)) throw new Error();
}

export async function exchangeAppleSignIn(credentials: Exchange, fetcher: typeof fetch = fetch): Promise<{ subject: string }> {
  validateClient(credentials.clientId, credentials.redirectUri);
  if (!token(credentials.code, 4096) || !token(credentials.nonce, 256)) throw new MusicAuthError("authorization_required", 401);
  const body = await requestJson(`${issuer}/auth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: await clientSecret(credentials), code: credentials.code, grant_type: "authorization_code", redirect_uri: credentials.redirectUri }),
  }, "invalid_token_response", fetcher);
  if (!token(body.id_token, 16384) || body.id_token.split(".").length !== 3) throw new MusicAuthError("invalid_token_response", 502);
  const [encodedHeader, encodedPayload, encodedSignature] = body.id_token.split(".") as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    const parsedHeader: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(encodedHeader, 2048)));
    const parsedClaims: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(encodedPayload, 8192)));
    if (!isRecord(parsedHeader) || !isRecord(parsedClaims)) throw new Error();
    header = parsedHeader;
    claims = parsedClaims;
    signature = decode(encodedSignature, 1024);
    if (header.alg !== "RS256" || !token(header.kid, 128) || header.crit !== undefined || header.b64 !== undefined) throw new Error();
  } catch { throw new MusicAuthError("authorization_required", 401); }
  const jwks = await requestJson(`${issuer}/auth/keys`, {}, "invalid_provider_response", fetcher);
  try {
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 10) throw new Error();
    const matches = jwks.keys.filter(key => isRecord(key) && key.kid === header.kid);
    if (matches.length !== 1) throw new Error();
    const key = matches[0];
    if (!isRecord(key) || key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig"
      || typeof key.n !== "string" || typeof key.e !== "string" || decode(key.n, 1024).length < 256
      || decode(key.e, 8).length === 0) throw new Error();
    const publicKey = await crypto.subtle.importKey("jwk", { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, encoder.encode(`${encodedHeader}.${encodedPayload}`))) throw new Error();
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer || claims.aud !== credentials.clientId || claims.nonce !== credentials.nonce || !token(claims.sub, 255)
      || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= now
      || typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat < 0 || claims.iat > now + 60 || claims.iat >= claims.exp) throw new Error();
    await verifyHash(claims.c_hash, credentials.code);
    await verifyHash(claims.at_hash, body.access_token);
    return { subject: claims.sub };
  } catch { throw new MusicAuthError("authorization_required", 401); }
}
