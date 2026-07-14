import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createApp } from "../src/app.js";
import { D1LinkStore } from "../src/db.js";
import type { Resolved } from "../src/resolve.js";
import { appleSearchUrl } from "../src/urls.js";

const RESOLVED: Resolved = {
  isrc: "USSM11804580",
  title: "Kingston",
  artist: "Faye Webster",
  artworkUrl: "https://img/apple.jpg",
  spotifyUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
  appleUrl: "https://music.apple.com/us/album/kingston/1443108737?i=1443109064",
  complete: true,
};

interface CreateResponse {
  link: string;
  slug: string;
  title?: string;
  artist?: string;
  artworkUrl?: string | null;
}

function createResponse(value: unknown): CreateResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("link" in value) ||
    typeof value.link !== "string" ||
    !("slug" in value) ||
    typeof value.slug !== "string"
  ) {
    throw new Error("invalid create response");
  }
  return {
    link: value.link,
    slug: value.slug,
    title: "title" in value && typeof value.title === "string" ? value.title : undefined,
    artist: "artist" in value && typeof value.artist === "string" ? value.artist : undefined,
    artworkUrl:
      "artworkUrl" in value && (typeof value.artworkUrl === "string" || value.artworkUrl === null)
        ? value.artworkUrl
        : undefined,
  };
}

function makeApp(resolved: Resolved | null = RESOLVED) {
  const store = new D1LinkStore(env.DB);
  const resolver = { resolve: async () => resolved } as any;
  const app = createApp({ resolver, store, baseUrl: "https://x.link" });
  return { app, store };
}

function makeFailingApp() {
  const store = new D1LinkStore(env.DB);
  const resolver = { resolve: async () => Promise.reject(new Error("provider unavailable")) } as any;
  return createApp({ resolver, store, baseUrl: "https://x.link" });
}

