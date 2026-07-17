import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Resolver } from "./resolve.js";
import type { LinkRow, LinkStore } from "./db.js";
import { choicePage, handoffPage, homePage, sharePage } from "./page.js";
import {
  THREAD_ACTIVE_CONTRIBUTION_LIMIT,
  fingerprintContributionInput,
  isThreadCapability,
  normalizeRequestKey,
  normalizeThreadTitle,
  type ThreadEvent,
  type ThreadEventSink,
} from "./thread.js";
import type { ThreadPageView, ThreadStore } from "./thread-db.js";
import { threadCreationPage, threadPage, type ThreadPageModel } from "./thread-page.js";
import {
  authorizeManagementCapability,
  clearManagementCookie,
  coarseNetworkKey,
  getManagementCookie,
  isAllowedManagementRequest,
  isAllowedPublicMutation,
  setManagementCookie,
  threadSecurityHeaders,
  type AttemptLimiter,
  type ManagementAuthorization,
} from "./thread-security.js";
import { appleSearchUrl, parseTrackUrl, spotifySearchUrl } from "./urls.js";

const PREF_COOKIE = "pref";
const ONE_YEAR = 60 * 60 * 24 * 365;
const MAX_CREATE_BODY_BYTES = 4096;
const BOT_UA =
  /bot|crawler|spider|facebookexternalhit|twitterbot|slackbot|discordbot|whatsapp|telegram|linkedinbot|applebot|imessage|preview/i;

function appleMusicDeepLink(url: URL): string {
  if (url.hostname === "itunes.apple.com" || url.hostname === "geo.music.apple.com") {
    url.hostname = "music.apple.com";
  }
  return url.toString().replace(/^https:/, "music:");
}

function providerTarget(
  row: LinkRow,
  provider: "spotify" | "apple",
): { url: string; isExactMatch: boolean } {
  const fallbackUrl =
    provider === "spotify"
      ? spotifySearchUrl(row.title, row.artist)
      : appleSearchUrl(row.title, row.artist);
  const fallback =
    provider === "apple" ? appleMusicDeepLink(new URL(fallbackUrl)) : fallbackUrl;
  const candidate = provider === "spotify" ? row.spotify_url : row.apple_url;
  if (!candidate) return { url: fallback, isExactMatch: false };

  try {
    const url = new URL(candidate);
    const validHost =
      provider === "spotify"
        ? url.hostname === "open.spotify.com"
        : url.hostname === "music.apple.com" ||
          url.hostname === "geo.music.apple.com" ||
          url.hostname === "itunes.apple.com";
    return url.protocol === "https:" && validHost
      ? {
          url: provider === "apple" ? appleMusicDeepLink(url) : url.toString(),
          isExactMatch: true,
        }
      : { url: fallback, isExactMatch: false };
  } catch {
    return { url: fallback, isExactMatch: false };
  }
}

export interface AppDeps {
  resolver: Pick<Resolver, "resolve">;
  store: LinkStore;
  threadStore: ThreadStore;
  threadLimiters: {
    creation: AttemptLimiter;
    contribution: AttemptLimiter;
  };
  threadEvents?: ThreadEventSink;
  threadsEnabled?: boolean;
  baseUrl: string;
}

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

