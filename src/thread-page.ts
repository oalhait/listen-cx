import type { ThreadContribution, ThreadView } from "./thread.js";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function artwork(value: string | null): string {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? `<img src="${escape(url.href)}" alt="" width="52" height="52" loading="lazy">` : "";
  } catch { return ""; }
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#fafafa"><title>${escape(title)} — listen.cx</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/threads.css"><script src="/thread-page.js" type="module"></script></head><body><div class="page-shell"><header class="header"><a class="wordmark" href="/" aria-label="listen.cx home">listen<span class="domain">.cx</span></a><nav><a href="/threads/new">New Thread <span aria-hidden="true">↗</span></a></nav></header>${body}</div></body></html>`;
}

export function threadCreationPage(): string {
  return shell("Start a Thread", `<main class="thread-shell"><div class="thread-heading"><span class="thread-eyebrow">Threads</span><h1>Good music.<br>Better together.</h1><p class="hero-description">Give your group a place to collect songs, in your order.</p></div>
    <form id="thread-create-form" class="thread-create"><label for="thread-title">Name your Thread</label><div class="input-wrap"><input id="thread-title" name="title" maxlength="80" placeholder="Late night drives" required autocomplete="off"><button class="generate-button" type="submit">Create Thread <span aria-hidden="true">↗</span></button></div></form>
    <section id="thread-created" class="thread-created" hidden><h2>Your Thread is ready</h2><label for="public-link">Share this link to collect songs</label><a id="public-link"></a><button type="button" data-copy="public-link">Copy sharing link</button><label for="management-link">Keep this management link private</label><a id="management-link"></a><button type="button" data-copy="management-link">Copy management link</button><p>Save the management link. It lets you reorder songs, remove them, and close the Thread.</p><a id="open-thread" class="generate-button">Open Thread <span aria-hidden="true">↗</span></a></section>
    <p id="thread-message" class="form-message" role="status"></p><p class="thread-note">Songs are saved on the website. Sync to Apple Music and Spotify is not available yet.</p></main>`);
}

function songRow(song: ThreadContribution, index: number, count: number, managed: boolean): string {
  return `<li class="thread-song" data-contribution-id="${song.id}">${artwork(song.artworkUrl)}<div class="track-meta"><a href="/${encodeURIComponent(song.linkSlug)}"><strong>${escape(song.title)}</strong></a><span>${escape(song.artist)}</span></div>${managed ? `<div class="song-actions"><button type="button" data-move="up" data-id="${song.id}" aria-label="Move ${escape(song.title)} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-move="down" data-id="${song.id}" aria-label="Move ${escape(song.title)} down" ${index === count - 1 ? "disabled" : ""}>↓</button><button type="button" data-remove="${song.id}" aria-label="Remove ${escape(song.title)}">Remove</button></div>` : ""}</li>`;
}

export function threadPage(view: ThreadView | null, managed: boolean): string {
  if (!view) return shell("Thread not found", '<main class="thread-shell"><h1>Thread not found</h1><p>Check the sharing link and try again.</p><a class="text-button" href="/threads/new">Start a new Thread ↗</a></main>');
  const open = view.closedAt === null;
  const statusText = { blocked: "Sync unavailable", pending: "Waiting to sync", failed: "Sync failed", synced: "Synced" };
  return shell(view.title, `<main class="thread-shell" id="thread" data-capability="${view.publicCapability}" data-revision="${view.revision}"><div class="thread-heading"><span class="thread-eyebrow">Thread${managed ? " · You manage this" : ""}</span><h1>${escape(view.title)}</h1><p class="hero-description">${open ? "A shared collection of songs, in your order." : "This Thread is closed. You can still open its songs."}</p></div>
    <div class="thread-sharing"><a id="public-link" href="/t/${view.publicCapability}">Sharing link</a><button type="button" data-copy="public-link">Copy sharing link</button></div>
    ${open ? '<form id="add-song-form"><label class="sr-only" for="thread-song-url">Spotify or Apple Music track link</label><div class="input-wrap"><input id="thread-song-url" type="url" placeholder="Paste a track link…" required autocomplete="off" spellcheck="false"><button type="submit" class="generate-button">Add song <span aria-hidden="true">↗</span></button></div><p class="thread-note">Direct track links only. Albums and spotify.link are not supported yet.</p></form>' : ""}
    <p id="thread-message" class="form-message" role="status"></p><button id="refresh-thread" class="text-button" type="button" hidden>Refresh Thread ↻</button><button id="retry-management" class="text-button" type="button" hidden>Retry management access</button>
    <section class="thread-songs" aria-label="Songs"><div class="section-caption"><span class="section-title">${view.contributions.length} ${view.contributions.length === 1 ? "song" : "songs"}</span><button id="refresh-songs" class="text-button" type="button">Refresh ↻</button></div><ol id="thread-song-list">${view.contributions.map((song, index) => songRow(song, index, view.contributions.length, managed && open)).join("")}</ol>${view.contributions.length === 0 ? '<p class="thread-empty">Start with a song you love.</p>' : ""}</section>
    <section class="thread-sync" aria-label="Music app sync"><div class="section-caption"><span class="section-title">Music apps</span></div><div class="sync-providers">${view.publications.map(publication => `<div><strong>${publication.provider === "spotify" ? "Spotify" : "Apple Music"}</strong><span>${statusText[publication.status]}</span></div>`).join("")}</div><p class="thread-note">Songs and their order are saved here. Music apps follow this Thread when sync is available.</p></section>
    ${managed && open ? '<section class="thread-management"><button id="close-thread" class="text-button" type="button">Close Thread</button><div id="close-confirmation" hidden><p>Stop changes to this Thread? Its songs will stay available.</p><button id="confirm-close" class="text-button" type="button">Close Thread now</button><button id="cancel-close" class="text-button" type="button">Keep it open</button></div></section>' : ""}</main>`);
}
