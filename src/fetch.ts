type Fetcher = typeof fetch;

const RETRY_DELAYS_MS = [75, 200];
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init?: RequestInit,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1) {
    throw new Error("attemptTimeoutMs must be a positive integer");
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(attemptTimeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const response = await fetcher(input, { ...init, signal });
      if (!isRetryable(response.status) || attempt === RETRY_DELAYS_MS.length) return response;
      await response.body?.cancel();
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      if (attempt === RETRY_DELAYS_MS.length) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}
