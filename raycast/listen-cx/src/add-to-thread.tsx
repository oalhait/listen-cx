import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Form,
  LocalStorage,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { loadAddToThreadDefaults } from "./add-to-thread-defaults";
import { showWorkflowToast } from "./raycast-toast";
import { addSongToThread, parseThreadUrl, threadRequestKey } from "./thread";
import { runAddToThread } from "./thread-workflow";

const LAST_THREAD_KEY = "last-thread-url";

export default function command() {
  const [threadUrl, setThreadUrl] = useState("");
  const [songUrl, setSongUrl] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    loadAddToThreadDefaults(
      () => Clipboard.readText(),
      () => LocalStorage.getItem(LAST_THREAD_KEY),
    )
      .then((defaults) => {
        setThreadUrl(defaults.threadUrl);
        setSongUrl(defaults.songUrl);
      })
      .finally(() => setIsLoading(false));
  }, []);

  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setIsSubmitting(true);
    try {
      await runAddToThread(
        { threadUrl, songUrl },
        {
          add: addSongToThread,
          close: closeMainWindow,
          normalizeThread: (value) => {
            const parsed = parseThreadUrl(value);
            if (!parsed) throw new Error("Enter a valid listen.cx Thread URL.");
            return parsed.publicUrl;
          },
          rememberThread: async (value) =>
            LocalStorage.setItem(LAST_THREAD_KEY, value),
          requestKey: threadRequestKey,
          showToast: showWorkflowToast,
        },
      );
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
          <Action.SubmitForm title="Add Song to Thread" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="threadUrl"
        title="Thread"
        placeholder="https://staging.listen.cx/t/…"
        value={threadUrl}
        onChange={setThreadUrl}
      />
      <Form.TextField
        id="songUrl"
        title="Song"
        placeholder="Spotify or Apple Music track URL"
        value={songUrl}
        onChange={setSongUrl}
      />
      <Form.Description text="The last Thread is remembered. Copy a song link, run this command, and press ⌘↵." />
    </Form>
  );
}
