import { expect, it } from "vitest";
import { threadCreationPage, threadPage } from "./thread-page.js";
import type { ThreadView } from "./thread.js";

const view: ThreadView = { publicCapability: "abcdefghijklmnopqrstuv", title: '<script>alert("x")</script>', revision: 2, closedAt: null, contributions: [
  { id: 1, title: "Song <one>", artist: "Artist", linkSlug: "2345678", artworkUrl: "javascript:alert(1)", source: { provider: "spotify", id: "4SN5Kkig8iJ8vdwsOoP7IO", storefront: "us", verified: true } },
], publications: [{ provider: "apple", connected: false, requestedRevision: 2, appliedRevision: null, verifiedPlaylistId: null, verifiedPlaylistUrl: null, status: "blocked", blockedReason: "apple_sync_unavailable", failureCode: null }] };
it("escapes Thread metadata and keeps scripts external", () => {
  const page = threadPage(view, false);
  expect(page).toContain("&lt;script&gt;");
  expect(page).not.toContain('<script>alert');
  expect(page).not.toContain("javascript:");
  expect(page).toContain('src="/thread-page.js"');
  expect(page).toContain('href="/2345678"');
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

it("offers explicit counterpart confirmation to managers when a connected app is missing a match", () => {
  const connected = { ...view, publications: view.publications.map(p => ({ ...p, connected: true })) };
  const page = threadPage(connected, true);
  expect(page).toContain('data-identify="1"');
  expect(page).toContain("same recording");
  expect(page).toContain("Add Apple Music link");
  expect(page).toContain("only needed to sync this song to Apple Music");
  expect(page).not.toContain("Confirm Apple Music version");
  expect(page).toContain('type="checkbox"');
  expect(page).not.toContain('data-remove="1"');
  expect(threadPage(connected, false)).not.toContain('data-identify=');
  expect(threadPage({ ...connected, contributions: connected.contributions.map(s => ({ ...s, counterpart: { provider: "apple" as const, id: "123", storefront: "us", confirmed: true as const } })) }, true)).not.toContain('data-identify=');
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
  expect(page).toContain('data-identify="1"');
  expect(threadPage(view, false, [], true)).not.toContain('data-identify=');
});