export function createApp({
  resolver,
  store,
  threadStore,
  threadLimiters,
  threadEvents,
  threadsEnabled = true,
  baseUrl,
}: AppDeps) {
  const app = new Hono();
  const secureCookies = baseUrl.startsWith("https://");

  function emitThreadEvent(event: ThreadEvent) {
    try {
      threadEvents?.emit(event);
    } catch (error) {
      console.error(JSON.stringify({ message: "Thread telemetry failed", error: String(error) }));
    }
  }

  function applyThreadHeaders(context: { header(name: string, value: string): void }) {
    for (const [name, value] of Object.entries(threadSecurityHeaders())) {
      context.header(name, value);
    }
  }

  function rateLimited(
    context: Context,
    retryAfterSeconds: number | null,
  ) {
    if (retryAfterSeconds !== null) {
      context.header("Retry-After", String(retryAfterSeconds));
    }
    return context.json(
      { code: "rate_limited", error: "Too many attempts. Wait a moment and try again." },
      429,
    );
  }

  async function authorizeCookie(
    context: Context,
    publicCapability: string,
  ): Promise<ManagementAuthorization | null> {
    const capability = getManagementCookie(context);
    if (!capability) return null;
    const authorization = await authorizeManagementCapability(
      threadStore,
      publicCapability,
      capability,
    );
    if (!authorization && isThreadCapability(publicCapability)) {
      clearManagementCookie(context, publicCapability);
    }
    return authorization;
  }

  async function threadModel(
    view: ThreadPageView,
    managed: boolean,
  ): Promise<ThreadPageModel> {
    const songs = view.contributions.map((contribution) => ({
      contributionId: String(contribution.id),
      title: contribution.title,
      artist: contribution.artist,
      artworkUrl: contribution.artworkUrl,
      canonicalUrl: `${baseUrl}/${contribution.linkSlug}`,
      removeAction: managed
        ? `/t/${view.thread.publicCapability}/manage/contributions/${contribution.id}/remove`
        : undefined,
    }));
    const state = view.thread.closedAt
      ? "closed"
      : view.totalContributions >= view.contributionLimit
        ? "exhausted"
        : view.contributions.length >= THREAD_ACTIVE_CONTRIBUTION_LIMIT
          ? "full"
          : "open";
    return {
      title: view.thread.title,
      publicUrl: `${baseUrl}/t/${view.thread.publicCapability}`,
      state,
      managed,
      actions: {
        add: `/api/threads/${view.thread.publicCapability}/contributions`,
        activateManagement: `/t/${view.thread.publicCapability}/manage/activate`,
        close: managed ? `/t/${view.thread.publicCapability}/manage/close` : undefined,
      },
      songs,
    };
  }

  async function resolveAndStore(url: string) {
    const resolved = await resolver.resolve(url);
    return resolved ? store.upsert(resolved) : null;
  }

  app.get("/", (c) => c.html(homePage(baseUrl)));

  app.get("/healthz", async (c) => {
    try {
      const [linksReady, threadsReady] = await Promise.all([
        store.isReady(),
        threadsEnabled ? threadStore.isReady() : Promise.resolve(true),
      ]);
      return linksReady && threadsReady
        ? c.json({ status: "ok" })
        : c.json({ status: "unavailable" }, 503);
    } catch (error) {
      console.error(JSON.stringify({ message: "health check failed", error: String(error) }));
      return c.json({ status: "unavailable" }, 503);
    }
  });

  app.post("/create", async (c) => {
    const parsedBody = await readBoundedJson(c.req.raw);
    if (!parsedBody.ok) {
      const error =
        parsedBody.status === 413 ? parsedBody.error : "Send JSON with a url field.";
      return c.json({ error }, parsedBody.status);
    }
    if (
      !isRecord(parsedBody.value) ||
      typeof parsedBody.value.url !== "string" ||
      !parsedBody.value.url
    ) {
      return c.json({ error: "Send JSON with a url field." }, 400);
    }
    const body = parsedBody.value as { url: string };

    let resolved;
    try {
      resolved = await resolveAndStore(body.url);
    } catch (e) {
      console.error(JSON.stringify({ message: "resolve failed", error: String(e) }));
      return c.json({ error: "Couldn't reach the music services. Try again." }, 502);
    }
    if (!resolved) {
      return c.json({ error: "That doesn't look like a Spotify or Apple Music track link." }, 422);
    }
    return c.json({
      link: `${baseUrl}/${resolved.slug}`,
      slug: resolved.slug,
      title: resolved.title,
      artist: resolved.artist,
      artworkUrl: resolved.artwork_url,
      complete: resolved.complete === 1,
    });
  });

  app.get("/threads/new", (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    applyThreadHeaders(c);
    return c.html(threadCreationPage({ createAction: "/api/threads" }));
  });

  app.post("/api/threads", async (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    applyThreadHeaders(c);
    if (!isAllowedPublicMutation(c.req.raw, baseUrl, "create-thread")) {
      return c.json({ code: "forbidden", error: "Thread creation denied." }, 403);
    }
    const parsedBody = await readBoundedJson(c.req.raw);
    if (!parsedBody.ok) {
      return c.json({ code: "invalid_body", error: parsedBody.error }, parsedBody.status);
    }
    if (!isRecord(parsedBody.value) || typeof parsedBody.value.title !== "string") {
      return c.json({ code: "invalid_title", error: "Send a Thread title." }, 400);
    }

    let title: string;
    try {
      title = normalizeThreadTitle(parsedBody.value.title);
    } catch {
      return c.json(
        { code: "invalid_title", error: "Thread title must be between 1 and 80 characters." },
        422,
      );
    }

    const networkKey = coarseNetworkKey(c.req.header("cf-connecting-ip"));
    const decision = await threadLimiters.creation.check(networkKey);
    if (!decision.allowed) {
      emitThreadEvent({ event: "thread_creation", outcome: "rate_limited" });
      return rateLimited(c, decision.retryAfterSeconds);
    }

    const result = await threadStore.create(title);
    if (result.status === "limit_reached") {
      emitThreadEvent({ event: "thread_creation", outcome: "limit_reached" });
      return c.json(
        {
          code: "thread_limit_reached",
          error: "Thread creation is temporarily unavailable. Try again later.",
        },
        503,
      );
    }

    setManagementCookie(
      c,
      result.thread.publicCapability,
      result.managementCapability,
    );
    const publicUrl = `${baseUrl}/t/${result.thread.publicCapability}`;
    emitThreadEvent({ event: "thread_creation", outcome: "created" });
    return c.json(
      {
        publicUrl,
        managementUrl: `${publicUrl}#manage=${result.managementCapability}`,
      },
      201,
    );
  });

  app.get("/t/:slug", async (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    const publicCapability = c.req.param("slug");
    const view = await threadStore.getPageView(publicCapability);
    if (!view) return c.text("Link not found.", 404);
    applyThreadHeaders(c);

    const isBot = BOT_UA.test(c.req.header("user-agent") ?? "");
    const managed = isBot ? false : Boolean(await authorizeCookie(c, publicCapability));
    return c.html(threadPage(await threadModel(view, managed)));
  });

  app.get("/api/threads/:slug", async (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    applyThreadHeaders(c);
    const view = await threadStore.getPageView(c.req.param("slug"));
    if (!view) return c.json({ code: "not_found", error: "Thread not found." }, 404);
    const model = await threadModel(view, false);
    return c.json({
      title: model.title,
      state: model.state,
      songs: model.songs.map((song) => ({
        title: song.title,
        artist: song.artist,
        artworkUrl: song.artworkUrl,
        url: song.canonicalUrl,
      })),
    });
  });

  app.post("/api/threads/:slug/contributions", async (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    applyThreadHeaders(c);
    const publicCapability = c.req.param("slug");
    if (!isAllowedPublicMutation(c.req.raw, baseUrl, "add-song")) {
      return c.json({ code: "forbidden", error: "Contribution denied." }, 403);
    }
    const parsedBody = await readBoundedJson(c.req.raw);
    if (!parsedBody.ok) {
      return c.json({ code: "invalid_body", error: parsedBody.error }, parsedBody.status);
    }
    if (
      !isRecord(parsedBody.value) ||
      typeof parsedBody.value.url !== "string" ||
      typeof parsedBody.value.requestKey !== "string"
    ) {
      return c.json(
        { code: "invalid_body", error: "Send a song URL and request key." },
        400,
      );
    }

    const parsedTrack = parseTrackUrl(parsedBody.value.url);
    if (!parsedTrack) {
      return c.json(
        {
          code: "invalid_track",
          error: "That doesn't look like a Spotify or Apple Music track link.",
        },
        422,
      );
    }

    let requestKey: string;
    try {
      requestKey = normalizeRequestKey(parsedBody.value.requestKey);
    } catch {
      return c.json(
        { code: "invalid_request", error: "The contribution request is invalid." },
        400,
      );
    }

    const decision = await threadLimiters.contribution.check(
      `${publicCapability}\0add-song`,
    );
    if (!decision.allowed) {
      emitThreadEvent({ event: "thread_contribution", outcome: "rate_limited" });
      return rateLimited(c, decision.retryAfterSeconds);
    }

    const sourceIdentity = {
      sourceProvider: parsedTrack.provider,
      sourceCatalogId: parsedTrack.id,
      sourceStorefront: parsedTrack.storefront,
    };
    const inputFingerprint = await fingerprintContributionInput(sourceIdentity);
    const preflight = await threadStore.preflightContribution(
      publicCapability,
      requestKey,
      inputFingerprint,
    );
    if (preflight.status === "existing") {
      emitThreadEvent({ event: "thread_contribution", outcome: "existing" });
      return c.json({ status: "existing", contributionId: preflight.contribution.id });
    }
    if (preflight.status === "conflict") {
      emitThreadEvent({ event: "thread_contribution", outcome: "conflict" });
      return c.json(
        { code: "conflict", error: "That request key was already used for another song." },
        409,
      );
    }
    if (preflight.status === "limit_reached") {
      emitThreadEvent({ event: "thread_contribution", outcome: "limit_reached" });
      return c.json(
        {
          code: "contribution_limit_reached",
          error: "This Thread has reached its lifetime contribution limit.",
        },
        409,
      );
    }
    if (preflight.status === "not_found") {
      return c.json({ code: "not_found", error: "Thread not found." }, 404);
    }

    let link: LinkRow | null;
    try {
      link = await resolveAndStore(parsedBody.value.url);
    } catch {
      emitThreadEvent({ event: "thread_contribution", outcome: "provider_unavailable" });
      return c.json(
        {
          code: "provider_unavailable",
          error: "Couldn't reach the music services. Try again.",
        },
        502,
      );
    }
    if (!link) {
      return c.json(
        { code: "invalid_track", error: "That track could not be resolved. Try again." },
        422,
      );
    }

    const identity = {
      linkSlug: link.slug,
      ...sourceIdentity,
    };
    const result = await threadStore.acceptContribution(publicCapability, {
      ...identity,
      requestKey,
      inputFingerprint,
    });

    switch (result.status) {
      case "accepted":
        emitThreadEvent({
          event: "thread_contribution",
          outcome: "accepted",
          count: result.contribution.position,
        });
        return c.json({ status: "accepted", contributionId: result.contribution.id }, 201);
      case "existing":
        emitThreadEvent({ event: "thread_contribution", outcome: "existing" });
        return c.json({ status: "existing", contributionId: result.contribution.id });
      case "conflict":
        emitThreadEvent({ event: "thread_contribution", outcome: "conflict" });
        return c.json(
          { code: "conflict", error: "That request key was already used for another song." },
          409,
        );
      case "full":
        emitThreadEvent({ event: "thread_contribution", outcome: "full" });
        return c.json({ code: "full", error: "This Thread is full." }, 409);
      case "closed":
        emitThreadEvent({ event: "thread_contribution", outcome: "closed" });
        return c.json({ code: "closed", error: "Contributions are closed." }, 409);
      case "limit_reached":
        emitThreadEvent({ event: "thread_contribution", outcome: "limit_reached" });
        return c.json(
          {
            code: "contribution_limit_reached",
            error: "This Thread has reached its lifetime contribution limit.",
          },
          409,
        );
      case "not_found":
        return c.json({ code: "not_found", error: "Thread not found." }, 404);
    }
  });

  app.post("/api/thread-events", async (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    applyThreadHeaders(c);
    if (!isAllowedPublicMutation(c.req.raw, baseUrl, "thread-event")) {
      return c.json({ code: "forbidden", error: "Event denied." }, 403);
    }
    const parsedBody = await readBoundedJson(c.req.raw);
    if (!parsedBody.ok) {
      return c.json({ code: "invalid_event", error: parsedBody.error }, parsedBody.status);
    }
    if (!isRecord(parsedBody.value) || !["opened", "copied"].includes(String(parsedBody.value.outcome))) {
      return c.json({ code: "invalid_event", error: "Event is invalid." }, 400);
    }
    emitThreadEvent({
      event: "thread_song_action",
      outcome: parsedBody.value.outcome as "opened" | "copied",
    });
    return c.body(null, 204);
  });

  app.post("/t/:slug/manage/activate", async (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    applyThreadHeaders(c);
    const publicCapability = c.req.param("slug");
    if (!isAllowedManagementRequest(c.req.raw, baseUrl)) {
      return c.json({ code: "forbidden", error: "Management action denied." }, 403);
    }

    const parsedBody = await readBoundedJson(c.req.raw);
    if (!parsedBody.ok) {
      return c.json({ code: "invalid_body", error: parsedBody.error }, parsedBody.status);
    }
    if (!isRecord(parsedBody.value) || typeof parsedBody.value.token !== "string") {
      return c.json({ code: "invalid_token", error: "Private link is invalid." }, 401);
    }

    const authorization = await authorizeManagementCapability(
      threadStore,
      publicCapability,
      parsedBody.value.token,
    );
    if (!authorization) {
      if (isThreadCapability(publicCapability)) {
        clearManagementCookie(c, publicCapability);
      }
      return c.json({ code: "unauthorized", error: "Private link is invalid." }, 401);
    }
    setManagementCookie(c, publicCapability, parsedBody.value.token);
    return c.json({ status: "activated" });
  });

  app.post("/t/:slug/manage/contributions/:id/remove", async (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    applyThreadHeaders(c);
    const publicCapability = c.req.param("slug");
    if (!isAllowedManagementRequest(c.req.raw, baseUrl)) {
      return c.json({ code: "forbidden", error: "Management action denied." }, 403);
    }
    const authorization = await authorizeCookie(c, publicCapability);
    if (!authorization) {
      return c.json({ code: "unauthorized", error: "Management authorization required." }, 401);
    }
    const contributionId = Number(c.req.param("id"));
    if (!Number.isSafeInteger(contributionId) || contributionId < 1) {
      return c.json({ code: "not_found", error: "Contribution not found." }, 404);
    }
    const result = await threadStore.removeContribution(authorization, contributionId);
    if (result.status === "removed") {
      emitThreadEvent({ event: "thread_management", outcome: "removed" });
      return c.json({ status: "removed" });
    }
    return c.json({ code: "not_found", error: "Contribution not found." }, 404);
  });

  app.post("/t/:slug/manage/close", async (c) => {
    if (!threadsEnabled) return c.text("Link not found.", 404);
    applyThreadHeaders(c);
    const publicCapability = c.req.param("slug");
    if (!isAllowedManagementRequest(c.req.raw, baseUrl)) {
      return c.json({ code: "forbidden", error: "Management action denied." }, 403);
    }
    const authorization = await authorizeCookie(c, publicCapability);
    if (!authorization) {
      return c.json({ code: "unauthorized", error: "Management authorization required." }, 401);
    }
    const result = await threadStore.close(authorization);
    if (result.status === "closed") {
      emitThreadEvent({ event: "thread_management", outcome: "closed" });
      return c.json({ status: "closed" });
    }
    return c.json({ code: "not_found", error: "Thread not found." }, 404);
  });

  app.get("/*", async (c) => {
    const requestUrl = new URL(c.req.url);
    const pathUrl = `${requestUrl.pathname.slice(1)}${requestUrl.search}`;

    if (/^https?:\/\//.test(pathUrl)) {
      let row;
      try {
        row = await resolveAndStore(pathUrl);
      } catch (e) {
        console.error(JSON.stringify({ message: "path resolve failed", error: String(e) }));
        return c.text("Couldn't reach the music services. Try again.", 502);
      }
      if (!row) return c.text("That doesn't look like a Spotify or Apple Music track link.", 422);
      return c.html(sharePage(row, baseUrl));
    }

    const slug = requestUrl.pathname.match(/^\/([^/]+)$/)?.[1];
    if (!slug) return c.text("Link not found.", 404);
    const row = await store.get(slug);
    if (!row) return c.text("Link not found.", 404);
    c.header("Cache-Control", "private, no-store");

    const ua = c.req.header("user-agent") ?? "";
    if (BOT_UA.test(ua)) {
      // Unfurlers always get the OG-tagged page, never a redirect.
      return c.html(choicePage(row, baseUrl));
    }

    const to = c.req.query("to");
    if (to === "spotify" || to === "apple") {
      setCookie(c, PREF_COOKIE, to, {
        maxAge: ONE_YEAR,
        path: "/",
        sameSite: "Lax",
        httpOnly: true,
        secure: secureCookies,
      });
      const target = providerTarget(row, to);
      return c.html(handoffPage(row, to, target.url, target.isExactMatch));
    }

    if (c.req.query("choose") !== "1") {
      const pref = getCookie(c, PREF_COOKIE);
      if (pref === "spotify" || pref === "apple") {
        const target = providerTarget(row, pref);
        return c.html(handoffPage(row, pref, target.url, target.isExactMatch));
      }
    }

    return c.html(choicePage(row, baseUrl));
  });

  return app;
}
