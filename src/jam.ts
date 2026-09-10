import { nanoid } from "nanoid";
import type { Provider } from "./urls.js";

export const JAM_TITLE_MAX_LENGTH = 80;
export const JAM_REQUEST_KEY_MAX_LENGTH = 128;
export const JAM_ACTIVE_CONTRIBUTION_LIMIT = 50;
export const JAM_TOTAL_CONTRIBUTION_LIMIT = 500;

const CONTROL_CHARACTER = /\p{Cc}/u;
const JAM_CAPABILITY = /^[A-Za-z0-9_-]{22}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const JAM_MANAGEMENT_AUTHORIZATION: unique symbol = Symbol("JamManagementAuthorization");

type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(
    first: ArrayBuffer | ArrayBufferView,
    second: ArrayBuffer | ArrayBufferView,
  ): boolean;
};

export type JamSourceProvider = Provider;

export interface JamContributionIdentity {
  linkSlug: string;
  sourceProvider: JamSourceProvider;
  sourceCatalogId: string;
  sourceStorefront: string;
}

export type JamContributionSourceIdentity = Omit<JamContributionIdentity, "linkSlug">;

export interface JamCapabilities {
  publicCapability: string;
  managementCapability: string;
  managementDigest: string;
}

export interface JamManagementDigestReader {
  getManagementDigest(publicCapability: string): Promise<string | null>;
}

/**
 * An authorization can only be produced by authorizeJamManagementCapability.
 * Store mutation methods accept this instead of a raw bearer capability so a
 * caller cannot accidentally skip management-capability verification.
 */
export interface JamManagementAuthorization {
  readonly publicCapability: string;
  readonly [JAM_MANAGEMENT_AUTHORIZATION]: true;
}

export function isJamCapability(value: string): boolean {
  return JAM_CAPABILITY.test(value);
}

export function normalizeJamTitle(input: string): string {
  return normalizeBoundedText(input, "Jam title", JAM_TITLE_MAX_LENGTH);
}

export function normalizeJamRequestKey(input: string): string {
  return normalizeBoundedText(input, "Request key", JAM_REQUEST_KEY_MAX_LENGTH);
}

export async function createJamCapabilities(): Promise<JamCapabilities> {
  const publicCapability = randomCapability();
  let managementCapability = randomCapability();
  while (managementCapability === publicCapability) {
    managementCapability = randomCapability();
  }

  return {
    publicCapability,
    managementCapability,
    managementDigest: await digestJamManagementCapability(managementCapability),
  };
}

export async function digestJamManagementCapability(capability: string): Promise<string> {
  return sha256Hex(capability);
}

export async function fingerprintJamContributionInput(
  identity: JamContributionSourceIdentity,
): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      identity.sourceProvider,
      identity.sourceCatalogId,
      identity.sourceStorefront,
    ]),
  );
}

export async function authorizeJamManagementCapability(
  reader: JamManagementDigestReader,
  publicCapability: string,
  managementCapability: string,
): Promise<JamManagementAuthorization | null> {
  if (!isJamCapability(publicCapability) || !isJamCapability(managementCapability)) {
    return null;
  }

  const storedDigest = await reader.getManagementDigest(publicCapability);
  if (!storedDigest || !SHA256_HEX.test(storedDigest)) return null;

  const providedDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(managementCapability),
  );
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;
  if (!subtle.timingSafeEqual(providedDigest, hexToBytes(storedDigest))) return null;

  return {
    publicCapability,
    [JAM_MANAGEMENT_AUTHORIZATION]: true,
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeBoundedText(input: string, label: string, maximum: number): string {
  const normalized = input.trim();
  const length = [...normalized].length;
  if (length < 1 || length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`);
  }
  if (CONTROL_CHARACTER.test(normalized)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return normalized;
}

function randomCapability(): string {
  return nanoid(22);
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}
