import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const CAPABILITY = /^[A-Za-z0-9_-]{22}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MANAGEMENT_COOKIE = "manage";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const MANAGEMENT_AUTHORIZATION = Symbol("ManagementAuthorization");

export const MANAGEMENT_ACTION_HEADER = "x-listen-management-action";
export const MANAGEMENT_ACTION_VALUE = "1";

export interface ManagementDigestReader {
  getManagementDigest(publicCapability: string): Promise<string | null>;
}

export interface ManagementAuthorization {
  readonly publicCapability: string;
  readonly [MANAGEMENT_AUTHORIZATION]: true;
}

export interface AttemptLimiter {
  check(key: string): Promise<LimitDecision>;
}

export interface LimitDecision {
  allowed: boolean;
  retryAfterSeconds: number | null;
}

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(
    a: ArrayBuffer | ArrayBufferView,
    b: ArrayBuffer | ArrayBufferView,
  ): boolean;
};

export async function authorizeManagementCapability(
  reader: ManagementDigestReader,
  publicCapability: string,
  managementCapability: string,
): Promise<ManagementAuthorization | null> {
  if (!CAPABILITY.test(publicCapability) || !CAPABILITY.test(managementCapability)) {
    return null;
  }

  const storedDigest = await reader.getManagementDigest(publicCapability);
  if (!storedDigest || !SHA256_HEX.test(storedDigest)) return null;

  const providedDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(managementCapability),
  );
  const storedDigestBytes = hexToBytes(storedDigest);
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;
  if (!subtle.timingSafeEqual(providedDigest, storedDigestBytes)) return null;

  return {
    publicCapability,
    [MANAGEMENT_AUTHORIZATION]: true,
  };
}

export function managementCookiePath(publicCapability: string): string {
  if (!CAPABILITY.test(publicCapability)) {
    throw new Error("Invalid Thread capability");
  }
  return `/t/${publicCapability}`;
}

export function setManagementCookie(
  context: Context,
  publicCapability: string,
  managementCapability: string,
): void {
  if (!CAPABILITY.test(managementCapability)) {
    throw new Error("Invalid management capability");
  }
  setCookie(context, MANAGEMENT_COOKIE, managementCapability, {
    httpOnly: true,
    maxAge: ONE_YEAR_SECONDS,
    path: managementCookiePath(publicCapability),
    sameSite: "Strict",
    secure: true,
  });
}

export function getManagementCookie(context: Context): string | undefined {
  return getCookie(context, MANAGEMENT_COOKIE);
}

export function clearManagementCookie(context: Context, publicCapability: string): void {
  deleteCookie(context, MANAGEMENT_COOKIE, {
    path: managementCookiePath(publicCapability),
    secure: true,
  });
}

export function isAllowedManagementRequest(request: Request, baseUrl: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return false;
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(baseUrl).origin;
  } catch {
    return false;
  }

  return (
    request.headers.get("origin") === expectedOrigin &&
    request.headers.get(MANAGEMENT_ACTION_HEADER) === MANAGEMENT_ACTION_VALUE
  );
}

export function threadSecurityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

export function createCloudflareAttemptLimiter(
  binding: RateLimitBinding,
  scope: string,
  retryAfterSeconds: number,
): AttemptLimiter {
  if (!scope || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error("Invalid rate limiter configuration");
  }

  return {
    async check(rawKey) {
      const key = await sha256Hex(`${scope}\0${rawKey}`);
      const { success } = await binding.limit({ key });
      return {
        allowed: success,
        retryAfterSeconds: success ? null : retryAfterSeconds,
      };
    },
  };
}

export function allowAllAttemptLimiter(): AttemptLimiter {
  return fixedAttemptLimiter({ allowed: true, retryAfterSeconds: null });
}

export function fixedAttemptLimiter(decision: LimitDecision): AttemptLimiter {
  if (
    decision.allowed !== (decision.retryAfterSeconds === null) ||
    (decision.retryAfterSeconds !== null &&
      (!Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 1))
  ) {
    throw new Error("Invalid fixed limiter decision");
  }

  return {
    async check() {
      return { ...decision };
    },
  };
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
