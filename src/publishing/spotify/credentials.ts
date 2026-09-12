import { PublishingError } from "./publisher";

export type SpotifyRefreshCredentials = { clientId: string; clientSecret: string; refreshToken: string };
export type SpotifyTokens = { accessToken: string; refreshToken: string; expiresAt: number };

const validToken = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,16000}$/.test(value);

export async function refreshSpotifyAccessToken(
  credentials: SpotifyRefreshCredentials,
  fetcher: typeof fetch = fetch,
): Promise<SpotifyTokens> {
  if (!validToken(credentials.clientId) || credentials.clientId.includes(":") || !validToken(credentials.clientSecret) || !validToken(credentials.refreshToken)) {
    throw new PublishingError("authorization_required", 401);
  }
  let response: Response;
  try {
    response = await fetcher("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
  } catch {
    throw new PublishingError("authorization_unavailable", 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new PublishingError("rate_limited", 429, Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60);
    }
    if ([400, 401, 403].includes(response.status)) throw new PublishingError("authorization_required", 401);
    throw new PublishingError("authorization_unavailable", 502);
  }
  let body: Record<string, unknown>;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16000) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    throw new PublishingError("invalid_token_response", 502);
  }
  const refreshToken = body.refresh_token === undefined ? credentials.refreshToken : body.refresh_token;
  if (!validToken(body.access_token) || !validToken(refreshToken)
    || typeof body.expires_in !== "number" || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0
    || (body.token_type !== undefined && body.token_type !== "Bearer")
    || (body.scope !== undefined && (typeof body.scope !== "string" || !body.scope.split(" ").includes("playlist-modify-public")))) {
    throw new PublishingError("invalid_token_response", 502);
  }
  const expiresAt = Date.now() + body.expires_in * 1000;
  if (!Number.isSafeInteger(expiresAt)) throw new PublishingError("invalid_token_response", 502);
  return { accessToken: body.access_token, refreshToken, expiresAt };
}
