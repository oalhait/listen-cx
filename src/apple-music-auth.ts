const MAX_TOKEN_TTL_SECONDS = 15_777_000;
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;

export interface AppleMusicAuthEnv {
  APPLE_MUSIC_TEAM_ID?: string;
  APPLE_MUSIC_KEY_ID?: string;
  APPLE_MUSIC_PRIVATE_KEY_P8?: string;
  APPLE_MUSIC_ALLOWED_ORIGINS?: string;
  APPLE_MUSIC_MEDIA_ID?: string;
}

export interface AppleMusicDeveloperTokenConfig {
  teamId: string;
  keyId: string;
  privateKeyP8: string;
  allowedOrigins: string[];
  mediaId: string;
  ttlSeconds?: number;
}

export interface AppleMusicDeveloperToken {
  developerToken: string;
  expiresAt: string;
  allowedOrigins: string[];
  mediaId: string;
}

export class AppleMusicConfigurationError extends Error {
  constructor(message = "Apple Music configuration is invalid.") {
    super(message);
    this.name = "AppleMusicConfigurationError";
  }
}

function requireText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AppleMusicConfigurationError(`${label} is invalid.`);
  }
  return normalized;
}

function normalizePrivateKey(value: string | undefined): string {
  const pem = value?.trim().replace(/\\n/g, "\n");
  if (
    !pem
    || !pem.startsWith("-----BEGIN PRIVATE KEY-----")
    || !pem.endsWith("-----END PRIVATE KEY-----")
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(pem)
  ) {
    throw new AppleMusicConfigurationError("Apple Music private key is invalid.");
  }
  return pem;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const origins = requireText(value, "Apple Music allowed origins")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0 || origins.some((origin) => {
    try {
      const url = new URL(origin);
      return url.origin !== origin || !["http:", "https:"].includes(url.protocol);
    } catch {
      return true;
    }
  })) {
    throw new AppleMusicConfigurationError("Apple Music allowed origins are invalid.");
  }
  return [...new Set(origins)];
}

export function appleMusicConfigFromEnv(env: AppleMusicAuthEnv): AppleMusicDeveloperTokenConfig {
  return {
    teamId: requireText(env.APPLE_MUSIC_TEAM_ID, "Apple Music team id"),
    keyId: requireText(env.APPLE_MUSIC_KEY_ID, "Apple Music key id"),
    privateKeyP8: normalizePrivateKey(env.APPLE_MUSIC_PRIVATE_KEY_P8),
    allowedOrigins: parseAllowedOrigins(env.APPLE_MUSIC_ALLOWED_ORIGINS),
    mediaId: requireText(env.APPLE_MUSIC_MEDIA_ID, "Apple Music media id"),
  };
}

function base64UrlEncode(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemBytes(pem: string): Uint8Array {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  try {
    const binary = atob(body);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new AppleMusicConfigurationError("Apple Music private key is invalid.");
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function derLength(bytes: Uint8Array, offset: number): { length: number; next: number } | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4 || offset + count >= bytes.length) return null;
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    length = length * 256 + bytes[offset + 1 + index]!;
  }
  return { length, next: offset + 1 + count };
}

function joseInteger(value: Uint8Array): Uint8Array | null {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const significant = value.subarray(start);
  if (significant.length > 32) return null;
  const result = new Uint8Array(32);
  result.set(significant, 32 - significant.length);
  return result;
}

function normalizeEcdsaSignature(signature: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(signature);
  if (bytes.length === 64) return bytes;
  if (bytes[0] !== 0x30) throw new AppleMusicConfigurationError("Apple Music signature is invalid.");
  const sequence = derLength(bytes, 1);
  if (!sequence || sequence.next + sequence.length !== bytes.length) {
    throw new AppleMusicConfigurationError("Apple Music signature is invalid.");
  }
  let offset = sequence.next;
  if (bytes[offset] !== 0x02) throw new AppleMusicConfigurationError("Apple Music signature is invalid.");
  const rLength = derLength(bytes, offset + 1);
  if (!rLength) throw new AppleMusicConfigurationError("Apple Music signature is invalid.");
  const rStart = rLength.next;
  const rEnd = rStart + rLength.length;
  offset = rEnd;
  if (bytes[offset] !== 0x02) throw new AppleMusicConfigurationError("Apple Music signature is invalid.");
  const sLength = derLength(bytes, offset + 1);
  if (!sLength) throw new AppleMusicConfigurationError("Apple Music signature is invalid.");
  const sStart = sLength.next;
  const sEnd = sStart + sLength.length;
  const r = joseInteger(bytes.subarray(rStart, rEnd));
  const s = joseInteger(bytes.subarray(sStart, sEnd));
  if (!r || !s || sEnd !== bytes.length) {
    throw new AppleMusicConfigurationError("Apple Music signature is invalid.");
  }
  const result = new Uint8Array(64);
  result.set(r, 0);
  result.set(s, 32);
  return result;
}

export async function createAppleMusicDeveloperToken(
  config: AppleMusicDeveloperTokenConfig,
  nowMs = Date.now(),
): Promise<AppleMusicDeveloperToken> {
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TOKEN_TTL_SECONDS) {
    throw new AppleMusicConfigurationError("Apple Music token lifetime is invalid.");
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new AppleMusicConfigurationError("Apple Music token clock is invalid.");
  }
  const validated = appleMusicConfigFromEnv({
    APPLE_MUSIC_TEAM_ID: config.teamId,
    APPLE_MUSIC_KEY_ID: config.keyId,
    APPLE_MUSIC_PRIVATE_KEY_P8: config.privateKeyP8,
    APPLE_MUSIC_ALLOWED_ORIGINS: config.allowedOrigins.join(","),
    APPLE_MUSIC_MEDIA_ID: config.mediaId,
  });
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const header = base64UrlEncode(JSON.stringify({
    alg: "ES256",
    kid: validated.keyId,
    typ: "JWT",
  }));
  const payload = base64UrlEncode(JSON.stringify({
    iss: validated.teamId,
    iat: issuedAt,
    exp: expiresAt,
    origin: validated.allowedOrigins,
  }));
  const signingInput = `${header}.${payload}`;

  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      asArrayBuffer(pemBytes(validated.privateKeyP8)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new AppleMusicConfigurationError("Apple Music private key is invalid.");
  }
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return {
    developerToken: `${signingInput}.${base64UrlEncode(normalizeEcdsaSignature(signature))}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    allowedOrigins: validated.allowedOrigins,
    mediaId: validated.mediaId,
  };
}
