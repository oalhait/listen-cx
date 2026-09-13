import { describe, expect, it } from "vitest";
import { prefersHtml, renderRecipient } from "./recipient.js";
import type { LinkRow } from "./db.js";

const row: LinkRow = { slug: "2345678", title: "Cataracts", artist: "Freddie Gibbs", artwork_url: null, spotify_url: "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO", apple_url: null, isrc: null, complete: 0, created_at: "" };

describe("recipient representation", () => {
  it.each([null, "*/*", "application/json", "text/html;q=0", "text/html;q=.5, application/json", "text/html, application/json"])("keeps JSON for %s", (accept) => {
    expect(prefersHtml(accept)).toBe(false);
  });
  it.each(["text/html", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "application/json;q=.5, text/html;q=.9"])("serves HTML for %s", (accept) => {
    expect(prefersHtml(accept)).toBe(true);
  });
  it("offers a direct source link and clearly labeled search for the other provider", () => {
    const html = renderRecipient(row, "https://listen.test");
    expect(html).toContain(`href="${row.spotify_url}"`);
    expect(html).toContain("Open in Spotify");
    expect(html).toContain("Search Apple Music");
    expect(html).toContain("search?term=Cataracts%20Freddie%20Gibbs");
    expect(html).not.toContain("Open in Apple Music");
  });
  it("publishes rich social metadata with the track artwork", () => {
    const html = renderRecipient({ ...row, artwork_url: "https://images.example/cataracts.jpg?a=1&b=2" }, "https://listen.test");
    expect(html).toContain('<meta property="og:type" content="music.song">');
    expect(html).toContain('<meta property="og:title" content="Cataracts — Freddie Gibbs">');
    expect(html).toContain('<meta property="og:description" content="Listen to Cataracts by Freddie Gibbs. Open the original track or find it in your music app.">');
    expect(html).toContain('<meta property="og:url" content="https://listen.test/2345678">');
    expect(html).toContain('<meta property="og:image" content="https://images.example/cataracts.jpg?a=1&amp;b=2">');
    expect(html).toContain('<meta property="og:image:alt" content="Album artwork for Cataracts by Freddie Gibbs">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).toContain('<link rel="canonical" href="https://listen.test/2345678">');
  });
  it("opens an Apple source directly and searches Spotify", () => {
    const html = renderRecipient({ ...row, spotify_url: null, apple_url: "https://music.apple.com/us/album/song/123?i=456" });
    expect(html).toContain("Open in Apple Music");
    expect(html).toContain("Search Spotify");
  });
  it("does not turn legacy dual URLs or the complete flag into verified matches", () => {
    const html = renderRecipient({ ...row, apple_url: "https://music.apple.com/us/song/456", complete: 1 });
    expect(html).not.toContain("Open in");
    expect(html).not.toContain(row.spotify_url);
    expect(html).toContain("Search Spotify");
    expect(html).toContain("Search Apple Music");
    expect(html).toContain("could not verify");
  });
  it("escapes stored text and ignores unsafe artwork and provider URLs", () => {
    const html = renderRecipient({ ...row, title: '<script>alert("x")</script>', artwork_url: 'javascript:alert(1)', spotify_url: 'https://evil.example/track/4SN5Kkig8iJ8vdwsOoP7IO' }, "https://listen.test");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain('property="og:image"');
  });
});
