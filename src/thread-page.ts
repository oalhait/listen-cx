import type { PublicationStatus, ThreadContribution, ThreadView } from "./thread.js";
import type { Provider } from "./urls.js";
import { isPlaylistUrl } from "./publication-db.js";

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#fafafa"><title>${escape(title)} — listen.cx</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/threads.css"><script src="/thread-page.js" type="module"></script></head><body><div class="page-shell"><header class="header"><a class="wordmark" href="/" aria-label="listen.cx home">listen<span class="domain">.cx</span></a><nav><a href="/threads">My Threads</a> <a href="/settings">Account</a> <a href="/threads/new">New Thread <span aria-hidden="true">↗</span></a></nav></header>${body}</div></body></html>`;
}

export function threadCreationPage(): string {
  return shell("Start a Thread", `<main class="thread-shell"><div class="thread-heading"><span class="thread-eyebrow">Threads</span><h1>Good music.<br>Better together.</h1><p class="hero-description">Give your group a place to collect songs, in your order.</p></div>
    <form id="thread-create-form" class="thread-create"><label for="thread-title">Name your Thread</label><div class="input-wrap"><input id="thread-title" name="title" maxlength="80" placeholder="Late night drives" required autocomplete="off"><button class="generate-button" type="submit">Create Thread <span aria-hidden="true">↗</span></button></div></form>
    <section id="thread-created" class="thread-created" hidden><h2>Your Thread is ready</h2><label for="public-link">Share this link to collect songs</label><a id="public-link"></a><button type="button" data-copy="public-link">Copy sharing link</button><label for="management-link">Keep this management link private</label><a id="management-link"></a><button type="button" data-copy="management-link">Copy management link</button><p>Save the management link. It lets you reorder songs, remove them, and close the Thread.</p><a id="open-thread" class="generate-button">Open Thread <span aria-hidden="true">↗</span></a></section>
    <p id="thread-message" class="form-message" role="status"></p><p class="thread-note">Songs are saved here. Connect your music account in settings, then subscribe to a Thread for your own playlist.</p></main>`);
}

function counterpartForm(song: ThreadContribution): string {
  const name = song.source.provider === "spotify" ? "Apple Music" : "Spotify";
  return `<details class="counterpart"><summary>Add ${name} link</summary><p class="thread-note">The source link does not identify the same recording in ${name}’s catalog. A matching link is only needed to sync this song to ${name}.</p><form data-identify="${song.id}"><label for="counterpart-${song.id}">${name} track link</label><input id="counterpart-${song.id}" name="url" type="url" required placeholder="Paste the matching track link"><label class="counterpart-confirm"><input name="confirmed" type="checkbox" required> I checked this is the same recording. This match cannot be changed.</label><button type="submit" class="text-button">Confirm match</button></form></details>`;
}

function songRow(song: ThreadContribution, index: number, count: number, managed: boolean, identify: boolean): string {
  return `<li class="thread-song" data-contribution-id="${song.id}">${artwork(song.artworkUrl)}<div class="track-meta"><a href="/${encodeURIComponent(song.linkSlug)}"><strong>${escape(song.title)}</strong></a><span>${escape(song.artist)}</span>${identify ? counterpartForm(song) : ""}</div>${managed ? `<div class="song-actions"><button type="button" data-move="up" data-id="${song.id}" aria-label="Move ${escape(song.title)} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-move="down" data-id="${song.id}" aria-label="Move ${escape(song.title)} down" ${index === count - 1 ? "disabled" : ""}>↓</button><button type="button" data-remove="${song.id}" aria-label="Remove ${escape(song.title)}">Remove</button></div>` : ""}</li>`;
}

function publicationCard(publication: PublicationStatus, canRetry: boolean): string {
  const name = publication.provider === "spotify" ? "Spotify" : "Apple Music";
  const unresolved = ["identities_incomplete", "cross_provider_identity_unresolved", "legacy_source_not_verified"].includes(publication.blockedReason ?? "");
  const current = publication.appliedRevision === publication.requestedRevision;
  const status = !publication.connected ? "Not connected"
    : unresolved ? "Some songs still need a verified match."
    : publication.status === "blocked" ? "Sync needs attention"
    : publication.status === "failed" ? "Sync failed. Your songs are saved here."
    : publication.status === "synced" && current ? "Synced"
    : "Waiting to sync";
  const playlistUrl = publication.connected && publication.appliedRevision !== null && publication.verifiedPlaylistId && publication.verifiedPlaylistUrl
    && isPlaylistUrl(publication.provider, publication.verifiedPlaylistId, publication.verifiedPlaylistUrl) ? publication.verifiedPlaylistUrl : null;
  return `<div><strong>${name}</strong><span>${status}</span>${playlistUrl ? `<a class="text-button" href="${escape(playlistUrl)}" target="_blank" rel="noopener noreferrer">Listen on ${name} ↗</a>${!current ? '<span>Last verified playlist. Newer changes are not synced yet.</span>' : ""}` : ""}${canRetry && publication.connected && ["blocked", "failed"].includes(publication.status) ? `<button class="text-button" type="button" data-retry-sync="${publication.provider}">Retry sync</button>` : ""}</div>`;
}

