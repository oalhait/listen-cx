import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applePreflight, exchangeSpotifyCode, getSpotifyAccount, makePkce, MusicAuthError,
  refreshSpotifyTokens, seal, signAppleDeveloperToken, spotifyAuthorizeUrl, unseal,
} from "./music-auth";

const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const exchange = { clientId: "client-id", redirectUri: "https://staging.listen.cx/auth/spotify/callback", code: "code-secret", verifier: "v".repeat(64) };
const tokenBody = { access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, token_type: "Bearer", scope: "playlist-modify-public" };
const respond = (...bodies: unknown[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const body of bodies) fetcher.mockResolvedValueOnce(Response.json(body));
  return fetcher;
};
const decodeUrl = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));

afterEach(() => vi.restoreAllMocks());

describe("sealed account credentials", () => {
  it("roundtrips structured credentials with a fresh nonce for each envelope", async () => {
    const value = { accessToken: "access-secret", expiresAt: 1234 };
    const first = await seal(secret, "thread:first:spotify", value);
    const second = await seal(secret, "thread:first:spotify", value);
    expect(first).not.toEqual(second);
    expect(JSON.stringify(first)).not.toContain("access-secret");
    await expect(unseal(secret, "thread:first:spotify", first)).resolves.toEqual(value);
  });

  it("rejects credentials moved to another Thread or provider", async () => {
    const envelope = await seal(secret, "thread:first:spotify", { token: "private" });
    for (const purpose of ["thread:second:spotify", "thread:first:apple"]) {
      await expect(unseal(secret, purpose, envelope)).rejects.toMatchObject({ code: "authorization_required", status: 401 });
    }
  });

  it("rejects tampering and wrong keys without disclosing credentials", async () => {
    const envelope = await seal(secret, "purpose", { token: "private" });
    const bad = { ...envelope, ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1) };
    await expect(unseal(secret, "purpose", bad)).rejects.toMatchObject({ message: "authorization_required" });
    await expect(unseal(btoa("x".repeat(32)), "purpose", envelope)).rejects.toBeInstanceOf(MusicAuthError);
  });

  it.each(["", "private", btoa("x".repeat(31)), btoa("x".repeat(33))])("rejects invalid encryption configuration", async key => {
    await expect(seal(key, "purpose", {})).rejects.toMatchObject({ code: "authorization_unavailable", status: 503 });
  });

  it("bounds values and rejects malformed envelopes safely", async () => {
    await expect(seal(secret, "purpose", { token: "x".repeat(65536) })).rejects.toMatchObject({ code: "authorization_unavailable" });
    await expect(unseal(secret, "purpose", { iv: "bad", ciphertext: "bad" })).rejects.toMatchObject({ code: "authorization_required" });
  });
});

