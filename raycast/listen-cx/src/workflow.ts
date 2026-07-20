export type ToastStyle = "animated" | "failure" | "success";

export interface MutableToast {
  style: ToastStyle;
  title: string;
  message?: string;
}

export interface CreateListenLinkDeps {
  readText(): Promise<string | undefined>;
  copy(link: string): Promise<void>;
  close(): Promise<void>;
  createLink(url: string): Promise<string>;
  showToast(
    options: Pick<MutableToast, "style" | "title">,
  ): Promise<MutableToast>;
}

export async function runCreateListenLink({
  readText,
  copy,
  close,
  createLink,
  showToast,
}: CreateListenLinkDeps) {
  const sourceUrl = await readText();
  if (!sourceUrl?.trim()) {
    await showToast({
      style: "failure",
      title: "Copy a Spotify or Apple Music track URL first",
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