describe("routes", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let slug: string;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM links").run();
    ({ app } = makeApp());
    const res = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://open.spotify.com/track/x" }),
    });
    ({ slug } = createResponse(await res.json()));
  });

  it("create returns the short link and dedupes on ISRC", async () => {
    const res = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://open.spotify.com/track/x" }),
    });
    const data = createResponse(await res.json());
    expect(data.slug).toBe(slug);
    expect(data.link).toBe(`https://x.link/${slug}`);
    expect(data.title).toBe(RESOLVED.title);
    expect(data.artist).toBe(RESOLVED.artist);
    expect(data.artworkUrl).toBe(RESOLVED.artworkUrl);
  });

  it.each(["spotify", "apple"] as const)(
    "shows a copyable short link for a pasted Spotify URL despite a %s preference",
    async (preference) => {
    const resolve = vi.fn(async () => RESOLVED);
    const store = new D1LinkStore(env.DB);
    const converter = createApp({ resolver: { resolve } as any, store, baseUrl: "https://x.link" });
    const sourceUrl = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";

    const res = await converter.request(`/${sourceUrl}`, { headers: { cookie: `pref=${preference}` } });

    expect(resolve).toHaveBeenCalledWith(sourceUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain(`https://x.link/${slug}`);
    expect(html).toContain('id="copy"');
    },
  );

  it("preserves Apple deep-link query parameters when converting a path URL", async () => {
    const resolve = vi.fn(async () => RESOLVED);
    const store = new D1LinkStore(env.DB);
    const converter = createApp({ resolver: { resolve } as any, store, baseUrl: "https://x.link" });
    const sourceUrl = "https://music.apple.com/us/album/kingston/1443108737?i=1443109064";

    const res = await converter.request(`/${sourceUrl}`);

    expect(resolve).toHaveBeenCalledWith(sourceUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`https://x.link/${slug}`);
  });

  it("first visit without cookie renders the choice page", async () => {
    const res = await app.request(`/${slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Where do you listen?");
    expect(html).toContain("Kingston");
  });

  it("?to=spotify sets the cookie and shows a direct provider handoff", async () => {
    const res = await app.request(`/${slug}?to=spotify`);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toContain("pref=spotify");
    expect(res.headers.get("set-cookie")).toContain("Secure");
    const html = await res.text();
    expect(html).toContain('Open in Spotify');
    expect(html).toContain(`href="${RESOLVED.spotifyUrl}"`);
  });

  it("returning visit with cookie shows a direct provider handoff", async () => {
    const res = await app.request(`/${slug}`, { headers: { cookie: "pref=apple" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain('Open in Apple Music');
    expect(html).toContain(`href="${RESOLVED.appleUrl}"`);
  });

  it("partial links remember a provider and redirect to search", async () => {
    const partial = { ...RESOLVED, appleUrl: null, complete: false };
    const { app: partialApp } = makeApp(partial);
    const created = await partialApp.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: partial.spotifyUrl }),
    });
    const { slug: partialSlug } = createResponse(await created.json());

    const choice = await partialApp.request(`/${partialSlug}?to=apple`);
    expect(choice.status).toBe(200);
    expect(choice.headers.get("set-cookie")).toContain("pref=apple");
    const choiceHtml = await choice.text();
    expect(choiceHtml).toContain('Search Apple Music');
    expect(choiceHtml).toContain(`href="${appleSearchUrl(partial.title, partial.artist)}"`);
    expect(choiceHtml).toContain('Opens Apple Music search results');

    const returning = await partialApp.request(`/${partialSlug}`, {
      headers: { cookie: "pref=apple" },
    });
    expect(returning.status).toBe(200);
    const returningHtml = await returning.text();
    expect(returningHtml).toContain('Search Apple Music');
    expect(returningHtml).toContain(`href="${appleSearchUrl(partial.title, partial.artist)}"`);
  });

  it("falls back to provider search when a stored destination is unsafe", async () => {
    const unsafe = { ...RESOLVED, isrc: null, appleUrl: "javascript:alert(1)" };
    const { app: unsafeApp } = makeApp(unsafe);
    const created = await unsafeApp.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: unsafe.spotifyUrl }),
    });
    const { slug: unsafeSlug } = createResponse(await created.json());

    const res = await unsafeApp.request(`/${unsafeSlug}`, { headers: { cookie: "pref=apple" } });
    const html = await res.text();
    expect(html).toContain('Search Apple Music');
    expect(html).toContain(`href="${appleSearchUrl(unsafe.title, unsafe.artist)}"`);
    expect(html).not.toContain('javascript:alert');
  });

  it("uses supported iTunes Apple track URLs as exact destinations", async () => {
    const itunesUrl = "https://itunes.apple.com/us/album/kingston/123456789?i=123456790";
    const resolved = { ...RESOLVED, isrc: null, appleUrl: itunesUrl };
    const { app: itunesApp } = makeApp(resolved);
    const created = await itunesApp.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: resolved.spotifyUrl }),
    });
    const { slug: itunesSlug } = createResponse(await created.json());

    const res = await itunesApp.request(`/${itunesSlug}`, { headers: { cookie: "pref=apple" } });
    const html = await res.text();
    expect(html).toContain("Open in Apple Music");
    expect(html).toContain(`href="${itunesUrl}"`);
  });

  it("?choose=1 overrides the cookie and shows the page", async () => {
    const res = await app.request(`/${slug}?choose=1`, { headers: { cookie: "pref=apple" } });
    expect(res.status).toBe(200);
  });

  it("unfurl bots get OG tags even with no cookie", async () => {
    const res = await app.request(`/${slug}`, {
      headers: { "user-agent": "Slackbot-LinkExpanding 1.0" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('og:title" content="Kingston"');
    expect(html).toContain("og:image");
  });

  it("rejects non-track urls with a friendly 422", async () => {
    const { app: rejecting } = makeApp(null);
    const res = await rejecting.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(422);
  });

  it("distinguishes provider failures from invalid links", async () => {
    const res = await makeFailingApp().request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Couldn't reach the music services. Try again." });
  });

  it("reports healthy when D1 is reachable", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects oversized create bodies before resolving", async () => {
    const res = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "4097" },
      body: JSON.stringify({ url: "https://open.spotify.com/track/x" }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects oversized bodies when Content-Length is forged", async () => {
    const res = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "1" },
      body: JSON.stringify({ url: "https://open.spotify.com/track/" + "x".repeat(4096) }),
    });
    expect(res.status).toBe(413);
  });

  it("unknown slug 404s", async () => {
    const res = await app.request("/zzzzzzz");
    expect(res.status).toBe(404);
  });
});
