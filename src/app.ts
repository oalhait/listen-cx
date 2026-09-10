import { Hono } from "hono";
import type { Resolver } from "./resolve.js";
import type { LinkStore } from "./db.js";
import { prefersHtml, renderRecipient } from "./recipient.js";
import type { JamStore } from "./jam-db.js";
import { createLink, LinkActionError, LINK_SLUG_PATTERN } from "./links.js";
import { handleMcpRequest } from "./mcp.js";
import type { AppleMusicDeveloperToken } from "./apple-music-auth.js";
import { getJam, JamActionError } from "./jams.js";

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

export function createApp({ resolver, store, jamStore, jamsEnabled, baseUrl, appleMusic }: {
  resolver: Pick<Resolver, "resolve">;
  store: LinkStore;
  jamStore: JamStore;
  jamsEnabled: boolean;
  baseUrl: string;
  appleMusic?: {
    allowedOrigins: readonly string[];
    issueDeveloperToken(): Promise<AppleMusicDeveloperToken>;
  };
}) {
  const app = new Hono();

  app.onError(() => new Response(JSON.stringify({ error: "Internal server error." }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  }));
  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.get("/healthz", async (c) => {
    try {
      const [linksReady, jamsReady] = await Promise.all([
        store.isReady(),
        jamsEnabled ? jamStore.isReady() : Promise.resolve(true),
      ]);
      if (linksReady && jamsReady) return c.json({ status: "ok" });
    } catch {}
    return c.json({ status: "unavailable" }, 503);
  });

  app.get("/api/apple-music/developer-token", async (c) => {
    if (!appleMusic) return c.json({ error: "Apple Music is not configured." }, 404);
    const requestOrigin = new URL(c.req.url).origin;
    const origin = c.req.header("origin");
    if (
      (origin && origin !== requestOrigin)
      || !appleMusic.allowedOrigins.includes(requestOrigin)
    ) {
      return c.json({ error: "Apple Music authorization denied." }, 403);
    }

    try {
      const token = await appleMusic.issueDeveloperToken();
      c.header("Cache-Control", "private, no-store");
      return c.json({
        developerToken: token.developerToken,
        expiresAt: token.expiresAt,
        mediaId: token.mediaId,
      });
    } catch {
      return c.json({ error: "Apple Music is unavailable." }, 503);
    }
  });

  app.post("/create", async (c) => {
    const body = await readBoundedJson(c.req.raw);
    if (!body.ok) return c.json({ error: body.error }, body.status);
    if (!isRecord(body.value) || typeof body.value.url !== "string") {
      return c.json({ error: "Send a Spotify or Apple Music track URL." }, 400);
    }

    try {
      return c.json(await createLink({ resolver, store, baseUrl }, body.value.url));
    } catch (error) {
      if (error instanceof LinkActionError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.all("/mcp", (c) => handleMcpRequest(c.req.raw, {
    resolver,
    store,
    jamStore,
    jamsEnabled,
    baseUrl,
  }));

  app.get("/api/jams/:jamId", async (c) => {
    if (!jamsEnabled) return c.json({ error: "Not found." }, 404);
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    try {
      return c.json(await getJam({ resolver, store, jamStore, jamsEnabled, baseUrl }, c.req.param("jamId")));
    } catch (error) {
      if (error instanceof JamActionError || error instanceof LinkActionError) {
        return c.json({ code: error.code, error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.get("/:slug", async (c) => {
    c.header("Vary", "Accept");
    const html = prefersHtml(c.req.header("Accept") ?? null);
    const slug = c.req.param("slug");
    if (!LINK_SLUG_PATTERN.test(slug)) {
      return html ? c.html(renderRecipient(null), 404) : c.json({ error: "Not found." }, 404);
    }
    const row = await store.get(slug);
    if (!row) return html ? c.html(renderRecipient(null), 404) : c.json({ error: "Not found." }, 404);
    return html ? c.html(renderRecipient(row)) : c.json(row);
  });

  return app;
}
