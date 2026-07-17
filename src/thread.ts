export const THREAD_TITLE_MAX_LENGTH = 80;
export const THREAD_REQUEST_KEY_MAX_LENGTH = 128;
export const THREAD_ACTIVE_CONTRIBUTION_LIMIT = 50;

const CONTROL_CHARACTER = /\p{Cc}/u;
const THREAD_CAPABILITY = /^[A-Za-z0-9_-]{22}$/;

export type SourceProvider = Provider;

export interface ContributionIdentity {
  linkSlug: string;
  sourceProvider: SourceProvider;
  sourceCatalogId: string;
  sourceStorefront: string;
}

export type ContributionSourceIdentity = Omit<ContributionIdentity, "linkSlug">;

export interface ThreadCapabilities {
  publicCapability: string;
  managementCapability: string;
  managementDigest: string;
}

export function isThreadCapability(value: string): boolean {
  return THREAD_CAPABILITY.test(value);
}

export function normalizeThreadTitle(input: string): string {
  return normalizeBoundedText(input, "Thread title", THREAD_TITLE_MAX_LENGTH);
}

export function normalizeRequestKey(input: string): string {
  return normalizeBoundedText(input, "Request key", THREAD_REQUEST_KEY_MAX_LENGTH);
}

export async function createThreadCapabilities(): Promise<ThreadCapabilities> {
  const publicCapability = randomCapability();
  let managementCapability = randomCapability();
  while (managementCapability === publicCapability) {
    managementCapability = randomCapability();
  }

  return {
    publicCapability,
    managementCapability,
    managementDigest: await digestManagementCapability(managementCapability),
  };
}

export async function digestManagementCapability(capability: string): Promise<string> {
  return sha256Hex(capability);
}

export async function fingerprintContributionInput(
  identity: ContributionSourceIdentity,
): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      identity.sourceProvider,
      identity.sourceCatalogId,
      identity.sourceStorefront,
    ]),
  );
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

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
import { nanoid } from "nanoid";
import type { Provider } from "./urls.js";
