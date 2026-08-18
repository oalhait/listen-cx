const APPLE_MUSIC_API_BASE = "https://api.music.apple.com";
const MAX_TOKEN_TTL_SECONDS = 15_777_000;
const DEFAULT_TOKEN_TTL_SECONDS = MAX_TOKEN_TTL_SECONDS;

type Fetcher = typeof fetch;

export interface AppleMusicDeveloperTokenConfig {
  teamId: string;
  keyId: string;
  privateKeyP8: string;
  allowedOrigins: string[];
  now?: number | (() => number);
  ttl?: number;
  ttlSeconds?: number;
}

export interface AppleMusicMirrorClientOptions {
  developerToken?: string;
  developerTokenConfig?: AppleMusicDeveloperTokenConfig;
  fetcher?: Fetcher;
  fetch?: Fetcher;
  apiBaseUrl?: string;
  defaultDescription?: string;
}

export interface AppleMusicPlaylistResult {
  playlistId: string;
  playlistUrl?: string;
  addedCount: number;
}

export interface AppleMusicTracksResult {
  playlistId: string;
  addedCount: number;
}

export type AppleMusicErrorCode =
  | "invalid_config"
  | "invalid_private_key"
  | "invalid_input"
  | "signature_format"
  | "request_failed"
  | "provider_error"
  | "invalid_response";

export class AppleMusicError extends Error {
  readonly code: AppleMusicErrorCode;
  readonly status: number | null;

  constructor(
    code: AppleMusicErrorCode,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "AppleMusicError";
    this.code = code;
    this.status = status;
  }
}

export class AppleMusicConfigurationError extends AppleMusicError {
  constructor(message = "Apple Music configuration is invalid", code: "invalid_config" | "invalid_private_key" = "invalid_config") {
    super(code, message);
    this.name = "AppleMusicConfigurationError";
  }
}

export class AppleMusicProviderError extends AppleMusicError {
  constructor(
    message: string,
    status: number | null,
    code: "request_failed" | "provider_error" | "invalid_response" = "provider_error",
  ) {
    super(code, message, status);
    this.name = "AppleMusicProviderError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rejectControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || rejectControlCharacters(value)) {
    throw new AppleMusicConfigurationError(message);
  }
}

function normalizeNow(value: number | (() => number) | undefined): number {
  const now = typeof value === "function" ? value() : value ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new AppleMusicConfigurationError("Apple Music token clock is invalid");
  }
  return now;
}

function normalizePrivateKeyPem(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppleMusicConfigurationError("Apple Music private key is invalid", "invalid_private_key");
  }
  const pem = value.trim().replace(/\\n/g, "\n");
  if (
    !pem.startsWith("-----BEGIN PRIVATE KEY-----") ||
    !pem.endsWith("-----END PRIVATE KEY-----") ||
    rejectControlCharacters(pem.replace(/\r?\n/g, ""))
  ) {
    throw new AppleMusicConfigurationError("Apple Music private key is invalid", "invalid_private_key");
  }
  return pem;
}

function validateOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || rejectControlCharacters(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === value;
  } catch {
    return false;
  }
}

function validateDeveloperTokenConfig(config: AppleMusicDeveloperTokenConfig): string {
  if (!isRecord(config)) throw new AppleMusicConfigurationError();
  assertNonEmptyString(config.teamId, "Apple Music team id is invalid");
  assertNonEmptyString(config.keyId, "Apple Music key id is invalid");
  const privateKeyPem = normalizePrivateKeyPem(config.privateKeyP8);
  if (
    !Array.isArray(config.allowedOrigins) ||
    config.allowedOrigins.length === 0 ||
    config.allowedOrigins.some((origin) => !validateOrigin(origin))
  ) {
    throw new AppleMusicConfigurationError("Apple Music allowed origins are invalid");
  }
  const configuredTtl = config.ttlSeconds ?? config.ttl;
  if (
    configuredTtl !== undefined &&
    (!Number.isSafeInteger(configuredTtl) || configuredTtl < 1 || configuredTtl > MAX_TOKEN_TTL_SECONDS)
  ) {
    throw new AppleMusicConfigurationError("Apple Music token lifetime is invalid");
  }
  if (config.now !== undefined) normalizeNow(config.now);
  return privateKeyPem;
}

