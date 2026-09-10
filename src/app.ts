import { Hono } from "hono";
import type { Resolver } from "./resolve.js";
import type { LinkStore } from "./db.js";
import { prefersHtml, renderRecipient } from "./recipient.js";
import { parseTrackUrl } from "./urls.js";

const MAX_CREATE_BODY_BYTES = 4096;

type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

async function readBoundedJson(request: Request): Promise<BoundedJsonResult> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_CREATE_BODY_BYTES) {
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
      if (bodySize > MAX_CREATE_BODY_BYTES) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createApp({ resolver, store, baseUrl }: {
  resolver: Pick<Resolver, "resolve">;
  store: LinkStore;
  baseUrl: string;
}) {
  const app = new Hono();

  app.onError(() => new Response(JSON.stringify({ error: "Internal server error." }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  }));
  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.get("/healthz", async (c) => {
    try {
      if (await store.isReady()) return c.json({ status: "ok" });
    } catch {}
    return c.json({ status: "unavailable" }, 503);
  });

  app.post("/create", async (c) => {
    const body = await readBoundedJson(c.req.raw);
    if (!body.ok) return c.json({ error: body.error }, body.status);
    if (!isRecord(body.value) || typeof body.value.url !== "string" || !parseTrackUrl(body.value.url)) {
      return c.json({ error: "Send a Spotify or Apple Music track URL." }, 400);
    }
    let resolved;
    try {
      resolved = await resolver.resolve(body.value.url);
    } catch {
      return c.json({ error: "Provider unavailable. Try again." }, 502);
    }
    if (!resolved) return c.json({ error: "Track not found." }, 404);
    const row = await store.upsert(resolved);
    return c.json({
      link: `${baseUrl.replace(/\/$/, "")}/${row.slug}`,
      slug: row.slug,
      title: row.title,
      artist: row.artist,
      artworkUrl: row.artwork_url,
    });
  });

  app.get("/:slug", async (c) => {
    c.header("Vary", "Accept");
    const html = prefersHtml(c.req.header("Accept") ?? null);
    const slug = c.req.param("slug");
    if (!/^[23456789abcdefghjkmnpqrstuvwxyz]{7}$/.test(slug)) {
      return html ? c.html(renderRecipient(null), 404) : c.json({ error: "Not found." }, 404);
    }
    const row = await store.get(slug);
    if (!row) return html ? c.html(renderRecipient(null), 404) : c.json({ error: "Not found." }, 404);
    return html ? c.html(renderRecipient(row)) : c.json(row);
  });

  return app;
}
