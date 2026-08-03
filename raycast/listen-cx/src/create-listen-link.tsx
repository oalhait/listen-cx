import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Form,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { createListenLink } from "./api";
import { clipboardSongUrl } from "./clipboard";
import { runCreateListenLink, type ToastStyle } from "./workflow";

function raycastToastStyle(style: ToastStyle) {
  return {
    animated: Toast.Style.Animated,
    failure: Toast.Style.Failure,
    success: Toast.Style.Success,
  }[style];
}

export default function command() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    Clipboard.readText()
      .then((clipboardText) => setUrl(clipboardSongUrl(clipboardText)))
      .catch(() => undefined)
      .finally(() => setIsLoading(false));
  }, []);

  async function submit(values: { url: string }) {
    if (submitting.current) {
      return;
    }

    submitting.current = true;
    setIsSubmitting(true);
    try {
      await runCreateListenLink(values.url, {
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
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <Form
      isLoading={isLoading || isSubmitting}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create & Copy Link" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="url"
        title="Song URL"
        placeholder="Spotify or Apple Music track URL"
        value={url}
        onChange={setUrl}
        autoFocus
      />
      <Form.Description text="Your listen.cx link will be copied automatically." />
    </Form>
  );
}
