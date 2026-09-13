import type { ThreadView } from "./thread.js";

export type MusicConnectionStatus = {
  provider: "spotify" | "apple";
  available: boolean;
  authorized: boolean;
  connected: boolean;
  accountLabel?: string;
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function providerCard(status: MusicConnectionStatus, open: boolean): string {
  const { provider, available, authorized, connected, accountLabel } = status;
  const name = provider === "spotify" ? "Spotify" : "Apple Music";
  const label = !available ? "Not available yet" : connected ? "Playlist connected" : authorized ? "Account authorized" : "Account not connected";
  return `<section class="music-connection" aria-labelledby="${provider}-heading"><div class="music-connection-heading"><h2 id="${provider}-heading">${name}</h2><span class="connection-status">${label}</span></div>
    <p>${provider === "spotify" ? "Keep a playlist in your Spotify library up to date with this Thread." : "Add this Thread’s songs to a playlist in your Apple Music library. An Apple Music subscription is required."}</p>
    ${accountLabel ? `<p class="connection-account">${escape(accountLabel)}</p>` : ""}
    ${connected ? '<p class="thread-note">Use the same account when reconnecting. Switching accounts is not supported.</p>' : ""}
    ${available ? `<div class="connection-actions"><button class="text-button" type="button" data-authorize="${provider}"${provider === "apple" ? ' disabled aria-describedby="apple-readiness"' : ""}>${connected || authorized ? "Reconnect" : "Authorize"} ${name} <span aria-hidden="true">↗</span></button>${authorized && !connected && open ? `<button class="generate-button" type="button" data-start-sync="${provider}">Start syncing</button>` : ""}</div>${provider === "apple" ? '<p id="apple-readiness" class="thread-note" role="status">Getting Apple Music ready…</p>' : ""}` : '<p class="thread-note">You can keep collecting songs here while this app is unavailable.</p>'}
    ${provider === "apple" && available && authorized && !connected && open ? '<div id="apple-lock-confirmation" class="connection-confirmation" hidden><h3>Keep adding, keep this order</h3><p>Starting Apple Music sync permanently disables removing and reordering songs in this Thread. You can still add songs and close the Thread. You cannot disconnect Apple Music yet.</p><div class="connection-actions"><button id="confirm-apple-sync" class="generate-button" type="button">Start syncing and lock song order</button><button id="cancel-apple-sync" class="text-button" type="button">Cancel</button></div></div>' : ""}</section>`;
}

export function musicConnectionsPage(thread: ThreadView, statuses: MusicConnectionStatus[]): string {
  const path = `/t/${encodeURIComponent(thread.publicCapability)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#fafafa"><title>Connect music apps — listen.cx</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/threads.css"><script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" defer></script><script src="/music-connections.js" type="module"></script></head><body><div class="page-shell"><header class="header"><a class="wordmark" href="/" aria-label="listen.cx home">listen<span class="domain">.cx</span></a><nav><a href="${path}">Back to Thread <span aria-hidden="true">↗</span></a></nav></header>
    <main class="thread-shell" id="music-connections" data-capability="${escape(thread.publicCapability)}" data-revision="${thread.revision}"><div class="thread-heading"><span class="thread-eyebrow">${escape(thread.title)} · You manage this</span><h1>Connect music apps.</h1><p class="hero-description">Authorize your account, then start syncing this Thread to a playlist in your library.</p></div>
    ${thread.closedAt !== null ? '<p class="thread-note">This Thread is closed. You can reconnect an existing account, but cannot start a new sync connection.</p>' : ""}
    <p id="connection-message" class="form-message" role="status" aria-live="polite"></p><button id="refresh-connections" class="text-button" type="button" hidden>Refresh connections ↻</button>
    <div class="music-connections-list">${statuses.map(status => providerCard(status, thread.closedAt === null)).join("")}</div>
    <p class="thread-note">Songs are saved in this Thread. A playlist link appears only after the music app confirms its songs. Some songs may need you to confirm a matching track in the other app.</p><a class="text-button" href="${path}">Back to Thread ↗</a>
    </main></div></body></html>`;
}
