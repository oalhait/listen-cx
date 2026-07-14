import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Resolver } from "./resolve.js";
import type { LinkRow, LinkStore } from "./db.js";
import { choicePage, handoffPage, homePage, sharePage } from "./page.js";
import { appleSearchUrl, spotifySearchUrl } from "./urls.js";

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
  resolver: Resolver;
  store: LinkStore;
  baseUrl: string;
}

export function createApp({ resolver, store, baseUrl }: AppDeps) {
  const app = new Hono();
  const secureCookies = baseUrl.startsWith("https://");

  async function resolveAndStore(url: string) {
    const resolved = await resolver.resolve(url);
    return resolved ? store.upsert(resolved) : null;
  }

  app.get("/", (c) => c.html(homePage(baseUrl)));

  app.get("/healthz", async (c) => {
    try {
      return (await store.isReady())
        ? c.json({ status: "ok" })
        : c.json({ status: "unavailable" }, 503);
    } catch (error) {
      console.error(JSON.stringify({ message: "health check failed", error: String(error) }));
      return c.json({ status: "unavailable" }, 503);
    }
  });

  app.post("/create", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > MAX_CREATE_BODY_BYTES) {
      return c.json({ error: "Request body is too large." }, 413);
    }

    let body: { url?: string };
    try {
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.json({ error: "Send JSON with a url field." }, 400);

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
          return c.json({ error: "Request body is too large." }, 413);
        }
        chunks.push(value);
      }

      const rawBody = new Uint8Array(bodySize);
      let offset = 0;
      for (const chunk of chunks) {
        rawBody.set(chunk, offset);
        offset += chunk.byteLength;
      }
      body = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return c.json({ error: "Send JSON with a url field." }, 400);
    }
    if (!body.url) return c.json({ error: "Send JSON with a url field." }, 400);

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
    const row = resolved;
    return c.json({
      link: `${baseUrl}/${row.slug}`,
      slug: row.slug,
      title: row.title,
      artist: row.artist,
      artworkUrl: row.artwork_url,
      complete: row.complete === 1,
    });
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
