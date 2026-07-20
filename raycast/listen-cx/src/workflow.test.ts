import { describe, expect, it, vi } from "vitest";
import { runCreateListenLink } from "./workflow";

function makeDeps(
  overrides: Partial<Parameters<typeof runCreateListenLink>[0]> = {},
) {
  const toast = { style: "animated", title: "" };
  return {
    readText: vi.fn().mockResolvedValue("https://open.spotify.com/track/abc"),
    copy: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createLink: vi.fn().mockResolvedValue("https://listen.cx/Abc2345"),
    showToast: vi.fn().mockResolvedValue(toast),
    toast,
    ...overrides,
  };
}

describe("runCreateListenLink", () => {
  it("asks for a copied URL when the clipboard is empty", async () => {
    const deps = makeDeps({ readText: vi.fn().mockResolvedValue(undefined) });

    await runCreateListenLink(deps);

    expect(deps.showToast).toHaveBeenCalledWith({
      style: "failure",
      title: "Copy a Spotify or Apple Music track URL first",
    });
    expect(deps.createLink).not.toHaveBeenCalled();
  });

  it("creates, copies, and closes after a successful conversion", async () => {
    const deps = makeDeps();

    await runCreateListenLink(deps);

    expect(deps.createLink).toHaveBeenCalledWith(
      "https://open.spotify.com/track/abc",
    );
    expect(deps.copy).toHaveBeenCalledWith("https://listen.cx/Abc2345");
    expect(deps.toast).toMatchObject({
      style: "success",
      title: "listen.cx link copied",
    });
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("shows the request error without replacing the clipboard", async () => {
    const deps = makeDeps({
      createLink: vi.fn().mockRejectedValue(new Error("Service unavailable")),
    });

    await runCreateListenLink(deps);

    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();
    expect(deps.toast).toMatchObject({
      style: "failure",
      title: "Couldn't create listen.cx link",
      message: "Service unavailable",
    });
  });
});
