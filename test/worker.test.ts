import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createThreadLimiters, getThreadMaximum } from "../src/worker.js";

describe("worker", () => {
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
});
