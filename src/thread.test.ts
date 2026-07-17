import { describe, expect, it } from "vitest";
import {
  THREAD_TITLE_MAX_LENGTH,
  createThreadCapabilities,
  fingerprintContributionInput,
  normalizeRequestKey,
  normalizeThreadTitle,
} from "./thread.js";

describe("normalizeThreadTitle", () => {
  it("trims a bounded Unicode title", () => {
    expect(normalizeThreadTitle("  café 🎶  ")).toBe("café 🎶");
    expect(normalizeThreadTitle("🎵".repeat(THREAD_TITLE_MAX_LENGTH))).toHaveLength(
      THREAD_TITLE_MAX_LENGTH * 2,
    );
  });

  it("rejects empty, overlong, and control-character titles", () => {
    expect(() => normalizeThreadTitle("   ")).toThrow("between 1 and 80 characters");
    expect(() => normalizeThreadTitle("a".repeat(THREAD_TITLE_MAX_LENGTH + 1))).toThrow(
      "between 1 and 80 characters",
    );
    expect(() => normalizeThreadTitle("side\nA")).toThrow("control characters");
    expect(() => normalizeThreadTitle("side\u0000A")).toThrow("control characters");
  });
});

describe("Thread capabilities", () => {
  it("creates distinct 128-bit bearer capabilities and only exposes a digest for persistence", async () => {
    const capabilities = await createThreadCapabilities();

    expect(capabilities.publicCapability).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(capabilities.managementCapability).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(capabilities.publicCapability).not.toBe(capabilities.managementCapability);
    expect(capabilities.managementDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(capabilities.managementDigest).not.toContain(capabilities.managementCapability);
  });
});

describe("Contribution identifiers", () => {
  it("normalizes bounded request keys", () => {
    expect(normalizeRequestKey(" request-123 ")).toBe("request-123");
    expect(() => normalizeRequestKey(" ")).toThrow("between 1 and 128 characters");
    expect(() => normalizeRequestKey("a".repeat(129))).toThrow("between 1 and 128 characters");
    expect(() => normalizeRequestKey("request\n123")).toThrow("control characters");
  });

  it("fingerprints the accepted input identity deterministically", async () => {
    const input = {
      linkSlug: "abc2345",
      sourceProvider: "spotify" as const,
      sourceCatalogId: "4uLU6hMCjMI75M1A2tKUQC",
      sourceStorefront: "us",
    };

    await expect(fingerprintContributionInput(input)).resolves.toBe(
      await fingerprintContributionInput({ ...input }),
    );
    await expect(
      fingerprintContributionInput({ ...input, sourceCatalogId: "different" }),
    ).resolves.not.toBe(await fingerprintContributionInput(input));
    const sameSourceDifferentLink = { ...input, linkSlug: "another-link" };
    await expect(fingerprintContributionInput(sameSourceDifferentLink)).resolves.toBe(
      await fingerprintContributionInput(input),
    );
  });
});
