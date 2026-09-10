import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { isThreadCapability, sha256 } from "./thread.js";

const AUTHORIZATION = Symbol("ThreadManagementAuthorization");
export interface ManagementAuthorization {
  readonly publicCapability: string;
  readonly [AUTHORIZATION]: true;
}

export async function authorizeManagementCapability(
  reader: { getManagementDigest(capability: string): Promise<string | null> },
  publicCapability: string,
  managementCapability: string,
): Promise<ManagementAuthorization | null> {
  if (!isThreadCapability(publicCapability) || !isThreadCapability(managementCapability)) return null;
  const expected = await reader.getManagementDigest(publicCapability);
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return null;
  const provided = await sha256(managementCapability);
  if (!timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(provided))) return null;
  return { publicCapability, [AUTHORIZATION]: true };
}

export function isManagementAuthorization(value: ManagementAuthorization): boolean {
  return value[AUTHORIZATION] === true;
}

function cookieName(capability: string): string {
  return `thread_manage_${capability}`;
}

export function managementCookie(context: Context, capability: string): string | undefined {
  return getCookie(context, cookieName(capability));
}

export function setManagementCookie(context: Context, capability: string, secret: string): void {
  const url = new URL(context.req.url);
  setCookie(context, cookieName(capability), secret, {
    httpOnly: true,
    sameSite: "Strict",
    secure: url.protocol === "https:",
    path: `/t/${capability}`,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function isSameOriginAction(request: Request, baseUrl: string): boolean {
  const type = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  return request.method === "POST" && request.headers.get("Origin") === new URL(baseUrl).origin
    && request.headers.get("X-Listen-Action") === "thread" && type === "application/json";
}

export const THREAD_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
