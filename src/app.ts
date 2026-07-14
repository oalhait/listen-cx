import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Resolver } from "./resolve.js";
import type { LinkRow, LinkStore } from "./db.js";
import { choicePage, homePage, sharePage } from "./page.js";
import { appleSearchUrl, spotifySearchUrl } from "./urls.js";

const PREF_COOKIE = "pref";
const ONE_YEAR = 60 * 60 * 24 * 365;
const BOT_UA =
  /bot|crawler|spider|facebookexternalhit|twitterbot|slackbot|discordbot|whatsapp|telegram|linkedinbot|applebot|imessage|preview/i;

function providerTarget(row: LinkRow, provider: "spotify" | "apple"): string {
  if (provider === "spotify") {
    return row.spotify_url ?? spotifySearchUrl(row.title, row.artist);
  }
  return row.apple_url ?? appleSearchUrl(row.title, row.artist);
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
    if (contentLength > 4096) {
      return c.json({ error: "Request body is too large." }, 413);
    }

    let body: { url?: string };
    try {
      body = await c.req.json();
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
      return c.redirect(providerTarget(row, to), 302);
    }

    if (c.req.query("choose") !== "1") {
      const pref = getCookie(c, PREF_COOKIE);
      if (pref === "spotify" || pref === "apple") {
        return c.redirect(providerTarget(row, pref), 302);
      }
    }

    return c.html(choicePage(row, baseUrl));
  });

  return app;
}
