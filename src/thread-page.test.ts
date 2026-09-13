import { expect, it } from "vitest";
import { threadCreationPage, threadPage } from "./thread-page.js";
import type { ThreadView } from "./thread.js";

const view: ThreadView = { publicCapability: "abcdefghijklmnopqrstuv", title: '<script>alert("x")</script>', revision: 2, closedAt: null, contributions: [
  { id: 1, title: "Song <one>", artist: "Artist", linkSlug: "2345678", artworkUrl: "javascript:alert(1)", source: { provider: "spotify", id: "4SN5Kkig8iJ8vdwsOoP7IO", storefront: "us", verified: true } },
], publications: [{ provider: "apple", connected: false, requestedRevision: 2, appliedRevision: null, verifiedPlaylistId: null, verifiedPlaylistUrl: null, status: "blocked", blockedReason: "apple_sync_unavailable", failureCode: null }] };
it("escapes Thread metadata and keeps scripts external", () => {
  const page = threadPage(view, false, [], false, "https://listen.test");
  expect(page).toContain("&lt;script&gt;");
  expect(page).not.toContain('<script>alert');
  expect(page).not.toContain("javascript:");
  expect(page).toContain('src="/thread-page.js"');
  expect(page).toContain('href="/2345678"');
});
it("publishes a Jam preview using its first safe artwork and song count", () => {
  const page = threadPage({ ...view, title: "Late night drives", contributions: [
    { ...view.contributions[0]!, artworkUrl: "https://images.example/cover.jpg?a=1&b=2" },
    { ...view.contributions[0]!, id: 2, title: "Second song" },
  ] }, false, [], false, "https://listen.test");
  expect(page).toContain('<meta property="og:type" content="website">');
  expect(page).toContain('<meta property="og:title" content="Late night drives — a music Jam">');
  expect(page).toContain('<meta property="og:description" content="2 songs, collected together. Listen, vote, or add yours on listen.cx.">');
  expect(page).toContain(`<meta property="og:url" content="https://listen.test/t/${view.publicCapability}">`);
  expect(page).toContain('<meta property="og:image" content="https://images.example/cover.jpg?a=1&amp;b=2">');
  expect(page).toContain('<meta property="og:image:alt" content="Artwork for Song &lt;one&gt; by Artist">');
  expect(page).toContain('<meta name="twitter:card" content="summary">');
  expect(page).toContain(`<link rel="canonical" href="https://listen.test/t/${view.publicCapability}">`);
});
it("shows management controls only to managers and locks closed Threads", () => {
  expect(threadPage(view, false)).not.toContain('id="close-thread"');
  expect(threadPage(view, true)).toContain('id="close-thread"');
  expect(threadPage(view, true)).toContain('data-remove="1"');
  const closed = threadPage({ ...view, closedAt: "now" }, true);
  expect(closed).not.toContain('id="add-song-form"');
  expect(closed).not.toContain('data-remove="1"');
  expect(closed).toContain("This Thread is closed");
});
it("describes unconnected publishing without claiming sync or requiring native setup", () => {
  const page = threadPage(view, true);
  expect(page).toContain("Not connected");
  expect(page).not.toContain("Install");
  expect(page).not.toContain("native_publisher");
  expect(page).not.toContain("physical device");
});
it("offers a bounded creation form with private management-link guidance", () => {
  expect(threadCreationPage()).toContain('maxlength="80"');
  expect(threadCreationPage()).toContain("management link");
  expect(threadCreationPage()).not.toContain("Sync to Apple Music and Spotify is not available yet");
});

it("links managers to account connections even when providers are unavailable", () => {
  const path = `/t/${view.publicCapability}/manage/apps`;
  expect(threadPage(view, true)).toContain(`href="${path}"`);
  expect(threadPage(view, true)).toContain("Connect music apps");
  expect(threadPage(view, true, ["apple"])).not.toContain('data-connect=');
  expect(threadPage(view, false, ["apple"])).not.toContain(path);
  expect(threadPage({ ...view, closedAt: "now" }, true)).toContain(`href="${path}"`);
});

it("hides removal and ordering after Apple connects while preserving additions and close", () => {
  const page = threadPage({ ...view, publications: view.publications.map(p => ({ ...p, connected: true })) }, true);
  expect(page).not.toContain('data-remove=');
  expect(page).not.toContain('data-move=');
  expect(page).toContain('id="add-song-form"');
  expect(page).toContain('id="close-thread"');
  expect(page).toContain("Apple Music is connected, so songs cannot be removed or reordered");
});

