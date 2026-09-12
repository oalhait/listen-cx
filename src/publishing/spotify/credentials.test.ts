import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshSpotifyAccessToken } from "./credentials";

const credentials = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-secret" };
const tokenResponse = { access_token: "access-secret", expires_in: 3600, token_type: "Bearer", scope: "playlist-modify-public" };
const fetchResponse = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response);

afterEach(() => vi.restoreAllMocks());

describe("Spotify credential refresh", () => {
  it("exchanges private credentials and returns rotated tokens with an absolute expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const fetcher = fetchResponse(Response.json({ ...tokenResponse, refresh_token: "rotated-secret" }));
    await expect(refreshSpotifyAccessToken(credentials, fetcher)).resolves.toEqual({ accessToken: "access-secret", refreshToken: "rotated-secret", expiresAt: 3601000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://accounts.spotify.com/api/token");
    expect(options).toMatchObject({ method: "POST", redirect: "manual", signal: expect.any(AbortSignal) });
    expect(new Headers(options?.headers).get("Authorization")).toBe(`Basic ${btoa("client-id:client-secret")}`);
    expect(new Headers(options?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(String(options?.body))).toEqual(new URLSearchParams({ grant_type: "refresh_token", refresh_token: "refresh-secret" }));
  });

  it("keeps the previous refresh token when the provider does not rotate it", async () => {
    const fetcher = fetchResponse(Response.json(tokenResponse));
    await expect(refreshSpotifyAccessToken(credentials, fetcher)).resolves.toMatchObject({ accessToken: "access-secret", refreshToken: "refresh-secret" });
  });

  it.each([400, 401, 403])("returns a safe authorization error for a %i response without retrying", async status => {
    const fetcher = fetchResponse(new Response("provider private detail refresh-secret", { status }));
    await expect(refreshSpotifyAccessToken(credentials, fetcher)).rejects.toMatchObject({ code: "authorization_required", message: "authorization_required", status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([302, 500, 503])("returns a safe availability error for a %i response", async status => {
    const fetcher = fetchResponse(new Response("provider secret", { status, headers: { Location: "https://other.example/token" } }));
    await expect(refreshSpotifyAccessToken(credentials, fetcher)).rejects.toMatchObject({ code: "authorization_unavailable", message: "authorization_unavailable", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves the provider retry delay without exposing the token response", async () => {
    const fetcher = fetchResponse(new Response("private", { status: 429, headers: { "retry-after": "12.1" } }));
    await expect(refreshSpotifyAccessToken(credentials, fetcher)).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 13 });
  });

  it("hides transport errors and does not replay an uncertain refresh", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("refresh-secret failed"));
    await expect(refreshSpotifyAccessToken(credentials, fetcher)).rejects.toMatchObject({ code: "authorization_unavailable", message: "authorization_unavailable", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, {}, { ...tokenResponse, access_token: "" }, { ...tokenResponse, access_token: "bad\ntoken" },
    { ...tokenResponse, refresh_token: null }, { ...tokenResponse, refresh_token: "" },
    { ...tokenResponse, expires_in: 0 }, { ...tokenResponse, expires_in: -1 }, { ...tokenResponse, expires_in: "3600" },
    { ...tokenResponse, expires_in: Number.MAX_VALUE }, { ...tokenResponse, token_type: "Other" },
    { ...tokenResponse, scope: "playlist-read-private" }, { ...tokenResponse, scope: 42 },
  ])("rejects unusable token responses safely: %j", async body => {
    const fetcher = fetchResponse(Response.json(body));
    await expect(refreshSpotifyAccessToken(credentials, fetcher)).rejects.toMatchObject({ code: "invalid_token_response", message: "invalid_token_response", status: 502 });
  });

  it("rejects oversized responses before accepting any returned credentials", async () => {
    const fetcher = fetchResponse(Response.json({ ...tokenResponse, extra: "x".repeat(16000) }));
    await expect(refreshSpotifyAccessToken(credentials, fetcher)).rejects.toMatchObject({ code: "invalid_token_response", status: 502 });
  });

  it("rejects malformed JSON safely", async () => {
    await expect(refreshSpotifyAccessToken(credentials, fetchResponse(new Response("refresh-secret")))).rejects.toMatchObject({ code: "invalid_token_response", status: 502 });
  });

  it.each(["clientId", "clientSecret", "refreshToken"] as const)("rejects missing %s before contacting the provider", async key => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(refreshSpotifyAccessToken({ ...credentials, [key]: "" }, fetcher)).rejects.toMatchObject({ code: "authorization_required", status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
