import { Hono, type Context } from "hono";
import { readBoundedJson, isRecord } from "./request.js";
import type { Resolver } from "./resolve.js";
import type { D1ThreadStore } from "./thread-db.js";
import { parseTrackUrl, type Provider } from "./urls.js";
import { ThreadError, mutationFingerprint, verifiedSource, type ManagementIntent, type MutationRequest } from "./thread.js";
import { authorizeManagementCapability, isSameOriginAction, managementCookie, setManagementCookie, THREAD_SECURITY_HEADERS } from "./thread-security.js";
import { threadCreationPage, threadPage } from "./thread-page.js";

async function bodyFields(c: Context, fields: string[]): Promise<Record<string, unknown>> {
  const result = await readBoundedJson(c.req.raw);
  if (!result.ok) throw new ThreadError(result.status, "invalid_body", result.error);
  if (!isRecord(result.value) || Object.keys(result.value).some(key => !fields.includes(key))) {
    throw new ThreadError(400, "invalid_input", "Send only the fields supported by this action.");
  }
  return result.value;
}

function requestFields(body: Record<string, unknown>): MutationRequest {
  if (typeof body.requestKey !== "string" || typeof body.expectedRevision !== "number") {
    throw new ThreadError(400, "invalid_input", "Send a request key and the current Thread revision.");
  }
  return { requestKey: body.requestKey, expectedRevision: body.expectedRevision };
}

export interface ThreadPublishing {
  availableProviders: Provider[];
  onChange: (capability: string) => void;
}

export function createThreadApp({ resolver, store, baseUrl, publishing }: { resolver: Pick<Resolver, "resolve">; store: D1ThreadStore; baseUrl: string; publishing?: ThreadPublishing }) {
  const app = new Hono();
  for (const path of ["/threads/new", "/t/*", "/api/threads", "/api/threads/*"]) {
    app.use(path, async (c, next) => {
      for (const [name, value] of Object.entries(THREAD_SECURITY_HEADERS)) c.header(name, value);
      if (c.req.method === "POST" && !isSameOriginAction(c.req.raw, baseUrl)) {
        return c.json({ error: "Use this site's Thread controls to make changes.", code: "forbidden_origin" }, 403);
      }
      await next();
    });
  }
  app.onError((error, c) => error instanceof ThreadError
    ? c.json({ error: error.message, code: error.code }, error.status)
    : c.json({ error: "Could not save the Thread. Try again.", code: "internal_error" }, 500));

  const view = async (capability: string) => {
    const current = await store.get(capability);
    if (!current) throw new ThreadError(404, "not_found", "Thread not found.");
    return current;
  };
  const authorization = async (c: Context, capability: string) => {
    const secret = managementCookie(c, capability);
    return secret ? authorizeManagementCapability(store, capability, secret) : null;
  };

  app.get("/threads/new", c => c.html(threadCreationPage()));
  app.post("/api/threads", async c => {
    const body = await bodyFields(c, ["title", "creationKey"]);
    if (typeof body.title !== "string" || typeof body.creationKey !== "string") throw new ThreadError(400, "invalid_input", "Send a title and creation key.");
    const thread = await store.create(body.title, body.creationKey);
    setManagementCookie(c, thread.publicCapability, body.creationKey);
    const publicUrl = `${baseUrl.replace(/\/$/, "")}/t/${thread.publicCapability}`;
    return c.json({ thread, publicUrl, managementUrl: `${publicUrl}#manage=${body.creationKey}` }, 201);
  });
  app.get("/api/threads/:capability", async c => c.json(await view(c.req.param("capability"))));
  app.get("/t/:capability", async c => {
    const capability = c.req.param("capability");
    const thread = await store.get(capability);
    if (!thread) return c.html(threadPage(null, false), 404);
    return c.html(threadPage(thread, Boolean(await authorization(c, capability)), publishing?.availableProviders));
  });
  app.post("/api/threads/:capability/contributions", async c => {
    const capability = c.req.param("capability");
    const body = await bodyFields(c, ["url", "requestKey", "expectedRevision"]);
    const request = requestFields(body);
    const parsed = typeof body.url === "string" ? parseTrackUrl(body.url) : null;
    if (!parsed || typeof body.url !== "string") throw new ThreadError(400, "invalid_track", "Send a direct Spotify or Apple Music track link.");
    const fingerprint = await mutationFingerprint({ kind: "add", source: parsed });
    const replay = await store.preflight(capability, request.requestKey, fingerprint, request.expectedRevision);
    if (replay) {
      publishing?.onChange(capability);
      return c.json({ receipt: replay, thread: await view(capability) });
    }
    let track;
    try { track = await resolver.resolve(body.url); }
    catch { throw new ThreadError(502, "provider_unavailable", "The music app is unavailable. Try again."); }
    if (!track) throw new ThreadError(404, "track_not_found", "Track not found. Try another track link.");
    const source = verifiedSource(body.url, track);
    const receipt = await store.add(capability, { ...request, source, track });
    publishing?.onChange(capability);
    return c.json({ receipt, thread: await view(capability) });
  });
  app.post("/t/:capability/manage/activate", async c => {
    const capability = c.req.param("capability");
    const body = await bodyFields(c, ["managementCapability"]);
    const secret = body.managementCapability;
    if (typeof secret !== "string" || !await authorizeManagementCapability(store, capability, secret)) {
      throw new ThreadError(403, "forbidden", "This management link is invalid.");
    }
    setManagementCookie(c, capability, secret);
    return c.json({ managed: true });
  });
  app.post("/t/:capability/manage/mutate", async c => {
    const capability = c.req.param("capability");
    const authorized = await authorization(c, capability);
    if (!authorized) throw new ThreadError(403, "forbidden", "Open the private management link to edit this Thread.");
    const body = await bodyFields(c, ["kind", "id", "ids", "provider", "requestKey", "expectedRevision"]);
    const request = requestFields(body);
    let intent: ManagementIntent;
    if (body.kind === "connect" && (body.provider === "spotify" || body.provider === "apple") && body.id === undefined && body.ids === undefined) {
      intent = { kind: "connect", provider: body.provider };
      const replay = await store.preflight(capability, request.requestKey, await mutationFingerprint(intent), request.expectedRevision);
      if (replay) {
        publishing?.onChange(capability);
        return c.json({ receipt: replay, thread: await view(capability) });
      }
      if (!publishing?.availableProviders.includes(body.provider)) throw new ThreadError(503, "publisher_unavailable", "This music app is not available for publishing yet.");
    }
    else if (body.provider !== undefined) throw new ThreadError(400, "invalid_action", "Choose a supported Thread action.");
    else if (body.kind === "close" && body.id === undefined && body.ids === undefined) intent = { kind: "close" };
    else if (body.kind === "remove" && Number.isSafeInteger(body.id) && Number(body.id) > 0 && body.ids === undefined) intent = { kind: "remove", id: Number(body.id) };
    else if (body.kind === "reorder" && Array.isArray(body.ids) && body.ids.length <= 50 && body.ids.every(id => Number.isSafeInteger(id) && id > 0) && body.id === undefined) intent = { kind: "reorder", ids: body.ids };
    else throw new ThreadError(400, "invalid_action", "Choose remove, reorder, or close with valid song IDs.");
    const receipt = await store.manage(authorized, { ...request, ...intent });
    publishing?.onChange(capability);
    return c.json({ receipt, thread: await view(capability) });
  });
  return app;
}
