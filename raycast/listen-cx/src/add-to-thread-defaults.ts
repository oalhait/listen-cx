import { clipboardSongUrl } from "./clipboard";
import { parseThreadUrl } from "./thread";

export async function loadAddToThreadDefaults(
  readClipboard: () => Promise<string | undefined>,
  readRememberedThread: () => Promise<unknown>,
) {
  const [clipboardText, rememberedThread] = await Promise.all([
    readClipboard().catch(() => undefined),
    readRememberedThread().catch(() => undefined),
  ]);
  const clipboardThread = parseThreadUrl(clipboardText ?? "")?.publicUrl ?? "";
  return {
    threadUrl:
      clipboardThread ||
      (typeof rememberedThread === "string" ? rememberedThread : ""),
    songUrl: clipboardSongUrl(clipboardText),
  };
}
