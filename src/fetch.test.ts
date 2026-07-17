import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./fetch.js";

describe("fetchWithRetry", () => {
  it("bounds each provider attempt with a deadline", async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }
      }),
    );

    await expect(
      fetchWithRetry(fetcher, "https://provider.example", undefined, 1),
    ).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("preserves a caller abort signal", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }
      }),
    );
    controller.abort(new Error("caller cancelled"));

    await expect(
      fetchWithRetry(fetcher, "https://provider.example", { signal: controller.signal }),
    ).rejects.toThrow("caller cancelled");
  });
});
