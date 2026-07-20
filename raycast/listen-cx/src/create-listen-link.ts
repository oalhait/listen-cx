import { Clipboard, closeMainWindow, showToast, Toast } from "@raycast/api";
import { createListenLink } from "./api";
import { runCreateListenLink, type ToastStyle } from "./workflow";

function raycastToastStyle(style: ToastStyle) {
  return {
    animated: Toast.Style.Animated,
    failure: Toast.Style.Failure,
    success: Toast.Style.Success,
  }[style];
}

export default async function command() {
  await runCreateListenLink({
    readText: Clipboard.readText,
    copy: Clipboard.copy,
    close: closeMainWindow,
    createLink: createListenLink,
    showToast: async ({ style, title }) => {
      const toast = await showToast({
        style: raycastToastStyle(style),
        title,
      });
      return toast as typeof toast & {
        style: "animated" | "failure" | "success";
      };
    },
  });
}
