import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isThreadCapability, sha256Hex } from "./thread.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MANAGEMENT_COOKIE = "manage";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const MANAGEMENT_AUTHORIZATION = Symbol("ManagementAuthorization");

export const MANAGEMENT_ACTION_HEADER = "x-listen-management-action";
export const MANAGEMENT_ACTION_VALUE = "1";
export const PUBLIC_ACTION_HEADER = "x-listen-action";

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
  if (!isThreadCapability(publicCapability) || !isThreadCapability(managementCapability)) {
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
  if (!isThreadCapability(publicCapability)) {
    throw new Error("Invalid Thread capability");
  }
  return `/t/${publicCapability}`;
}

export function setManagementCookie(
  context: Context,
  publicCapability: string,
  managementCapability: string,
): void {
  if (!isThreadCapability(managementCapability)) {
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

export function isAllowedPublicMutation(
  request: Request,
  baseUrl: string,
  action:
    | "create-thread"
    | "add-song"
    | "thread-event"
    | "thread-notifications"
    | "apple-music-spike",
): boolean {
  if (request.method !== "POST") return false;

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(baseUrl).origin;
  } catch {
    return false;
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    request.headers.get("origin") === expectedOrigin &&
    request.headers.get(PUBLIC_ACTION_HEADER) === action &&
    mediaType === "application/json"
  );
}

export function threadSecurityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

export function coarseNetworkKey(address: string | undefined): string {
  if (!address) return "unknown-network";

  const ipv4 = address.split(".");
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.0/24`;
  }

  const value = address.toLowerCase().split("%", 1)[0] ?? "";
  const halves = value.split("::");
  if (halves.length > 2) return "unknown-network";
  const left = halves[0]?.split(":").filter(Boolean) ?? [];
  const right = halves[1]?.split(":").filter(Boolean) ?? [];
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0 || (halves.length === 2 && omitted === 0)) {
    return "unknown-network";
  }
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))
  ) {
    return "unknown-network";
  }
  const prefix = groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":");
  return `${prefix}::/64`;
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
      let success: boolean;
      try {
        ({ success } = await binding.limit({ key }));
      } catch (error) {
        console.error(
          JSON.stringify({ message: "Thread rate limiter unavailable", scope, error: String(error) }),
        );
        return { allowed: true, retryAfterSeconds: null };
      }
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
