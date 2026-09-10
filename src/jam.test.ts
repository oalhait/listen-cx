import { describe, expect, it, vi } from "vitest";
import {
  JAM_TITLE_MAX_LENGTH,
  authorizeJamManagementCapability,
  createJamCapabilities,
  fingerprintJamContributionInput,
  isJamCapability,
  normalizeJamRequestKey,
  normalizeJamTitle,
} from "./jam.js";

describe("Jam input normalization", () => {
  it("trims bounded Unicode text and rejects empty, overlong, and control-character input", () => {
    expect(normalizeJamTitle("  café 🎶  ")).toBe("café 🎶");
    expect(normalizeJamTitle("🎵".repeat(JAM_TITLE_MAX_LENGTH))).toHaveLength(
      JAM_TITLE_MAX_LENGTH * 2,
    );
    expect(() => normalizeJamTitle("   ")).toThrow("between 1 and 80 characters");
    expect(() => normalizeJamTitle("a".repeat(JAM_TITLE_MAX_LENGTH + 1))).toThrow(
      "between 1 and 80 characters",
    );
    expect(() => normalizeJamTitle("side\nA")).toThrow("control characters");

    expect(normalizeJamRequestKey(" request-123 ")).toBe("request-123");
    expect(() => normalizeJamRequestKey(" ")).toThrow("between 1 and 128 characters");
    expect(() => normalizeJamRequestKey("request\u0000123")).toThrow("control characters");
  });
});

describe("Jam capabilities", () => {
  it("creates distinct bearer capabilities, persists only a digest, and authorizes securely", async () => {
    const capabilities = await createJamCapabilities();
    const reader = {
      getManagementDigest: vi.fn(async () => capabilities.managementDigest),
    };

    expect(isJamCapability(capabilities.publicCapability)).toBe(true);
    expect(isJamCapability(capabilities.managementCapability)).toBe(true);
    expect(capabilities.publicCapability).not.toBe(capabilities.managementCapability);
    expect(capabilities.managementDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(capabilities.managementDigest).not.toContain(capabilities.managementCapability);
    await expect(
      authorizeJamManagementCapability(
        reader,
        capabilities.publicCapability,
        capabilities.managementCapability,
      ),
    ).resolves.toMatchObject({ publicCapability: capabilities.publicCapability });
    await expect(
      authorizeJamManagementCapability(reader, capabilities.publicCapability, "X".repeat(22)),
    ).resolves.toBeNull();

    reader.getManagementDigest.mockClear();
    await expect(
      authorizeJamManagementCapability(reader, "not-a-capability", "X".repeat(22)),
    ).resolves.toBeNull();
    expect(reader.getManagementDigest).not.toHaveBeenCalled();
  });
});

describe("Jam contribution fingerprints", () => {
  it("is deterministic for the source identity and deliberately excludes the generated link slug", async () => {
    const identity = {
      sourceProvider: "spotify" as const,
      sourceCatalogId: "4uLU6hMCjMI75M1A2tKUQC",
      sourceStorefront: "us",
    };

    await expect(fingerprintJamContributionInput(identity)).resolves.toBe(
      await fingerprintJamContributionInput({ ...identity }),
    );
    await expect(
      fingerprintJamContributionInput({ ...identity, sourceCatalogId: "different" }),
    ).resolves.not.toBe(await fingerprintJamContributionInput(identity));
    const sameSourceDifferentLink = { linkSlug: "another", ...identity };
    await expect(fingerprintJamContributionInput(sameSourceDifferentLink)).resolves.toBe(
      await fingerprintJamContributionInput(identity),
    );
  });
});
