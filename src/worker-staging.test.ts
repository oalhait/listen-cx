import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import production, { ThreadLive as ProductionThreadLive, ThreadPublisher as ProductionThreadPublisher } from "./worker-production.js";
import worker, { ThreadPublisher } from "./worker.js";
import { ThreadLive } from "./legacy-thread.js";

it("uses the current Worker while retaining the legacy class in the production entrypoint", () => {
  expect(production).toBe(worker);
  expect(ProductionThreadLive).toBe(ThreadLive);
  expect(ProductionThreadPublisher).toBe(ThreadPublisher);
});

it("retires legacy requests and alarms without deleting stored Thread data or sending notifications", async () => {
  const namespace = (env as unknown as { LEGACY_THREAD: DurableObjectNamespace }).LEGACY_THREAD;
  const stub = namespace.getByName(crypto.randomUUID());
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
  try {
    await runInDurableObject(stub, async (_, state) => {
      await state.storage.put("legacy-thread", { title: "Preserved" });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const response = await stub.fetch("https://legacy.invalid/");
    expect(response.status).toBe(410);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.get("legacy-thread")).toEqual({ title: "Preserved" });
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