function base64UrlEncode(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodePemBody(pem: string): Uint8Array {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/[\r\n\t ]/g, "");
  if (!body || !/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 === 1) {
    throw new AppleMusicConfigurationError("Apple Music private key is invalid", "invalid_private_key");
  }
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new AppleMusicConfigurationError("Apple Music private key is invalid", "invalid_private_key");
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
  for (let index = 0; index < count; index += 1) length = length * 256 + bytes[offset + 1 + index]!;
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

export function ecdsaDerToJose(signature: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  if (bytes.length === 64) return new Uint8Array(bytes);
  if (bytes[0] !== 0x30) throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  const sequenceLength = derLength(bytes, 1);
  if (!sequenceLength || sequenceLength.next + sequenceLength.length !== bytes.length) {
    throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  }
  let offset = sequenceLength.next;
  if (bytes[offset] !== 0x02) throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  const rLength = derLength(bytes, offset + 1);
  if (!rLength) throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  const rStart = rLength.next;
  const rEnd = rStart + rLength.length;
  if (rEnd > bytes.length) throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  offset = rEnd;
  if (bytes[offset] !== 0x02) throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  const sLength = derLength(bytes, offset + 1);
  if (!sLength) throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  const sStart = sLength.next;
  const sEnd = sStart + sLength.length;
  if (sEnd !== bytes.length) throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  const r = joseInteger(bytes.subarray(rStart, rEnd));
  const s = joseInteger(bytes.subarray(sStart, sEnd));
  if (!r || !s) throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  const result = new Uint8Array(64);
  result.set(r, 0);
  result.set(s, 32);
  return result;
}

function normalizeSignature(signature: ArrayBuffer): Uint8Array {
  try {
    return ecdsaDerToJose(signature);
  } catch (error) {
    if (error instanceof AppleMusicError && error.code === "signature_format") throw error;
    throw new AppleMusicError("signature_format", "Apple Music signature format is invalid");
  }
}

export async function createAppleMusicDeveloperToken(
  config: AppleMusicDeveloperTokenConfig,
  nowMs?: number,
): Promise<string> {
  const privateKeyPem = validateDeveloperTokenConfig(config);
  const now = Math.floor(normalizeNow(nowMs ?? config.now) / 1000);
  const ttlSeconds = config.ttlSeconds ?? config.ttl ?? DEFAULT_TOKEN_TTL_SECONDS;
  const header = { alg: "ES256", kid: config.keyId, typ: "JWT" };
  const claims = {
    iss: config.teamId,
    iat: now,
    exp: now + ttlSeconds,
    origin: [...config.allowedOrigins],
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      asArrayBuffer(decodePemBody(privateKeyPem)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new AppleMusicConfigurationError("Apple Music private key is invalid", "invalid_private_key");
  }

  let signature: ArrayBuffer;
  try {
    signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      asArrayBuffer(new TextEncoder().encode(signingInput)),
    );
  } catch {
    throw new AppleMusicError("signature_format", "Apple Music token signing failed");
  }
  return `${signingInput}.${base64UrlEncode(normalizeSignature(signature))}`;
}

function assertInputString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || rejectControlCharacters(value)) {
    throw new AppleMusicError("invalid_input", message);
  }
}

function assertText(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || rejectControlCharacters(value)) {
    throw new AppleMusicError("invalid_input", message);
  }
}

function assertTrackIds(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((trackId) => typeof trackId !== "string" || trackId.length === 0 || rejectControlCharacters(trackId))
  ) {
    throw new AppleMusicError("invalid_input", "Apple Music track ids are invalid");
  }
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const base = value ?? APPLE_MUSIC_API_BASE;
  try {
    const parsed = new URL(base);
    if (
      !(parsed.protocol === "https:" || parsed.protocol === "http:") ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error();
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new AppleMusicConfigurationError("Apple Music API base URL is invalid");
  }
}

