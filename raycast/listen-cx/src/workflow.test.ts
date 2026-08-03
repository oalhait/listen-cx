import { describe, expect, it, vi } from "vitest";
import { runCreateListenLink } from "./workflow";

function makeDeps(
  overrides: Partial<Parameters<typeof runCreateListenLink>[1]> = {},
) {
  const toast = { style: "animated", title: "" };
  return {
    copy: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createLink: vi.fn().mockResolvedValue("https://listen.cx/Abc2345"),
    showToast: vi.fn().mockResolvedValue(toast),
    toast,
    ...overrides,
  };
}

describe("runCreateListenLink", () => {
  it("asks for a URL when the submitted value is empty", async () => {
    const deps = makeDeps();

    await runCreateListenLink("", deps);

    expect(deps.showToast).toHaveBeenCalledWith({
      style: "failure",
      title: "Paste a Spotify or Apple Music track URL",
    });
    expect(deps.createLink).not.toHaveBeenCalled();
  });

  it("creates, copies, and closes after a successful conversion", async () => {
    const deps = makeDeps();

    await runCreateListenLink(" https://open.spotify.com/track/abc ", deps);

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

    await runCreateListenLink("https://open.spotify.com/track/abc", deps);

    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();
    expect(deps.toast).toMatchObject({
      style: "failure",
      title: "Couldn't create listen.cx link",
      message: "Service unavailable",
    });
  });
});
