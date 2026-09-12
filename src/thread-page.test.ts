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
it("describes blocked publishing without claiming sync or requiring native setup", () => {
  const page = threadPage(view, true);
  expect(page).toContain("Sync unavailable");
  expect(page).not.toContain("Install");
  expect(page).not.toContain("native_publisher");
  expect(page).not.toContain("physical device");
});
it("offers a bounded creation form with private management-link guidance", () => {
  expect(threadCreationPage()).toContain('maxlength="80"');
  expect(threadCreationPage()).toContain("management link");
});