function joinApiUrl(base: string, path: string): string {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export class AppleMusicMirrorClient {
  private readonly fetcher: Fetcher;
  private readonly apiBaseUrl: string;
  private readonly developerToken: string | undefined;
  private readonly developerTokenConfig: AppleMusicDeveloperTokenConfig | undefined;
  private readonly defaultDescription: string;

  constructor(
    options: AppleMusicMirrorClientOptions | AppleMusicDeveloperTokenConfig,
    fetcher?: Fetcher,
  ) {
    const normalized: AppleMusicMirrorClientOptions =
      "privateKeyP8" in options ? { developerTokenConfig: options } : options;
    if (normalized.developerToken !== undefined && normalized.developerTokenConfig !== undefined) {
      throw new AppleMusicConfigurationError("Apple Music developer token configuration is ambiguous");
    }
    if (normalized.developerToken !== undefined) {
      if (
        typeof normalized.developerToken !== "string" ||
        normalized.developerToken.length === 0 ||
        rejectControlCharacters(normalized.developerToken)
      ) {
        throw new AppleMusicConfigurationError("Apple Music developer token is invalid");
      }
      this.developerToken = normalized.developerToken;
    } else {
      this.developerToken = undefined;
    }
    this.developerTokenConfig = normalized.developerTokenConfig;
    this.fetcher = fetcher ?? normalized.fetcher ?? normalized.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== "function") throw new AppleMusicConfigurationError("Apple Music fetcher is invalid");
    this.apiBaseUrl = normalizeApiBaseUrl(normalized.apiBaseUrl);
    this.defaultDescription = normalized.defaultDescription ?? "";
    if (rejectControlCharacters(this.defaultDescription)) {
      throw new AppleMusicConfigurationError("Apple Music playlist description is invalid");
    }
  }

  async createPlaylist(
    userToken: string,
    name: string,
    trackIds: string[],
    description = this.defaultDescription,
  ): Promise<AppleMusicPlaylistResult> {
    assertInputString(userToken, "Apple Music user token is invalid");
    assertInputString(name, "Apple Music playlist name is invalid");
    assertText(description, "Apple Music playlist description is invalid");
    assertTrackIds(trackIds);
    const relationships =
      trackIds.length > 0
        ? { tracks: { data: trackIds.map((id) => ({ id, type: "songs" as const })) } }
        : undefined;
    const body: Record<string, unknown> = {
      attributes: { name, description },
    };
    if (relationships) body.relationships = relationships;

    const response = await this.request(userToken, "/v1/me/library/playlists", body, "create playlist");
    const resource = this.readPlaylistResource(response.value, response.status);
    return {
      playlistId: resource.id,
      addedCount: trackIds.length,
      ...(resource.url ? { playlistUrl: resource.url } : {}),
    };
  }

  async addTracks(userToken: string, playlistId: string, trackIds: string[]): Promise<AppleMusicTracksResult> {
    assertInputString(userToken, "Apple Music user token is invalid");
    assertInputString(playlistId, "Apple Music playlist id is invalid");
    assertTrackIds(trackIds);
    if (trackIds.length === 0) return { playlistId, addedCount: 0 };
    const body = { data: trackIds.map((id) => ({ id, type: "songs" as const })) };
    await this.request(
      userToken,
      `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`,
      body,
      "add tracks",
      false,
    );
    return { playlistId, addedCount: trackIds.length };
  }

  private async resolveDeveloperToken(): Promise<string> {
    if (this.developerToken !== undefined) return this.developerToken;
    if (!this.developerTokenConfig) {
      throw new AppleMusicConfigurationError("Apple Music developer token is not configured");
    }
    return createAppleMusicDeveloperToken(this.developerTokenConfig);
  }

  private async request(
    userToken: string,
    path: string,
    body: unknown,
    operation: string,
    parseJson = true,
  ): Promise<{ value: unknown; status: number }> {
    const developerToken = await this.resolveDeveloperToken();
    let response: Response;
    try {
      response = await Reflect.apply(this.fetcher, undefined, [joinApiUrl(this.apiBaseUrl, path), {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${developerToken}`,
          "Content-Type": "application/json",
          "Music-User-Token": userToken,
        },
        body: JSON.stringify(body),
      }]);
    } catch {
      throw new AppleMusicProviderError(`Apple Music ${operation} request failed`, null, "request_failed");
    }
    if (!response.ok) {
      throw new AppleMusicProviderError(`Apple Music ${operation} failed (status ${response.status})`, response.status);
    }
    if (!parseJson) return { value: null, status: response.status };
    try {
      return { value: await response.json(), status: response.status };
    } catch {
      throw new AppleMusicProviderError(`Apple Music ${operation} response is invalid`, response.status, "invalid_response");
    }
  }

  private readPlaylistResource(value: unknown, status: number): { id: string; url: string | null } {
    const first = isRecord(value) && Array.isArray(value.data) ? value.data[0] : undefined;
    if (!isRecord(first) || typeof first.id !== "string" || first.id.length === 0) {
      throw new AppleMusicProviderError("Apple Music playlist response is missing an id", status, "invalid_response");
    }
    const attributes = isRecord(first.attributes) ? first.attributes : undefined;
    const url = attributes && typeof attributes.url === "string" && attributes.url.length > 0 ? attributes.url : null;
    return { id: first.id, url };
  }
}
