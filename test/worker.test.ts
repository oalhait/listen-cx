import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createThreadLimiters, getThreadMaximum, getWorkerApp, getWorkerBaseUrl } from "../src/worker.js";

describe("worker", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM thread_contributions").run();
    await env.DB.prepare("DELETE FROM threads").run();
    await env.DB.prepare("DELETE FROM links").run();
  });

  it("serves the health check through the Worker entrypoint", async () => {
    const response = await exports.default.fetch("https://staging.example/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("binds separate creation and contribution limiters in staging", () => {
    expect(env.THREAD_CREATE_RATE_LIMITER).toBeDefined();
    expect(env.THREAD_CONTRIBUTION_RATE_LIMITER).toBeDefined();
    expect(getThreadMaximum(env)).toBe(10_000);
    expect(createThreadLimiters(env)).toMatchObject({
      creation: { check: expect.any(Function) },
      contribution: { check: expect.any(Function) },
    });
  });

  it("uses the local request origin for local development", () => {
    expect(getWorkerBaseUrl({ BASE_URL: "" }, "http://localhost:8787/")).toBe(
      "http://localhost:8787",
    );
    expect(getWorkerBaseUrl({ BASE_URL: "https://staging.listen.cx" }, "https://staging.listen.cx/healthz")).toBe(
      "https://staging.listen.cx",
    );
  });

  it("reuses the assembled app for the same immutable Worker configuration", () => {
    const first = getWorkerApp(env, "https://staging.listen.cx/healthz");
    const second = getWorkerApp(env, "https://another-origin.example/healthz");

    expect(second).toBe(first);
  });

  it("wires the configured Thread store and limiter dependencies into the entrypoint", async () => {
    const page = await exports.default.fetch("https://staging.listen.cx/threads/new");
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toContain("noindex");

    const response = await exports.default.fetch("https://staging.listen.cx/api/threads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.40",
        origin: "https://staging.listen.cx",
        "x-listen-action": "create-thread",
      },
      body: JSON.stringify({ title: "Worker wiring" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      publicUrl: expect.stringMatching(/^https:\/\/staging\.listen\.cx\/t\//),
      managementUrl: expect.stringContaining("#manage="),
    });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM threads").first<{
      count: number;
    }>();
    expect(count?.count).toBe(1);
  });
});
