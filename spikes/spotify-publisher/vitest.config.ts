import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/publishing/spotify/*.test.ts", "spikes/spotify-publisher/*.test.ts"] },
});
