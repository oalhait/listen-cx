import type { AddToThreadResult } from "./thread";
import type { MutableToast } from "./workflow";

export interface AddToThreadDeps {
  add(
    threadUrl: string,
    songUrl: string,
    requestKey: string,
  ): Promise<AddToThreadResult>;
  close(): Promise<void>;
  normalizeThread(threadUrl: string): string;
  rememberThread(threadUrl: string): Promise<void>;
  requestKey(threadUrl: string, songUrl: string): Promise<string>;
  showToast(
    options: Pick<MutableToast, "style" | "title">,
  ): Promise<MutableToast>;
}

export async function runAddToThread(
  input: { threadUrl: string; songUrl: string },
  {
    add,
    close,
    normalizeThread,
    rememberThread,
    requestKey,
    showToast,
  }: AddToThreadDeps,
) {
  if (!input.threadUrl.trim()) {
    await showToast({
      style: "failure",
      title: "Enter a listen.cx Thread URL",
    });
    return;
  }
  if (!input.songUrl.trim()) {
    await showToast({
      style: "failure",
      title: "Copy a Spotify or Apple Music track URL first",
    });
    return;
  }

  const toast = await showToast({
    style: "animated",
    title: "Adding song to Thread…",
  });
  try {
    const threadUrl = normalizeThread(input.threadUrl.trim());
    const songUrl = input.songUrl.trim();
    const result = await add(
      threadUrl,
      songUrl,
      await requestKey(threadUrl, songUrl),
    );
    await rememberThread(threadUrl);
    toast.style = "success";
    toast.title =
      result === "accepted"
        ? "Song added to Thread"
        : "Song is already in Thread";
    await close();
  } catch (error) {
    toast.style = "failure";
    toast.title = "Couldn't add song to Thread";
    toast.message =
      error instanceof Error ? error.message : "Try again in a moment.";
  }
}
