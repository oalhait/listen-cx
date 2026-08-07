import { Clipboard } from "@raycast/api";
import { createListenLink } from "./api";
import { clipboardSongUrl } from "./clipboard";
import { showWorkflowToast } from "./raycast-toast";
import { runCreateListenLink } from "./workflow";

export default async function command() {
  const clipboardText = await Clipboard.readText().catch(() => undefined);
  await runCreateListenLink(clipboardSongUrl(clipboardText), {
    copy: Clipboard.copy,
    createLink: createListenLink,
    showToast: showWorkflowToast,
  });
}