it("distinguishes pending, failed, unresolved, and verified sync without exposing internal errors", () => {
  const publication = { ...view.publications[0]!, connected: true };
  const page = (patch: Partial<typeof publication>) => threadPage({ ...view, publications: [{ ...publication, ...patch }] }, false);
  expect(page({ status: "pending" })).toContain("Waiting to sync");
  expect(page({ status: "failed", failureCode: "matching_pending" })).toContain("Finding matching songs");
  expect(page({ status: "failed", failureCode: "provider_secret_failure" })).toContain("Sync failed");
  expect(page({ status: "failed", failureCode: "provider_secret_failure" })).not.toContain("provider_secret_failure");
  expect(page({ blockedReason: "cross_provider_identity_unresolved" })).toContain("Some songs still need a verified match");
  expect(page({ blockedReason: "cross_provider_identity_unresolved" })).not.toContain("cross_provider_identity_unresolved");
  expect(page({ blockedReason: "identities_incomplete" })).toContain("Some songs still need a verified match");
  expect(page({ blockedReason: "provider_drift" })).toContain("Sync needs attention");
  expect(page({ status: "synced", appliedRevision: 2 })).toContain("Synced");
  expect(page({ status: "synced", appliedRevision: 1 })).toContain("Waiting to sync");
});

it("links only verified provider playlists and explains when the link has older songs", () => {
  const publication = { ...view.publications[0]!, connected: true, status: "pending" as const, appliedRevision: 1,
    verifiedPlaylistId: "p.library123", verifiedPlaylistUrl: "https://music.apple.com/us/playlist/road-trip/pl.public123" };
  const page = threadPage({ ...view, publications: [publication] }, false);
  expect(page).toContain(`href="${publication.verifiedPlaylistUrl}"`);
  expect(page).toContain("Listen on Apple Music");
  expect(page).toContain("Last verified playlist. Newer changes are not synced yet");
  for (const url of ["javascript:alert(1)", "https://evil.example/playlist/123", "https://music.apple.com.evil.example/us/playlist/pl.public123"]) {
    const unsafe = threadPage({ ...view, publications: [{ ...publication, verifiedPlaylistUrl: url }] }, false);
    expect(unsafe).not.toContain('Listen on Apple Music');
    expect(unsafe).not.toContain(url);
  }
  const spotify = { ...publication, provider: "spotify" as const, verifiedPlaylistId: "4SN5Kkig8iJ8vdwsOoP7IO", verifiedPlaylistUrl: "https://open.spotify.com/playlist/4SN5Kkig8iJ8vdwsOoP7IO" };
  expect(threadPage({ ...view, publications: [spotify] }, false)).toContain("Listen on Spotify");
  expect(threadPage({ ...view, publications: [{ ...spotify, verifiedPlaylistId: null }] }, false)).not.toContain("Listen on Spotify");
  expect(threadPage({ ...view, publications: [{ ...spotify, appliedRevision: null }] }, false)).not.toContain("Listen on Spotify");
  expect(threadPage({ ...view, publications: [{ ...spotify, connected: false }] }, false)).not.toContain("Listen on Spotify");
});

it("keeps manual counterpart controls out of manager and public pages", () => {
  const connected = { ...view, publications: view.publications.map(p => ({ ...p, connected: true })) };
  for (const managed of [true, false]) {
    const page = threadPage(connected, managed);
    expect(page).not.toContain('data-identify=');
    expect(page).not.toContain('Add Apple Music link');
    expect(page).not.toContain('type="checkbox"');
  }
});

it("keeps sync retry available to a manager after closure", () => {
  const closed = { ...view, closedAt: "now", publications: view.publications.map(p => ({ ...p, connected: true, status: "failed" as const })) };
  expect(threadPage(closed, true, ["apple"])).toContain('data-retry-sync="apple"');
  expect(threadPage(closed, false, ["apple"])).not.toContain('data-retry-sync=');
});

it("shows a personal subscription and account settings instead of shared provider connections", () => {
  const page = threadPage(view, true, ["apple", "spotify"], true);
  expect(page).toContain('id="personal-subscription"');
  expect(page).toContain('data-subscription-provider="apple"');
  expect(page).toContain('data-subscription-provider="spotify"');
  expect(page).toContain('Your playlists');
  expect(page).toContain('src="/subscription.js"');
  expect(page).toContain('/settings?thread=');
  expect(page).not.toContain('/manage/apps');
  expect(page).not.toContain('Waiting to sync');
  expect(page).not.toContain('data-identify=');
  expect(threadPage(view, false, [], true)).not.toContain('data-identify=');
});