describe("Spotify account authorization", () => {
  it("generates independent PKCE verifiers with matching SHA-256 challenges", async () => {
    const first = await makePkce();
    const second = await makePkce();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(first.verifier).not.toBe(second.verifier);
    expect(decodeUrl(first.challenge)).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(first.verifier))));
  });

  it("requests the verified public-playlist scope with PKCE and callback state", () => {
    const url = new URL(spotifyAuthorizeUrl(exchange.clientId, exchange.redirectUri, "state-secret", "c".repeat(43)));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: exchange.clientId, redirect_uri: exchange.redirectUri, response_type: "code", scope: "playlist-modify-public", state: "state-secret", code_challenge_method: "S256", code_challenge: "c".repeat(43) });
  });

  it.each(["https://user:pass@example.com/callback", "http://example.com/callback", "https://example.com/callback#fragment", "javascript:alert(1)"])("rejects an unsafe callback URI", redirect => {
    expect(() => spotifyAuthorizeUrl(exchange.clientId, redirect, "state", "c".repeat(43))).toThrow(MusicAuthError);
  });

  it("exchanges the authorization code without a client secret", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const fetcher = respond(tokenBody);
    await expect(exchangeSpotifyCode(exchange, fetcher)).resolves.toEqual({ accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: 3601000 });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://accounts.spotify.com/api/token");
    expect(options).toMatchObject({ method: "POST", redirect: "manual", signal: expect.any(AbortSignal) });
    expect(new Headers(options?.headers).has("Authorization")).toBe(false);
    expect(new URLSearchParams(String(options?.body))).toEqual(new URLSearchParams({ client_id: exchange.clientId, grant_type: "authorization_code", redirect_uri: exchange.redirectUri, code: exchange.code, code_verifier: exchange.verifier }));
  });

  it("refreshes PKCE credentials and keeps the existing refresh token when rotation is omitted", async () => {
    const fetcher = respond({ ...tokenBody, refresh_token: undefined });
    await expect(refreshSpotifyTokens({ clientId: "client-id", refreshToken: "original-refresh" }, fetcher)).resolves.toMatchObject({ accessToken: "access-secret", refreshToken: "original-refresh" });
    expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body))).toEqual(new URLSearchParams({ client_id: "client-id", grant_type: "refresh_token", refresh_token: "original-refresh" }));
  });

  it("keeps a rotated refresh token", async () => {
    await expect(refreshSpotifyTokens({ clientId: "client-id", refreshToken: "original-refresh" }, respond(tokenBody))).resolves.toMatchObject({ refreshToken: "refresh-secret" });
  });

  it.each([
    {}, null, { ...tokenBody, access_token: "bad\ntoken" }, { ...tokenBody, refresh_token: null },
    { ...tokenBody, refresh_token: undefined }, { ...tokenBody, expires_in: 0 },
    { ...tokenBody, expires_in: 1.5 }, { ...tokenBody, expires_in: Number.MAX_VALUE },
    { ...tokenBody, token_type: "Other" }, { ...tokenBody, scope: "playlist-read-private" },
    { ...tokenBody, scope: 42 }, { ...tokenBody, extra: "x".repeat(16000) },
  ])("rejects unusable token responses without exposing their body: %j", async body => {
    await expect(exchangeSpotifyCode(exchange, respond(body))).rejects.toMatchObject({ code: "invalid_token_response", status: 502, message: "invalid_token_response" });
  });

  it.each([400, 401, 403, 429, 302, 500])("handles status %i without retries or provider error details", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("access-secret", { status }));
    await expect(exchangeSpotifyCode(exchange, fetcher)).rejects.toMatchObject({ code: status === 429 ? "rate_limited" : status < 404 && status >= 400 ? "authorization_required" : "authorization_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([["12.1", 13], ["", 60], ["-1", 60], ["private-detail", 60], ["1e40", 60]])("preserves a usable retry delay and replaces invalid delays: %s", async (retryAfter, seconds) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("access-secret", { status: 429, headers: { "retry-after": String(retryAfter) } }));
    await expect(exchangeSpotifyCode(exchange, fetcher)).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: seconds, message: "rate_limited" });
  });

  it("hides transport and malformed JSON errors", async () => {
    await expect(exchangeSpotifyCode(exchange, vi.fn<typeof fetch>().mockRejectedValue(new Error("code-secret")))).rejects.toMatchObject({ message: "authorization_unavailable" });
    await expect(exchangeSpotifyCode(exchange, vi.fn<typeof fetch>().mockResolvedValue(new Response("code-secret")))).rejects.toMatchObject({ message: "invalid_token_response" });
  });

  it("rejects invalid supplied credentials before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(exchangeSpotifyCode({ ...exchange, verifier: "short" }, fetcher)).rejects.toMatchObject({ code: "authorization_required" });
    await expect(refreshSpotifyTokens({ clientId: "client-id", refreshToken: "bad\ntoken" }, fetcher)).rejects.toMatchObject({ code: "authorization_required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads the actual account identity and falls back to its id when no display name is present", async () => {
    const fetcher = respond({ id: "account-1", display_name: "Omar" }, { id: "account-1", display_name: null });
    await expect(getSpotifyAccount("access-secret", fetcher)).resolves.toEqual({ id: "account-1", label: "Omar", accountId: "account-1" });
    await expect(getSpotifyAccount("access-secret", fetcher)).resolves.toEqual({ id: "account-1", label: "account-1", accountId: "account-1" });
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.spotify.com/v1/me");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("Authorization")).toBe("Bearer access-secret");
  });

  it("preserves the immutable account identity when the playlist-owner id changes", async () => {
    const fetcher = respond({ account_id: "aB3dE5fG7h", id: "before", display_name: "Omar" }, { account_id: "aB3dE5fG7h", id: "after", display_name: "Omar" });
    await expect(getSpotifyAccount("access-secret", fetcher)).resolves.toEqual({ accountId: "aB3dE5fG7h", id: "before", label: "Omar" });
    await expect(getSpotifyAccount("access-secret", fetcher)).resolves.toEqual({ accountId: "aB3dE5fG7h", id: "after", label: "Omar" });
  });

  it.each(["", null, 42, "bad\nid", "x".repeat(257)])("rejects invalid immutable account identifiers instead of falling back", async accountId => {
    await expect(getSpotifyAccount("access-secret", respond({ id: "valid", account_id: accountId }))).rejects.toMatchObject({ code: "invalid_provider_response", status: 502 });
  });

  it.each([{}, { id: "" }, { id: "bad\nid" }, { id: "x".repeat(257) }, { id: "valid", extra: "x".repeat(65536) }])("rejects invalid account responses", async body => {
    await expect(getSpotifyAccount("access-secret", respond(body))).rejects.toMatchObject({ code: "invalid_provider_response", status: 502 });
  });
});

