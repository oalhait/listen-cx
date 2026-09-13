import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appleSignInUrl, exchangeAppleSignIn } from "./apple-sign-in";

const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const json = (value: unknown) => encode(encoder.encode(JSON.stringify(value)));
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
const now = 1_800_000_000;
const authorization = { clientId: "cx.listen.web", redirectUri: "https://staging.listen.cx/auth/apple/callback", state: "state-secret", nonce: "nonce-secret" };
let credentials: { clientId: string; redirectUri: string; nonce: string; teamId: string; keyId: string; privateKey: string; code: string };
let signingKey: CryptoKeyPair;
let clientKey: CryptoKeyPair;
let publicKey: JsonWebKey & { kid: string; use: string; alg: string };

beforeAll(async () => {
  signingKey = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  clientKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  publicKey = { ...await crypto.subtle.exportKey("jwk", signingKey.publicKey), kid: "apple-key", alg: "RS256", use: "sig" };
  const pem = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", clientKey.privateKey))));
  credentials = { ...authorization, teamId: "TEAM123456", keyId: "KEY1234567", privateKey: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`, code: "code-secret" };
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function identity(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const message = `${json({ alg: "RS256", kid: "apple-key", ...header })}.${json({ iss: "https://appleid.apple.com", aud: authorization.clientId, sub: "stable-apple-subject", iat: now, exp: now + 300, nonce: authorization.nonce, ...claims })}`;
  return `${message}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey.privateKey, encoder.encode(message))))}`;
}

function responses(token: unknown, keys: unknown = { keys: [publicKey] }) {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(token)).mockResolvedValueOnce(Response.json(keys));
}

describe("Sign in with Apple", () => {
  it("requests a code-only query callback bound to state and nonce without personal-information scopes", () => {
    const url = new URL(appleSignInUrl(authorization));
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: authorization.clientId, redirect_uri: authorization.redirectUri, response_type: "code", response_mode: "query", state: authorization.state, nonce: authorization.nonce });
  });

  it.each(["http://example.com/callback", "https://localhost/callback", "https://127.0.0.1/callback", "https://[::1]/callback", "https://user:secret@example.com/callback", "https://example.com/callback#fragment"])("rejects callback URLs Apple cannot safely use: %s", redirectUri => {
    expect(() => appleSignInUrl({ ...authorization, redirectUri })).toThrow("authorization_unavailable");
  });

  it("returns only the verified stable subject and signs a verifiable five-minute client secret", async () => {
    const fetcher = responses({ id_token: await identity(), access_token: "access-secret" });
    await expect(exchangeAppleSignIn(credentials, fetcher)).resolves.toEqual({ subject: "stable-apple-subject" });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["https://appleid.apple.com/auth/token", "https://appleid.apple.com/auth/keys"]);
    const options = fetcher.mock.calls[0]![1]!;
    expect(options).toMatchObject({ method: "POST", redirect: "manual", signal: expect.any(AbortSignal) });
    expect(new Headers(options.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const parameters = new URLSearchParams(String(options.body));
    const [header, payload, signature] = parameters.get("client_secret")!.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: "ES256", kid: credentials.keyId });
    expect(JSON.parse(new TextDecoder().decode(decode(payload)))).toEqual({ iss: credentials.teamId, sub: credentials.clientId, aud: "https://appleid.apple.com", iat: now, exp: now + 300 });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, clientKey.publicKey, decode(signature), encoder.encode(`${header}.${payload}`))).toBe(true);
    parameters.delete("client_secret");
    expect(Object.fromEntries(parameters)).toEqual({ client_id: credentials.clientId, redirect_uri: credentials.redirectUri, code: credentials.code, grant_type: "authorization_code" });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
  });

  it.each([
    { iss: "https://attacker.example" }, { aud: "other-client" }, { aud: [authorization.clientId, "other-client"] },
    { nonce: "different-nonce" }, { nonce: undefined }, { sub: "" }, { sub: "bad\nsubject" }, { sub: "x".repeat(256) },
    { exp: now }, { exp: "1900000000" }, { iat: now + 61 }, { iat: undefined }, { iat: -1 }, { iat: now + 300 },
  ])("rejects invalid identity claims without exposing token data: %j", async claims => {
    await expect(exchangeAppleSignIn(credentials, responses({ id_token: await identity(claims) }))).rejects.toMatchObject({ code: "authorization_required", status: 401, message: "authorization_required" });
  });

  it.each([{ alg: "none" }, { alg: "HS256" }, { alg: "ES256" }, { kid: "unknown" }, { kid: undefined }, { crit: ["custom"] }, { b64: false }])("rejects unsupported or untrusted JOSE headers: %j", async header => {
    await expect(exchangeAppleSignIn(credentials, responses({ id_token: await identity({}, header) }))).rejects.toMatchObject({ code: "authorization_required", status: 401 });
  });

  it("rejects a forged payload signed for another subject", async () => {
    const [header, , signature] = (await identity()).split(".");
    const forged = `${header}.${json({ iss: "https://appleid.apple.com", aud: authorization.clientId, sub: "victim", iat: now, exp: now + 300, nonce: authorization.nonce })}.${signature}`;
    await expect(exchangeAppleSignIn(credentials, responses({ id_token: forged }))).rejects.toMatchObject({ code: "authorization_required" });
  });

  it("validates optional authorization-code and access-token hashes", async () => {
    const hash = async (value: string) => encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))).slice(0, 16));
    const claims = { c_hash: await hash(credentials.code), at_hash: await hash("access-secret") };
    await expect(exchangeAppleSignIn(credentials, responses({ id_token: await identity(claims), access_token: "access-secret" }))).resolves.toEqual({ subject: "stable-apple-subject" });
    for (const bad of [{ ...claims, c_hash: "wrong" }, { ...claims, at_hash: "wrong" }]) {
      await expect(exchangeAppleSignIn(credentials, responses({ id_token: await identity(bad), access_token: "access-secret" }))).rejects.toMatchObject({ code: "authorization_required" });
    }
    await expect(exchangeAppleSignIn(credentials, responses({ id_token: await identity(claims) }))).rejects.toMatchObject({ code: "authorization_required" });
  });

  it("rejects duplicate key identifiers and unusable verification keys", async () => {
    for (const keys of [[], [publicKey, publicKey], [{ ...publicKey, alg: "HS256" }], [{ ...publicKey, use: "enc" }], [{ ...publicKey, n: "bad" }], Array(11).fill(publicKey)]) {
      await expect(exchangeAppleSignIn(credentials, responses({ id_token: await identity() }, { keys }))).rejects.toMatchObject({ code: "authorization_required" });
    }
  });

  it.each([{}, null, { id_token: 123 }, { id_token: "bad.token" }, { id_token: "x".repeat(17000) }])("rejects malformed token responses", async body => {
    await expect(exchangeAppleSignIn(credentials, responses(body))).rejects.toMatchObject({ message: "invalid_token_response", status: 502 });
  });

  it("bounds token and key response bodies and rejects malformed JSON", async () => {
    const huge = new Response("x".repeat(65537));
    for (const body of [huge, new Response("private-invalid-json")]) {
      await expect(exchangeAppleSignIn(credentials, vi.fn<typeof fetch>().mockResolvedValue(body))).rejects.toMatchObject({ message: "invalid_token_response" });
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id_token: await identity() })).mockResolvedValueOnce(Response.json({ keys: [publicKey], extra: "x".repeat(65537) }));
    await expect(exchangeAppleSignIn(credentials, fetcher)).rejects.toMatchObject({ message: "invalid_provider_response" });
  });

  it.each([400, 401, 403, 429, 302, 500])("sanitizes provider failures and does not retry status %i", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-provider-detail", { status }));
    await expect(exchangeAppleSignIn(credentials, fetcher)).rejects.toMatchObject({ message: status === 429 ? "rate_limited" : [400, 401, 403].includes(status) ? "authorization_required" : "authorization_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport errors and rejects invalid inputs before any request", async () => {
    await expect(exchangeAppleSignIn(credentials, vi.fn<typeof fetch>().mockRejectedValue(new Error("private-network-detail")))).rejects.toMatchObject({ message: "authorization_unavailable", status: 502 });
    const fetcher = vi.fn<typeof fetch>();
    await expect(exchangeAppleSignIn({ ...credentials, privateKey: "private-invalid-key" }, fetcher)).rejects.toMatchObject({ message: "authorization_unavailable", status: 503 });
    await expect(exchangeAppleSignIn({ ...credentials, code: "bad\ncode" }, fetcher)).rejects.toMatchObject({ message: "authorization_required", status: 401 });
    await expect(exchangeAppleSignIn({ ...credentials, nonce: "" }, fetcher)).rejects.toMatchObject({ message: "authorization_required", status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"])("times out a stalled %s response and aborts the request", async stage => {
    vi.useFakeTimers();
    let options: RequestInit | undefined;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      options = init;
      started();
      if (stage === "headers") return new Promise<Response>(() => {});
      return new Response(new ReadableStream<Uint8Array>());
    });
    const result = expect(exchangeAppleSignIn(credentials, fetcher)).rejects.toMatchObject({ message: "authorization_unavailable", status: 502 });
    await requested;
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(options?.signal?.aborted).toBe(true);
  });
});
