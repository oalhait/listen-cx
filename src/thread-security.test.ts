import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authorizeManagementCapability, isSameOriginAction, setManagementCookie } from "./thread-security.js";
import { sha256 } from "./thread.js";

const capability = "abcdefghijklmnopqrstuv";
const secret = "ABCDEFGHIJKLMNOPQRSTUV";
describe("Thread capability security", () => {
  it("requires the management secret, not just the public capability", async () => {
    const reader = { getManagementDigest: vi.fn().mockResolvedValue(await sha256(secret)) };
    expect(await authorizeManagementCapability(reader, capability, secret)).toMatchObject({ publicCapability: capability });
    expect(await authorizeManagementCapability(reader, capability, capability)).toBeNull();
    expect(await authorizeManagementCapability(reader, capability, "invalid")).toBeNull();
  });
  it("rejects absent, cross-origin and form mutations", () => {
    const init = { method: "POST", headers: { Origin: "https://listen.test", "X-Listen-Action": "thread", "Content-Type": "application/json" } };
    expect(isSameOriginAction(new Request("https://listen.test/api/threads", init), "https://listen.test")).toBe(true);
    for (const headers of [{ ...init.headers, Origin: "https://evil.test" }, { "Content-Type": "application/json" }, { ...init.headers, "Content-Type": "application/x-www-form-urlencoded" }]) {
      expect(isSameOriginAction(new Request("https://listen.test/api/threads", { method: "POST", headers }), "https://listen.test")).toBe(false);
    }
  });
  it("limits management cookies to their Thread with HttpOnly, Secure and SameSite protection", async () => {
    const app = new Hono().get("/", c => { setManagementCookie(c, capability, secret); return c.text("ok"); });
    const response = await app.request("https://listen.test/");
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain(`Path=/t/${capability}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });
});