it('renders unified song entries without provider match links or controls', () => {
  const song = view.contributions[0]!;
  const matched = { provider: 'apple' as const, storefront: 'us', status: 'matched' as const, method: 'metadata' as const,
    selected: { id: '123', title: 'Song', artist: 'Artist' }, candidates: [] };
  const page = threadPage({ ...view, contributions: [{ ...song, matches: [matched, { ...matched, provider: 'spotify', selected: { ...matched.selected, id: '3OM6qQmdFV6uy61GIqpRtf' } }] }] }, true, [], true);
  expect(page).not.toContain('Matched on');
  expect(page).not.toContain('https://music.apple.com/us/song/123');
  expect(page).toContain('<strong>Song &lt;one&gt;</strong>');
  expect(page).toContain(`href="/${song.linkSlug}"`);
  expect(page).not.toContain('https://open.spotify.com/track/3OM6qQmdFV6uy61GIqpRtf');
  expect(page).not.toContain('Change Apple Music match');
  expect(page).not.toContain('data-identify=');
  const uncertain = threadPage({ ...view, contributions: [{ ...song, matches: [{ ...matched, status: 'ambiguous', selected: null,
    candidates: [{ id: '456', title: '<Live>', artist: 'Artist' }] }] }] }, true, [], true);
  expect(uncertain).not.toContain('Review Apple Music match');
  expect(uncertain).not.toContain('data-identify=');
  expect(uncertain).not.toContain('Matched on Apple Music');
  expect(uncertain).not.toContain('https://music.apple.com/us/song/456');
});


it('shows the contributor name with escaped markup and a safe round photo', () => {
  const page = threadPage({ ...view, contributions: [{ ...view.contributions[0]!, addedBy: {
    displayName: '<Omar> & friends', avatarUrl: 'https://example.com/photo.jpg?a=1&b=2',
  } }] }, false);
  expect(page).toContain('Added by &lt;Omar&gt; &amp; friends');
  expect(page).toContain('class="contributor-avatar"');
  expect(page).toContain('src="https://example.com/photo.jpg?a=1&amp;b=2"');
  expect(page).toContain('referrerpolicy="no-referrer"');
});

it('keeps unsafe contributor photos out of the markup and supports older songs', () => {
  expect(threadPage(view, false)).toContain('Added by Guest');
  for (const avatarUrl of ['javascript:alert(1)', 'http://example.com/a', 'https://user:secret@example.com/a', 'https://example.com/' + 'a'.repeat(2048)]) {
    const page = threadPage({ ...view, contributions: [{ ...view.contributions[0]!, addedBy: { displayName: 'Omar', avatarUrl } }] }, false);
    expect(page).toContain('Added by Omar');
    expect(page).not.toContain('class="contributor-avatar"');
  }
});

it('renders an accessible collaborative Jam with a fragment-free sharing target', () => {
  const page = threadPage(view, true);
  expect(page).toContain('id="invite-friends"');
  expect(page).toContain(`id="public-link" href="/t/${view.publicCapability}"`);
  expect(page).toContain('id="jam-join-form"');
  expect(page).toContain('maxlength="40"');
  expect(page).toContain('id="chat-log"');
  expect(page).toContain('role="log"');
  expect(page).toContain('aria-live="off"');
  expect(page).toContain('id="chat-message"');
  expect(page).toContain('maxlength="500"');
  expect(page).toContain('data-vote="up"');
  expect(page).toContain('data-vote="down"');
  expect(page).toContain('aria-pressed="false"');
  expect(page).not.toContain('#manage=');
});

it('keeps closed Jams readable while removing join, compose, and active queue controls', () => {
  const closed = threadPage({ ...view, closedAt: 'now' }, true);
  expect(closed).toContain('This Thread is closed');
  expect(closed).toContain('Jam is read-only');
  expect(closed).toContain('id="chat-log"');
  expect(closed).toContain('Voting and chat are closed');
  expect(closed).not.toContain('id="jam-join-form"');
  expect(closed).not.toContain('id="chat-form"');
  expect(closed).not.toContain('id="add-song-form"');
  expect(closed).not.toContain('data-remove="1"');
  expect(closed).toContain('data-vote="up"');
  expect(closed).toMatch(/data-vote="up"[^>]*disabled/);
});

it('escapes song titles in vote labels and exposes manager-only chat moderation state', () => {
  const publicPage = threadPage(view, false);
  const managerPage = threadPage(view, true);
  expect(publicPage).toContain('aria-label="Vote on Song &lt;one&gt;"');
  expect(publicPage).not.toContain('data-managed="true"');
  expect(managerPage).toContain('data-managed="true"');
  expect(managerPage).toContain('id="thread-management"');
});
