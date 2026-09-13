import type { LinkRow } from "./db.js";
import { socialMetadata } from "./social-metadata.js";
import { appleSearchUrl, parseTrackUrl, spotifySearchUrl } from "./urls.js";

export function prefersHtml(accept: string | null): boolean {
  const qualities = new Map((accept ?? "").toLowerCase().split(",").map((part) => {
    const [type = "", ...parameters] = part.trim().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const value = quality ? Number(quality.trim().slice(2)) : 1;
    return [type.trim(), Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0];
  }));
  return (qualities.get("text/html") ?? 0) > (qualities.get("application/json") ?? qualities.get("application/*") ?? qualities.get("*/*") ?? 0);
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function safeArtwork(value: string | null): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function renderRecipient(row: LinkRow | null, baseUrl = "https://listen.cx"): string {
  const title = row?.title ?? "Link not found";
  let body = '<p class="hero-description">This link may be mistyped or no longer available.</p>';
  let metadata = socialMetadata({ title: "Link not found — listen.cx", description: "This listen.cx link is not available." });
  if (row) {
    const hasSingleSource = Boolean(row.spotify_url) !== Boolean(row.apple_url);
    const spotify = hasSingleSource && row.spotify_url && parseTrackUrl(row.spotify_url)?.provider === "spotify" ? row.spotify_url : null;
    const apple = hasSingleSource && row.apple_url && parseTrackUrl(row.apple_url)?.provider === "apple" ? row.apple_url : null;
    const artwork = safeArtwork(row.artwork_url);
    metadata = socialMetadata({
      title: `${row.title} — ${row.artist}`,
      description: `Listen to ${row.title} by ${row.artist}. Open the original track or find it in your music app.`,
      url: `${baseUrl}/${encodeURIComponent(row.slug)}`,
      image: artwork,
      imageAlt: `Album artwork for ${row.title} by ${row.artist}`,
      type: "music.song",
    });
    body = `${artwork ? `<img class="recipient-artwork" src="${escape(artwork)}" alt="" width="240" height="240">` : ""}
      <p class="hero-description">${escape(row.artist)}</p>
      <div class="receiver-card recipient-choices"><h2>Where do you listen?</h2><div class="provider-choices">
      <a class="provider-choice" href="${escape(spotify ?? spotifySearchUrl(row.title, row.artist))}">${spotify ? "Open in Spotify" : "Search Spotify"}<span aria-hidden="true">↗</span></a>
      <a class="provider-choice" href="${escape(apple ?? appleSearchUrl(row.title, row.artist))}">${apple ? "Open in Apple Music" : "Search Apple Music"}<span aria-hidden="true">↗</span></a>
      </div><p class="preference-note">${spotify || apple ? "The original track opens directly. Search results on the other app may differ." : "We could not verify the original source for this older link. Search results may differ."}</p></div>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#fafafa">${metadata}<title>${escape(title)} — listen.cx</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&amp;display=swap"></head><body><div class="page-shell"><header class="header"><a class="wordmark" href="/">listen<span class="domain">.cx</span></a></header><main class="hero recipient"><h1>${escape(title)}</h1>${body}<a class="text-button recipient-home" href="/">Make your own link <span aria-hidden="true">↗</span></a></main></div></body></html>`;
}
