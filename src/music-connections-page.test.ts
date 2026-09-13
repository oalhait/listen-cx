import { expect, it } from "vitest";
import { musicConnectionsPage, type MusicConnectionStatus } from "./music-connections-page.js";
import type { ThreadView } from "./thread.js";

const thread: ThreadView = { publicCapability: "abcdefghijklmnopqrstuv", title: '<script>"Night drives"</script>', revision: 4, closedAt: null, contributions: [], publications: [] };
const statuses: MusicConnectionStatus[] = [
  { provider: "spotify", available: true, authorized: false, connected: false },
  { provider: "apple", available: true, authorized: true, connected: false, accountLabel: '<img src=x onerror="alert(1)">' },
];

it("escapes account and Thread metadata and loads authorization scripts externally", () => {
  const page = musicConnectionsPage(thread, statuses);
  expect(page).toContain("&lt;script&gt;&quot;Night drives&quot;&lt;/script&gt;");
  expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(page).not.toContain("<img src=x");
  expect(page).not.toContain("<script>");
  expect(page).toContain('src="/music-connections.js"');
  expect(page).toContain('src="https://js-cdn.music.apple.com/musickit/v3/musickit.js"');
  expect(page).toContain('data-revision="4"');
});

it("offers authorization before syncing and requires Apple's permanent lock confirmation", () => {
  const page = musicConnectionsPage(thread, statuses);
  expect(page).toContain('data-authorize="spotify"');
  expect(page).not.toContain('data-start-sync="spotify"');
  expect(page).toContain('data-start-sync="apple"');
  expect(page).toMatch(/id="apple-lock-confirmation"[^>]* hidden/);
  expect(page).toContain("permanently disables removing and reordering songs");
  expect(page).toContain('id="confirm-apple-sync"');
});

it("keeps unavailable apps visible without authorization controls", () => {
  const page = musicConnectionsPage(thread, statuses.map(status => ({ ...status, available: false })));
  expect(page.match(/Not available yet/g)).toHaveLength(2);
  expect(page).not.toContain('data-authorize=');
  expect(page).not.toContain('data-start-sync=');
});

it("allows reconnecting an existing account without offering another playlist connection", () => {
  const page = musicConnectionsPage(thread, statuses.map(status => ({ ...status, connected: true, authorized: true })));
  expect(page).toContain("Reconnect Spotify");
  expect(page).toContain("Reconnect Apple Music");
  expect(page).toContain("Use the same account");
  expect(page).not.toContain('data-start-sync=');
});

it("keeps reauthorization available after closure while blocking new sync connections", () => {
  const page = musicConnectionsPage({ ...thread, closedAt: "now" }, statuses);
  expect(page).toContain("This Thread is closed");
  expect(page).toContain('data-authorize="spotify"');
  expect(page).not.toContain('data-start-sync=');
});
