const MAX_CREATE_BODY_BYTES = 4096;

type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

export async function readBoundedJson(request: Request, maxBytes = MAX_CREATE_BODY_BYTES): Promise<BoundedJsonResult> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    return { ok: false, status: 413, error: "Request body is too large." };
  }

  try {
    const reader = request.body?.getReader();
    if (!reader) return { ok: false, status: 400, error: "Send a JSON request body." };

    const chunks: Uint8Array[] = [];
    let bodySize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bodySize += value.byteLength;
      if (bodySize > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        return { ok: false, status: 413, error: "Request body is too large." };
      }
      chunks.push(value);
    }

    const rawBody = new Uint8Array(bodySize);
    let offset = 0;
    for (const chunk of chunks) {
      rawBody.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(rawBody)) };
  } catch {
    return { ok: false, status: 400, error: "Send a valid JSON request body." };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
