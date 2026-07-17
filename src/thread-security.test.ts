import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  MANAGEMENT_ACTION_HEADER,
  MANAGEMENT_ACTION_VALUE,
  authorizeManagementCapability,
  coarseNetworkKey,
  createCloudflareAttemptLimiter,
  fixedAttemptLimiter,
  getManagementCookie,
  isAllowedManagementRequest,
  setManagementCookie,
  threadSecurityHeaders,
} from "./thread-security.js";
import { digestManagementCapability } from "./thread.js";

const PUBLIC_CAPABILITY = "A".repeat(22);
const MANAGEMENT_CAPABILITY = "B".repeat(22);

describe("management capability authorization", () => {
  it("returns a grant only after comparing the stored digest", async () => {
    const getManagementDigest = vi
      .fn()
      .mockResolvedValue(await digestManagementCapability(MANAGEMENT_CAPABILITY));

    const authorized = await authorizeManagementCapability(
      { getManagementDigest },
      PUBLIC_CAPABILITY,
      MANAGEMENT_CAPABILITY,
    );
    const rejected = await authorizeManagementCapability(
      { getManagementDigest },
      PUBLIC_CAPABILITY,
      "C".repeat(22),
    );

    expect(authorized).toMatchObject({ publicCapability: PUBLIC_CAPABILITY });
    expect(JSON.stringify(authorized)).not.toContain(MANAGEMENT_CAPABILITY);
    expect(rejected).toBeNull();
    expect(getManagementDigest).toHaveBeenCalledWith(PUBLIC_CAPABILITY);
    expect(getManagementDigest).not.toHaveBeenCalledWith(
      PUBLIC_CAPABILITY,
      MANAGEMENT_CAPABILITY,
    );
  });

  it("fails closed for a missing or malformed stored digest", async () => {
    await expect(
      authorizeManagementCapability(
        { getManagementDigest: async () => null },
        PUBLIC_CAPABILITY,
        MANAGEMENT_CAPABILITY,
      ),
    ).resolves.toBeNull();
    await expect(
      authorizeManagementCapability(
        { getManagementDigest: async () => "not-a-sha256-digest" },
        PUBLIC_CAPABILITY,
        MANAGEMENT_CAPABILITY,
      ),
    ).resolves.toBeNull();
  });
});

describe("management cookie policy", () => {
  it("sets a one-year path-scoped management cookie with strict browser protections", async () => {
    const app = new Hono();
    app.get("/activate", (c) => {
      setManagementCookie(c, PUBLIC_CAPABILITY, MANAGEMENT_CAPABILITY);
      return c.text(getManagementCookie(c) ?? "activated");
    });

    const response = await app.request("https://listen.cx/activate");
    const cookie = response.headers.get("set-cookie");

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Path=/t/${PUBLIC_CAPABILITY}`);
    expect(cookie).toContain("Max-Age=31536000");
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects a malformed Thread capability before constructing a cookie path", async () => {
    const app = new Hono();
    app.get("/activate", (c) => {
      setManagementCookie(c, "../api", MANAGEMENT_CAPABILITY);
      return c.text("unexpected");
    });

    const response = await app.request("https://listen.cx/activate");
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("management mutation guard", () => {
  it("allows only unsafe same-origin requests with the custom action header", () => {
    const allowed = new Request("https://listen.cx/t/thread/manage/remove", {
      method: "POST",
      headers: {
        origin: "https://listen.cx",
        [MANAGEMENT_ACTION_HEADER]: MANAGEMENT_ACTION_VALUE,
      },
    });
    const getRequest = new Request("https://listen.cx/t/thread/manage/remove", {
      headers: {
        origin: "https://listen.cx",
        [MANAGEMENT_ACTION_HEADER]: MANAGEMENT_ACTION_VALUE,
      },
    });
    const optionsRequest = new Request("https://listen.cx/t/thread/manage/remove", {
      method: "OPTIONS",
      headers: {
        origin: "https://listen.cx",
        [MANAGEMENT_ACTION_HEADER]: MANAGEMENT_ACTION_VALUE,
      },
    });
    const foreign = new Request("https://listen.cx/t/thread/manage/remove", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        [MANAGEMENT_ACTION_HEADER]: MANAGEMENT_ACTION_VALUE,
      },
    });
    const opaque = new Request("https://listen.cx/t/thread/manage/remove", {
      method: "POST",
      headers: {
        origin: "null",
        [MANAGEMENT_ACTION_HEADER]: MANAGEMENT_ACTION_VALUE,
      },
    });
    const missingHeader = new Request("https://listen.cx/t/thread/manage/remove", {
      method: "POST",
      headers: { origin: "https://listen.cx" },
    });

    expect(isAllowedManagementRequest(allowed, "https://listen.cx")).toBe(true);
    expect(isAllowedManagementRequest(getRequest, "https://listen.cx")).toBe(false);
    expect(isAllowedManagementRequest(optionsRequest, "https://listen.cx")).toBe(false);
    expect(isAllowedManagementRequest(foreign, "https://listen.cx")).toBe(false);
    expect(isAllowedManagementRequest(opaque, "https://listen.cx")).toBe(false);
    expect(isAllowedManagementRequest(missingHeader, "https://listen.cx")).toBe(false);
  });
});

describe("Thread response headers", () => {
  it("prevents caching, referrer leakage, and indexing", () => {
    expect(threadSecurityHeaders()).toEqual({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
  });
});

describe("Cloudflare attempt limiter", () => {
  it("coarsens network addresses before they become limiter input", () => {
    expect(coarseNetworkKey("203.0.113.47")).toBe("203.0.113.0/24");
    expect(coarseNetworkKey("2001:db8:abcd:12::9")).toBe("2001:db8:abcd:12::/64");
    expect(coarseNetworkKey("not-an-address")).toBe("unknown-network");
    expect(coarseNetworkKey(undefined)).toBe("unknown-network");
  });

  it("provides deterministic allow and deny adapters for tests", async () => {
    await expect(
      fixedAttemptLimiter({ allowed: true, retryAfterSeconds: null }).check("ignored"),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: null });
    await expect(
      fixedAttemptLimiter({ allowed: false, retryAfterSeconds: 12 }).check("ignored"),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 12 });
  });

  it("hashes endpoint-scoped keys and returns a retry interval on denial", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const limiter = createCloudflareAttemptLimiter({ limit }, "thread:create", 60);

    await expect(limiter.check("203.0.113.7")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    const key = limit.mock.calls[0]?.[0]?.key;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("203.0.113.7");
    expect(key).not.toContain("thread:create");
  });

  it("separates identical raw keys by limiter scope", async () => {
    const creationLimit = vi.fn().mockResolvedValue({ success: true });
    const contributionLimit = vi.fn().mockResolvedValue({ success: true });
    const creation = createCloudflareAttemptLimiter(
      { limit: creationLimit },
      "thread:create",
      60,
    );
    const contribution = createCloudflareAttemptLimiter(
      { limit: contributionLimit },
      "thread:contribute",
      60,
    );

    await expect(creation.check(PUBLIC_CAPABILITY)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: null,
    });
    await contribution.check(PUBLIC_CAPABILITY);

    expect(creationLimit.mock.calls[0]?.[0]?.key).not.toBe(
      contributionLimit.mock.calls[0]?.[0]?.key,
    );
  });
});
