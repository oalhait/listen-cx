export type ToastStyle = "animated" | "failure" | "success";

export interface MutableToast {
  style: ToastStyle;
  title: string;
  message?: string;
}

export interface CreateListenLinkDeps {
  copy(link: string): Promise<void>;
  close(): Promise<void>;
  createLink(url: string): Promise<string>;
  showToast(
    options: Pick<MutableToast, "style" | "title">,
  ): Promise<MutableToast>;
}

export async function runCreateListenLink(
  sourceUrl: string,
  { copy, close, createLink, showToast }: CreateListenLinkDeps,
) {
  if (!sourceUrl?.trim()) {
    await showToast({
      style: "failure",
      title: "Paste a Spotify or Apple Music track URL",
    });
    return;
  }

  const toast = await showToast({
    style: "animated",
    title: "Creating listen.cx link…",
  });
  try {
    const link = await createLink(sourceUrl.trim());
    await copy(link);
    toast.style = "success";
    toast.title = "listen.cx link copied";
    await close();
  } catch (error) {
    toast.style = "failure";
    toast.title = "Couldn't create listen.cx link";
    toast.message =
      error instanceof Error ? error.message : "Try again in a moment.";
  }
}
