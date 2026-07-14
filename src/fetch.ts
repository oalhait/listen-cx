type Fetcher = typeof fetch;

const RETRY_DELAYS_MS = [75, 200];

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetcher(input, init);
      if (!isRetryable(response.status) || attempt === RETRY_DELAYS_MS.length) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === RETRY_DELAYS_MS.length) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}
