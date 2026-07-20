const CREATE_ENDPOINT = "https://listen.cx/create";

type Fetcher = typeof fetch;
const REQUEST_TIMEOUT_MS = 15_000;

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

export async function createListenLink(
  url: string,
  fetcher: Fetcher = fetch,
  signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(CREATE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal,
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("listen.cx took too long to respond. Try again.");
    }
    throw error;
  }
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      errorMessage(body) ??
        `listen.cx could not create a link (${response.status}).`,
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("link" in body) ||
    typeof body.link !== "string" ||
    !body.link
  ) {
    throw new Error("listen.cx returned an invalid response.");
  }
  return body.link;
}
