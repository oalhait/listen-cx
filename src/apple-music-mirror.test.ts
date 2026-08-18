import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  AppleMusicConfigurationError,
  AppleMusicError,
  AppleMusicMirrorClient,
  AppleMusicProviderError,
  createAppleMusicDeveloperToken,
  ecdsaDerToJose,
} from "./apple-music-mirror.js";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function pem(bytes: Uint8Array): string {
  const encoded = base64(bytes);
  const lines = encoded.match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

let privateKeyP8 = "";
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKeyP8 = pem(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  publicKey = pair.publicKey;
});

function tokenConfig(overrides: Partial<{ ttlSeconds: number; now: number }> = {}) {
  return {
    teamId: "TEAM_FIXTURE",
    keyId: "KEY_FIXTURE",
    privateKeyP8: privateKeyP8.replace(/\n/g, "\\n"),
    allowedOrigins: ["https://listen.cx", "http://localhost:8787"],
    now: 1_700_000_000_000,
    ttlSeconds: 3_600,
    ...overrides,
  };
}

describe("createAppleMusicDeveloperToken", () => {
  it("creates a verifiable ES256 JWT with configured origins and bounded claims", async () => {
    const token = await createAppleMusicDeveloperToken(tokenConfig(), 1_700_000_123_456);
    const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");
    expect(encodedHeader).toBeDefined();
    expect(encodedClaims).toBeDefined();
    expect(encodedSignature).toBeDefined();
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader!))) as Record<string, unknown>;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedClaims!))) as Record<string, unknown>;
    expect(header).toEqual({ alg: "ES256", kid: "KEY_FIXTURE", typ: "JWT" });
    expect(claims).toMatchObject({
      iss: "TEAM_FIXTURE",
      iat: 1_700_000_123,
      exp: 1_700_003_723,
      origin: ["https://listen.cx", "http://localhost:8787"],
    });
    expect(encodedSignature).toHaveLength(86);
    expect(token).not.toContain(privateKeyP8);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      asArrayBuffer(base64UrlDecode(encodedSignature!)),
      asArrayBuffer(new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`)),
    );
    expect(valid).toBe(true);
  });

  it("rejects malformed configuration without echoing key material", async () => {
    const keyValue = "not-a-private-key-fixture";
    await expect(
      createAppleMusicDeveloperToken({
        teamId: "TEAM_FIXTURE",
        keyId: "KEY_FIXTURE",
        privateKeyP8: keyValue,
        allowedOrigins: ["https://listen.cx"],
      }),
    ).rejects.toMatchObject({ code: "invalid_private_key" });
    await expect(
      createAppleMusicDeveloperToken({
        teamId: "TEAM_FIXTURE",
        keyId: "KEY_FIXTURE",
        privateKeyP8,
        allowedOrigins: ["not-an-origin"],
      }),
    ).rejects.toBeInstanceOf(AppleMusicConfigurationError);
    try {
      await createAppleMusicDeveloperToken({
        teamId: "TEAM_FIXTURE",
        keyId: "KEY_FIXTURE",
        privateKeyP8: keyValue,
        allowedOrigins: ["https://listen.cx"],
      });
    } catch (error) {
      expect(String(error)).not.toContain(keyValue);
    }
  });

  it("converts DER ECDSA signatures to JOSE raw form", () => {
    const r = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const s = Uint8Array.from({ length: 32 }, (_, index) => 32 - index);
    const der = Uint8Array.from([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);
    expect(ecdsaDerToJose(der)).toEqual(new Uint8Array([...r, ...s]));
    expect(() => ecdsaDerToJose(new Uint8Array([0x30, 0x01, 0x00]))).toThrow(AppleMusicError);
  });
});

describe("AppleMusicMirrorClient", () => {
  it("creates a playlist with documented auth, attributes, and song resources", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        data: [
          {
            id: "playlist-fixture",
            type: "library-playlists",
            attributes: { url: "https://music.apple.com/us/playlist/fixture" },
          },
        ],
      });
    });
    const client = new AppleMusicMirrorClient({
      developerToken: "developer-token-fixture",
      apiBaseUrl: "https://api.fixture",
      fetcher,
    });
    const result = await client.createPlaylist(
      "music-user-token-fixture",
      "Friday mix",
      ["song-one", "song-two"],
      "A fixture playlist",
    );
    expect(result).toEqual({
      playlistId: "playlist-fixture",
      playlistUrl: "https://music.apple.com/us/playlist/fixture",
      addedCount: 2,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.fixture/v1/me/library/playlists");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer developer-token-fixture");
    expect(requests[0]!.headers.get("music-user-token")).toBe("music-user-token-fixture");
    expect(await requests[0]!.json()).toEqual({
      attributes: { name: "Friday mix", description: "A fixture playlist" },
      relationships: {
        tracks: {
          data: [
            { id: "song-one", type: "songs" },
            { id: "song-two", type: "songs" },
          ],
        },
      },
    });
  });

  it("appends documented song resources and does not issue a request for an empty batch", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [] });
    });
    const client = new AppleMusicMirrorClient({
      developerToken: "developer-token-fixture",
      apiBaseUrl: "https://api.fixture",
      fetcher,
    });
    await expect(client.addTracks("music-user-token-fixture", "playlist/fixture", ["song-one"])).resolves.toEqual({
      playlistId: "playlist/fixture",
      addedCount: 1,
    });
    await expect(client.addTracks("music-user-token-fixture", "playlist/fixture", [])).resolves.toEqual({
      playlistId: "playlist/fixture",
      addedCount: 0,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.fixture/v1/me/library/playlists/playlist%2Ffixture/tracks");
    expect(await requests[0]!.json()).toEqual({ data: [{ id: "song-one", type: "songs" }] });
  });

  it("preserves provider status without leaking token-like response or input values", async () => {
    const userToken = "music-user-token-fixture-secret";
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: userToken }), { status: 401 }),
    );
    const client = new AppleMusicMirrorClient({
      developerToken: "developer-token-fixture",
      apiBaseUrl: "https://api.fixture",
      fetcher,
    });
    await expect(client.createPlaylist(userToken, "Friday mix", ["song-one"])).rejects.toMatchObject({
      status: 401,
      code: "provider_error",
    });
    try {
      await client.createPlaylist(userToken, "Friday mix", ["song-one"]);
    } catch (error) {
      expect(String(error)).not.toContain(userToken);
    }
    await expect(
      client.createPlaylist("music-user-token-fixture\nsecret", "Friday mix", ["song-one"]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns a typed error when Apple omits the playlist id", async () => {
    const client = new AppleMusicMirrorClient({
      developerToken: "developer-token-fixture",
      apiBaseUrl: "https://api.fixture",
      fetcher: async () => Response.json({ data: [{ attributes: {} }] }),
    });
    await expect(client.createPlaylist("music-user-token-fixture", "Friday mix", [])).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
  });
});