describe("Apple Music account authorization", () => {
  it("signs a verifiable 15-minute ES256 developer token", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const encoded = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))));
    const token = await signAppleDeveloperToken({ keyId: "KEY1234567", teamId: "TEAM123456", privateKey: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` }, 1234000);
    const [header, payload, signature] = token.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(decodeUrl(header)))).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(new TextDecoder().decode(decodeUrl(payload)))).toEqual({ iss: "TEAM123456", iat: 1234, exp: 2134 });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, decodeUrl(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  });

  it("hides malformed signing credentials", async () => {
    await expect(signAppleDeveloperToken({ keyId: "KEY1234567", teamId: "TEAM123456", privateKey: "private-signing-secret" })).rejects.toMatchObject({ code: "authorization_unavailable", status: 503, message: "authorization_unavailable" });
  });

  it("verifies the user token through the personal storefront endpoint", async () => {
    const fetcher = respond({ data: [{ id: "us", type: "storefronts" }] });
    await expect(applePreflight("developer-secret", "user-secret", undefined, fetcher)).resolves.toEqual({ storefront: "us" });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.music.apple.com/v1/me/storefront");
    expect(options).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
    expect(new Headers(options?.headers).get("Music-User-Token")).toBe("user-secret");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer developer-secret");
  });

  it("verifies an existing playlist is returned in this account and remains editable", async () => {
    const fetcher = respond({ data: [{ id: "us" }] }, { data: [{ id: "p.123abc", type: "library-playlists", attributes: { canEdit: true } }] });
    await expect(applePreflight("developer-secret", "user-secret", "p.123abc", fetcher)).resolves.toEqual({ storefront: "us" });
    expect(fetcher.mock.calls[1]![0]).toBe("https://api.music.apple.com/v1/me/library/playlists/p.123abc");
  });

  it.each([{ data: [] }, { data: [{ id: "p.other", attributes: { canEdit: true } }] }, { data: [{ id: "p.123abc", attributes: { canEdit: false } }] }])("rejects reconnecting a different or read-only library", async playlist => {
    await expect(applePreflight("developer-secret", "user-secret", "p.123abc", respond({ data: [{ id: "us" }] }, playlist))).rejects.toMatchObject({ code: "destination_mismatch", status: 403 });
  });

  it.each([{}, { data: [] }, { data: [{ id: "" }] }, { data: [{ id: "us/evil" }] }])("rejects invalid storefront responses before checking the playlist", async body => {
    const fetcher = respond(body);
    await expect(applePreflight("developer-secret", "user-secret", "p.123abc", fetcher)).rejects.toMatchObject({ code: "invalid_provider_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid tokens and playlist paths before any requests", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(applePreflight("developer-secret", "bad\ntoken", undefined, fetcher)).rejects.toMatchObject({ code: "authorization_required" });
    await expect(applePreflight("developer-secret", "user-secret", "../other", fetcher)).rejects.toMatchObject({ code: "destination_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
