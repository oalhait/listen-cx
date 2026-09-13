import { Hono, type Context } from "hono";
import { readBoundedJson, isRecord } from "./request.js";
import type { Resolver } from "./resolve.js";
import type { D1ThreadStore } from "./thread-db.js";
import type { ThreadCollaborationService } from "./thread-collaboration-service.js";
import { parseTrackUrl, type Provider } from "./urls.js";
import { ThreadError, mutationFingerprint, normalizeRequestKey, sha256, verifiedSource, type ManagementIntent, type MutationRequest } from "./thread.js";
import { authorizeManagementCapability, isSameOriginAction, managementCookie, setManagementCookie, THREAD_SECURITY_HEADERS, type ManagementAuthorization } from "./thread-security.js";
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
  accountSubscriptions?: boolean;
  availableProviders: Provider[];
  onChange: (capability: string) => void;
  retry?: (authorization: ManagementAuthorization, provider: Provider) => Promise<void>;
  requireConnection?: (authorization: ManagementAuthorization, provider: Provider) => Promise<void>;
}

export function createThreadApp({ resolver, store, baseUrl, publishing, history, contributor, collaboration }: { contributor?: (c: Context) => Promise<{ id: string } | null>; resolver: Pick<Resolver, "resolve">; store: D1ThreadStore; baseUrl: string; publishing?: ThreadPublishing; history?: { remember(c: Context, capability: string): Promise<void>; prepare?(c: Context): Promise<void> }; collaboration?: ThreadCollaborationService }) {
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
  const collaborationSnapshot = async (c: Context, capability: string) => {
    if (!collaboration) throw new ThreadError(404, "not_found", "Jam collaboration is not available.");
    const snapshot = await collaboration.snapshot(c, capability);
    if (!snapshot) throw new ThreadError(404, "not_found", "Thread not found.");
    return snapshot;
  };
  const collaborationSnapshotFor = async (capability: string, identity: NonNullable<Awaited<ReturnType<ThreadCollaborationService["identity"]>>>) => {
    if (!collaboration) throw new ThreadError(404, "not_found", "Jam collaboration is not available.");
    const snapshot = await collaboration.store.snapshot(capability, identity);
    if (!snapshot) throw new ThreadError(404, "not_found", "Thread not found.");
    return snapshot;
  };
  const collaborationJson = async (c: Context, capability: string) => {
    const snapshot = await collaborationSnapshot(c, capability);
    const etag = `"${await sha256(JSON.stringify(snapshot))}"`;
    c.header("ETag", etag);
    return c.req.header("If-None-Match") === etag ? c.body(null, 304) : c.json(snapshot);
  };

  app.get("/threads/new", async c => {
    await history?.prepare?.(c);
    return c.html(threadCreationPage());
  });
  app.post("/api/threads", async c => {
    const body = await bodyFields(c, ["title", "creationKey"]);
    if (typeof body.title !== "string" || typeof body.creationKey !== "string") throw new ThreadError(400, "invalid_input", "Send a title and creation key.");
    const thread = await store.create(body.title, body.creationKey);
    await history?.remember(c, thread.publicCapability);
    setManagementCookie(c, thread.publicCapability, body.creationKey);
    const publicUrl = `${baseUrl.replace(/\/$/, "")}/t/${thread.publicCapability}`;
    return c.json({ thread, publicUrl, managementUrl: `${publicUrl}#manage=${body.creationKey}` }, 201);
  });
  app.get("/api/threads/:capability", async c => c.json(await view(c.req.param("capability"))));
  app.get("/api/threads/:capability/collaboration", async c => collaborationJson(c, c.req.param("capability")));
  app.get("/t/:capability", async c => {
    const capability = c.req.param("capability");
    const thread = await store.get(capability);
    if (!thread) return c.html(threadPage(null, false, [], false, baseUrl), 404);
    await collaboration?.identity(c, true);
    const managed = Boolean(await authorization(c, capability));
    if (managed) await history?.remember(c, capability);
    return c.html(threadPage(thread, managed, publishing?.availableProviders, publishing?.accountSubscriptions, baseUrl));
  });
  app.post("/api/threads/:capability/collaboration/join", async c => {
    if (!collaboration) throw new ThreadError(404, "not_found", "Jam collaboration is not available.");
    const capability = c.req.param("capability");
    const body = await bodyFields(c, ["displayName"]);
    if (typeof body.displayName !== "string") throw new ThreadError(400, "invalid_display_name", "Choose a display name.");
    const identity = await collaboration.identity(c, true);
    if (!identity) throw new ThreadError(401, "join_required", "Join this Jam first.");
    const result = await collaboration.store.join(capability, identity, body.displayName);
    return c.json({ ...result, collaboration: await collaborationSnapshotFor(capability, identity) });
  });
  app.post("/api/threads/:capability/messages", async c => {
    if (!collaboration) throw new ThreadError(404, "not_found", "Jam collaboration is not available.");
    const capability = c.req.param("capability");
    const body = await bodyFields(c, ["text", "requestKey"]);
    if (typeof body.text !== "string" || typeof body.requestKey !== "string") {
      throw new ThreadError(400, "invalid_input", "Send a message and request key.");
    }
    const identity = await collaboration.identity(c);
    if (!identity) throw new ThreadError(401, "join_required", "Join this Jam before chatting.");
    const result = await collaboration.store.postMessage(capability, identity, {
      text: body.text,
      requestKey: body.requestKey,
    });
    return c.json({ ...result, collaboration: await collaborationSnapshotFor(capability, identity) });
  });
  app.post("/api/threads/:capability/votes", async c => {
    if (!collaboration) throw new ThreadError(404, "not_found", "Jam collaboration is not available.");
    const capability = c.req.param("capability");
    const body = await bodyFields(c, ["contributionId", "vote", "requestKey"]);
    if (!Number.isSafeInteger(body.contributionId) || Number(body.contributionId) < 1
      || !["up", "down", "clear"].includes(String(body.vote)) || typeof body.requestKey !== "string") {
      throw new ThreadError(400, "invalid_vote", "Choose an active song and a supported vote.");
    }
    const identity = await collaboration.identity(c);
    if (!identity) throw new ThreadError(401, "join_required", "Join this Jam before voting.");
    const result = await collaboration.store.setVote(capability, identity, {
      contributionId: Number(body.contributionId),
      vote: body.vote as "up" | "down" | "clear",
      requestKey: body.requestKey,
    });
    return c.json({ ...result, collaboration: await collaborationSnapshotFor(capability, identity) });
  });
  app.post("/t/:capability/manage/messages", async c => {
    if (!collaboration) throw new ThreadError(404, "not_found", "Jam collaboration is not available.");
    const capability = c.req.param("capability");
    const authorized = await authorization(c, capability);
    if (!authorized) throw new ThreadError(403, "forbidden", "Open the private management link to moderate this Jam.");
    const body = await bodyFields(c, ["messageId", "requestKey"]);
    if (!Number.isSafeInteger(body.messageId) || Number(body.messageId) < 1 || typeof body.requestKey !== "string") {
      throw new ThreadError(400, "invalid_input", "Choose a message to remove.");
    }
    normalizeRequestKey(body.requestKey);
    const status = await collaboration.store.moderateMessage(authorized, Number(body.messageId));
    if (status === "not_found") throw new ThreadError(404, "message_not_found", "Message not found.");
    return c.json({ status, collaboration: await collaborationSnapshot(c, capability) });
  });
  app.post("/api/threads/:capability/contributions", async c => {
    const capability = c.req.param("capability");
    const body = await bodyFields(c, ["url", "requestKey", "expectedRevision"]);
    const request = requestFields(body);
    const parsed = typeof body.url === "string" ? parseTrackUrl(body.url) : null;
    if (!parsed || typeof body.url !== "string") throw new ThreadError(400, "invalid_track", "Send a direct Spotify or Apple Music track link.");
    let addedByAccountId = (await contributor?.(c))?.id ?? null;
    let addedByParticipantId: string | null = null;
    if (!addedByAccountId && collaboration) {
      const identity = await collaboration.identity(c);
      if (identity?.kind === "account") {
        addedByAccountId = identity.accountId;
      } else if (identity) {
        addedByParticipantId = (await collaboration.store.participant(capability, identity))?.id ?? null;
      }
    }
    const fingerprint = await mutationFingerprint({
      kind: "add",
      source: parsed,
      addedByAccountId,
      addedByParticipantId,
    });
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
    const receipt = await store.add(capability, {
      ...request,
      source,
      track,
      addedByAccountId,
      addedByParticipantId,
    });
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
  app.post("/t/:capability/manage/retry", async c => {
    const capability = c.req.param("capability");
    const authorized = await authorization(c, capability);
    if (!authorized) throw new ThreadError(403, "forbidden", "Open the private management link to retry sync.");
    const body = await bodyFields(c, ["provider", "requestKey", "expectedRevision"]);
    if ((body.provider !== "spotify" && body.provider !== "apple") || !publishing?.retry || !publishing.availableProviders.includes(body.provider)) {
      throw new ThreadError(503, "publisher_unavailable", "This music app is not available for publishing yet.");
    }
    await publishing.retry(authorized, body.provider);
    publishing.onChange(capability);
    return c.json({ thread: await view(capability) });
  });
  app.post("/t/:capability/manage/identify", async c => {
    const capability = c.req.param("capability");
    const authorized = await authorization(c, capability);
    if (!authorized) throw new ThreadError(403, "forbidden", "Open the private management link to confirm a song match.");
    const body = await bodyFields(c, ["id", "url", "confirmed", "requestKey", "expectedRevision"]);
    const request = requestFields(body);
    const identity = typeof body.url === "string" ? parseTrackUrl(body.url) : null;
    if (!Number.isSafeInteger(body.id) || Number(body.id) < 1 || !identity || typeof body.url !== "string" || body.confirmed !== true) {
      throw new ThreadError(400, "invalid_counterpart", "Choose a direct track link and confirm it is the same recording.");
    }
    const intent = { kind: "identify" as const, id: Number(body.id), identity };
    const replay = await store.preflight(capability, request.requestKey, await mutationFingerprint(intent), request.expectedRevision);
    if (replay) {
      publishing?.onChange(capability);
      return c.json({ receipt: replay, thread: await view(capability) });
    }
    let track;
    try { track = await resolver.resolve(body.url); }
    catch { throw new ThreadError(502, "provider_unavailable", "The music app is unavailable. Try again."); }
    if (!track) throw new ThreadError(404, "track_not_found", "Track not found. Try another track link.");
    verifiedSource(body.url, track);
    const receipt = await store.manage(authorized, { ...request, ...intent });
    publishing?.onChange(capability);
    return c.json({ receipt, thread: await view(capability) });
  });
  app.post("/t/:capability/manage/mutate", async c => {
    const capability = c.req.param("capability");
    const authorized = await authorization(c, capability);
    if (!authorized) throw new ThreadError(403, "forbidden", "Open the private management link to edit this Thread.");
    const body = await bodyFields(c, ["kind", "id", "ids", "provider", "requestKey", "expectedRevision"]);
    const request = requestFields(body);
    let intent: ManagementIntent;
    if (body.kind === "connect" && (body.provider === "spotify" || body.provider === "apple") && body.id === undefined && body.ids === undefined) {
      if (publishing?.accountSubscriptions) throw new ThreadError(410, "account_settings_required", "Connect your account in settings and subscribe to this Thread.");
      intent = { kind: "connect", provider: body.provider };
      const replay = await store.preflight(capability, request.requestKey, await mutationFingerprint(intent), request.expectedRevision);
      if (replay) {
        publishing?.onChange(capability);
        return c.json({ receipt: replay, thread: await view(capability) });
      }
      if (!publishing?.availableProviders.includes(body.provider)) throw new ThreadError(503, "publisher_unavailable", "This music app is not available for publishing yet.");
      await publishing.requireConnection?.(authorized, body.provider);
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
