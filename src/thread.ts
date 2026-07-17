export const THREAD_TITLE_MAX_LENGTH = 80;
export const THREAD_REQUEST_KEY_MAX_LENGTH = 128;
export const THREAD_ACTIVE_CONTRIBUTION_LIMIT = 50;

const CONTROL_CHARACTER = /\p{Cc}/u;

export type SourceProvider = "spotify" | "apple";

export interface ContributionIdentity {
  linkSlug: string;
  sourceProvider: SourceProvider;
  sourceCatalogId: string;
  sourceStorefront: string;
}

export interface ThreadCapabilities {
  publicCapability: string;
  managementCapability: string;
  managementDigest: string;
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
  return sha256(capability);
}

export async function fingerprintContributionInput(
  identity: ContributionIdentity,
): Promise<string> {
  return sha256(
    JSON.stringify([
      identity.linkSlug,
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
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
