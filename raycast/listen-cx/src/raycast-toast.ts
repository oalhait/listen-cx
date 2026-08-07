import { showToast, Toast } from "@raycast/api";
import { adaptToast } from "./toast-adapter";
import type { MutableToast, ToastStyle } from "./workflow";

export function raycastToastStyle(style: ToastStyle): Toast.Style {
  return {
    animated: Toast.Style.Animated,
    failure: Toast.Style.Failure,
    success: Toast.Style.Success,
  }[style];
}

export async function showWorkflowToast(options: {
  style: ToastStyle;
  title: string;
}): Promise<MutableToast> {
  const toast = await showToast({
    style: raycastToastStyle(options.style),
    title: options.title,
  });
  return adaptToast(toast, options.style, raycastToastStyle);
}