export function threadPage(view: ThreadView | null, managed: boolean, availableProviders: Provider[] = [], accountSubscriptions = false): string {
  if (!view) return shell("Thread not found", '<main class="thread-shell"><h1>Thread not found</h1><p>Check the sharing link and try again.</p><a class="text-button" href="/threads/new">Start a new Thread ↗</a></main>');
  const open = view.closedAt === null;
  const appleConnected = view.publications.some(publication => publication.provider === "apple" && publication.connected);
  return shell(view.title, `<main class="thread-shell" id="thread" data-capability="${view.publicCapability}" data-revision="${view.revision}"><div class="thread-heading"><span class="thread-eyebrow">Thread${managed ? " · You manage this" : ""}</span><h1>${escape(view.title)}</h1><p class="hero-description">${open ? "A shared collection of songs, in your order." : "This Thread is closed. You can still open its songs."}</p></div>
    <div class="thread-sharing"><a id="public-link" href="/t/${view.publicCapability}">Sharing link</a><button type="button" data-copy="public-link">Copy sharing link</button></div>
    ${open ? '<form id="add-song-form"><label class="sr-only" for="thread-song-url">Spotify or Apple Music track link</label><div class="input-wrap"><input id="thread-song-url" type="url" placeholder="Paste a track link…" required autocomplete="off" spellcheck="false"><button type="submit" class="generate-button">Add song <span aria-hidden="true">↗</span></button></div><p class="thread-note">Direct track links only. Albums and spotify.link are not supported yet.</p></form>' : ""}
    <p id="thread-message" class="form-message" role="status"></p><button id="refresh-thread" class="text-button" type="button" hidden>Refresh Thread ↻</button><button id="retry-management" class="text-button" type="button" hidden>Retry management access</button>
    <section class="thread-songs" aria-label="Songs"><div class="section-caption"><span class="section-title">${view.contributions.length} ${view.contributions.length === 1 ? "song" : "songs"}</span><button id="refresh-songs" class="text-button" type="button">Refresh ↻</button></div>${managed && open && appleConnected ? '<p class="thread-note">Apple Music is connected, so songs cannot be removed or reordered. You can still add songs and close the Thread.</p>' : ""}<ol id="thread-song-list">${view.contributions.map((song, index) => songRow(song, index, view.contributions.length, managed && open && !appleConnected, managed && open && song.source.verified && !song.counterpart && (accountSubscriptions || view.publications.some(p => p.connected && p.provider !== song.source.provider)))).join("")}</ol>${view.contributions.length === 0 ? '<p class="thread-empty">Start with a song you love.</p>' : ""}</section>
    ${accountSubscriptions ? `<section class="thread-sync" id="personal-subscription" data-capability="${view.publicCapability}" aria-label="Your playlists"><div class="section-caption"><span class="section-title">Your playlists</span><a data-subscription-settings class="text-button" href="/settings?thread=${view.publicCapability}">Account settings ↗</a></div><p data-subscriptions-status role="status" aria-live="polite">Loading your subscriptions…</p><div class="music-connections-list">${([['apple', 'Apple Music'], ['spotify', 'Spotify']] as const).map(([provider, name]) => `<div class="music-connection" data-subscription-provider="${provider}"><h2>${name}</h2><p data-subscription-status role="status" aria-live="polite">Loading…</p><a data-subscription-connect class="text-button" hidden>Connect ${name} ↗</a><a data-subscription-playlist class="text-button" hidden>Open in ${name} ↗</a><div class="connection-actions"><button type="button" data-subscription-action="subscribe" class="generate-button" hidden>Subscribe on ${name}</button><button type="button" data-subscription-action="retry" class="text-button" hidden>Retry ${name} sync</button><button type="button" data-subscription-action="unsubscribe" class="text-button" hidden>Unsubscribe from ${name}</button></div></div>`).join('')}</div><p class="thread-note">Subscribe to either service, or both. Each playlist updates independently as songs are added.</p></section><script type="module" src="/subscription.js"></script>` : `<section class="thread-sync" aria-label="Music app sync"><div class="section-caption"><span class="section-title">Music apps</span>${managed ? `<a class="text-button" href="/t/${view.publicCapability}/manage/apps">Connect music apps ↗</a>` : ""}</div><div class="sync-providers">${view.publications.map(publication => publicationCard(publication, managed && availableProviders.includes(publication.provider))).join("")}</div><p class="thread-note">Songs and their order are saved here. Playlist links appear after the music app confirms the songs. Refresh to check sync progress.</p></section>`}
    ${managed && open ? '<section class="thread-management"><button id="close-thread" class="text-button" type="button">Close Thread</button><div id="close-confirmation" hidden><p>Stop changes to this Thread? Its songs will stay available.</p><button id="confirm-close" class="text-button" type="button">Close Thread now</button><button id="cancel-close" class="text-button" type="button">Keep it open</button></div></section>' : ""}</main>`);
}
