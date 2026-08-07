const THREAD_CAPABILITY = /^[A-Za-z0-9_-]{22}$/;
const TRUSTED_HOSTS = new Set(["listen.cx", "staging.listen.cx"]);
const REQUEST_TIMEOUT_MS = 15_000;

type Fetcher = typeof fetch;

export interface ParsedThreadUrl {
  publicUrl: string;
  contributionEndpoint: string;
  origin: string;
}

export type AddToThreadResult = "accepted" | "existing";

export async function threadRequestKey(
  threadUrl: string,
  songUrl: string,
): Promise<string> {
  const parsedThread = parseThreadUrl(threadUrl);
  if (!parsedThread) {
    throw new Error("Enter a valid listen.cx Thread URL.");
  }
  const identity = songIdentity(songUrl);
  if (!identity) {
    throw new Error("Enter a valid Spotify or Apple Music track URL.");
  }
  const hex = createHash("sha256")
    .update(`${parsedThread.publicUrl}\0${identity}`)
    .digest("hex");
  return `raycast-${hex}`;
}

function errorMessage(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return null;
}

export function parseThreadUrl(value: string): ParsedThreadUrl | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  const isTrustedProductionUrl =
    url.protocol === "https:" && TRUSTED_HOSTS.has(url.hostname.toLowerCase());
  const isLocalUrl =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    (!isTrustedProductionUrl && !isLocalUrl) ||
    parts.length !== 2 ||
    parts[0] !== "t" ||
    !THREAD_CAPABILITY.test(parts[1] ?? "")
  ) {
    return null;
  }

  const capability = parts[1] as string;
  const publicUrl = `${url.origin}/t/${capability}`;
  return {
    publicUrl,
    contributionEndpoint: `${url.origin}/api/threads/${capability}/contributions`,
    origin: url.origin,
  };
}

export async function addSongToThread(
  threadUrl: string,
  songUrl: string,
  requestKey: string,
  fetcher: Fetcher = fetch,
  signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
): Promise<AddToThreadResult> {
  const parsed = parseThreadUrl(threadUrl);
  if (!parsed) {
    throw new Error("Enter a valid listen.cx Thread URL.");
  }

  let response: Response;
  try {
    response = await fetcher(parsed.contributionEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: parsed.origin,
        "x-listen-action": "add-song",
      },
      body: JSON.stringify({ url: songUrl.trim(), requestKey }),
      signal,
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("The Thread took too long to respond. Try again.");
    }
    throw error;
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      errorMessage(body) ??
        `The Thread could not add this song (${response.status}).`,
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("status" in body) ||
    (body.status !== "accepted" && body.status !== "existing")
  ) {
    throw new Error("The Thread returned an invalid response.");
  }
  return body.status;
}
import { createHash } from "node:crypto";
import { songIdentity } from "./clipboard";
