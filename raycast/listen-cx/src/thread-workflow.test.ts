import { describe, expect, it, vi } from "vitest";
import { runAddToThread } from "./thread-workflow";

function makeDeps(
  overrides: Partial<Parameters<typeof runAddToThread>[1]> = {},
) {
  const toast = { style: "animated", title: "" };
  return {
    add: vi.fn().mockResolvedValue("accepted"),
    close: vi.fn().mockResolvedValue(undefined),
    normalizeThread: vi.fn().mockReturnValue("thread"),
    rememberThread: vi.fn().mockResolvedValue(undefined),
    requestKey: vi.fn().mockResolvedValue("request"),
    showToast: vi.fn().mockResolvedValue(toast),
    toast,
    ...overrides,
  };
}

describe("runAddToThread", () => {
  it("requires both a Thread and song URL", async () => {
    const missingThread = makeDeps();
    await runAddToThread({ threadUrl: "", songUrl: "song" }, missingThread);
    expect(missingThread.add).not.toHaveBeenCalled();
    expect(missingThread.toast.title).toBe("");
    expect(missingThread.showToast).toHaveBeenCalledWith({
      style: "failure",
      title: "Enter a listen.cx Thread URL",
    });

    const missingSong = makeDeps();
    await runAddToThread({ threadUrl: "thread", songUrl: "" }, missingSong);
    expect(missingSong.add).not.toHaveBeenCalled();
    expect(missingSong.showToast).toHaveBeenCalledWith({
      style: "failure",
      title: "Copy a Spotify or Apple Music track URL first",
    });
  });

  it("adds the song, remembers the Thread, and closes", async () => {
    const deps = makeDeps({
      normalizeThread: vi.fn().mockReturnValue("https://listen.cx/t/public"),
    });
    await runAddToThread(
      {
        threadUrl: "https://listen.cx/t/public#management-secret",
        songUrl: " song ",
      },
      deps,
    );

    expect(deps.add).toHaveBeenCalledWith(
      "https://listen.cx/t/public",
      "song",
      "request",
    );
    expect(deps.requestKey).toHaveBeenCalledWith(
      "https://listen.cx/t/public",
      "song",
    );
    expect(deps.rememberThread).toHaveBeenCalledWith(
      "https://listen.cx/t/public",
    );
    expect(deps.toast).toMatchObject({
      style: "success",
      title: "Song added to Thread",
    });
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("keeps the form open and reports request failures", async () => {
    const deps = makeDeps({
      add: vi.fn().mockRejectedValue(new Error("Thread not found.")),
    });
    await runAddToThread({ threadUrl: "thread", songUrl: "song" }, deps);

    expect(deps.rememberThread).not.toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();
    expect(deps.toast).toMatchObject({
      style: "failure",
      title: "Couldn't add song to Thread",
      message: "Thread not found.",
    });
  });

  it("reports an existing song as a successful no-op", async () => {
    const deps = makeDeps({ add: vi.fn().mockResolvedValue("existing") });

    await runAddToThread({ threadUrl: "thread", songUrl: "song" }, deps);

    expect(deps.rememberThread).toHaveBeenCalledWith("thread");
    expect(deps.toast).toMatchObject({
      style: "success",
      title: "Song is already in Thread",
    });
    expect(deps.close).toHaveBeenCalledOnce();
  });
});
