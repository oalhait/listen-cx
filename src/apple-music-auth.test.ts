import { describe, expect, it } from "vitest";
import {
  appleMusicConfigFromEnv,
  AppleMusicConfigurationError,
  createAppleMusicDeveloperToken,
} from "./apple-music-auth.js";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodePart(part: string): Record<string, unknown> {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(atob(normalized)) as Record<string, unknown>;
}

function decodeBytes(part: string): Uint8Array {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function testKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = base64(pkcs8).match(/.{1,64}/g)?.join("\n");
  return {
    privateKey: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
}

describe("Apple Music developer authorization", () => {
  it("parses comma-separated exact origins without exposing secret material", () => {
    const config = appleMusicConfigFromEnv({
      APPLE_MUSIC_TEAM_ID: "TEAM123456",
      APPLE_MUSIC_KEY_ID: "KEY1234567",
      APPLE_MUSIC_PRIVATE_KEY_P8: "-----BEGIN PRIVATE KEY-----\\nYWJj\\n-----END PRIVATE KEY-----",
      APPLE_MUSIC_ALLOWED_ORIGINS: "http://127.0.0.1:8787, https://staging.listen.cx,http://127.0.0.1:8787",
      APPLE_MUSIC_MEDIA_ID: "media.cx.listen.web",
    });
    expect(config.allowedOrigins).toEqual([
      "http://127.0.0.1:8787",
      "https://staging.listen.cx",
    ]);
    expect(config.privateKeyP8).toContain("\n");
  });

  it("creates a verifiable origin-bound ES256 developer token", async () => {
    const key = await testKey();
    const result = await createAppleMusicDeveloperToken({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKeyP8: key.privateKey,
      allowedOrigins: ["http://127.0.0.1:8787"],
      mediaId: "media.cx.listen.web",
      ttlSeconds: 3600,
    }, Date.parse("2026-09-10T00:00:00Z"));
    const [header, payload, signature] = result.developerToken.split(".");
    expect(header && payload && signature).toBeTruthy();
    expect(decodePart(header!)).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(decodePart(payload!)).toEqual({
      iss: "TEAM123456",
      iat: 1_788_998_400,
      exp: 1_789_002_000,
      origin: ["http://127.0.0.1:8787"],
    });
    expect(result).toMatchObject({
      expiresAt: "2026-09-10T01:00:00.000Z",
      allowedOrigins: ["http://127.0.0.1:8787"],
      mediaId: "media.cx.listen.web",
    });
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key.publicKey,
      asArrayBuffer(decodeBytes(signature!)),
      new TextEncoder().encode(`${header}.${payload}`),
    )).toBe(true);
  });

  it.each([
    { APPLE_MUSIC_ALLOWED_ORIGINS: "https://staging.listen.cx/path" },
    { APPLE_MUSIC_ALLOWED_ORIGINS: "javascript:alert(1)" },
    { APPLE_MUSIC_PRIVATE_KEY_P8: "not a key" },
  ])("rejects unsafe or incomplete configuration", (override) => {
    expect(() => appleMusicConfigFromEnv({
      APPLE_MUSIC_TEAM_ID: "TEAM123456",
      APPLE_MUSIC_KEY_ID: "KEY1234567",
      APPLE_MUSIC_PRIVATE_KEY_P8: "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----",
      APPLE_MUSIC_ALLOWED_ORIGINS: "https://staging.listen.cx",
      APPLE_MUSIC_MEDIA_ID: "media.cx.listen.web",
      ...override,
    })).toThrow(AppleMusicConfigurationError);
  });
});
