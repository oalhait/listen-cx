import type { Provider } from "./urls.js";

export interface PublicationTarget {
  publisherKey: string;
  capability: string;
  provider: Provider;
  nextAttemptAt: number;
}

export function isPlaylistUrl(provider: Provider, id: string, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    return provider === "spotify"
      ? url.hostname === "open.spotify.com" && /^[A-Za-z0-9]{22}$/.test(id) && url.pathname === `/playlist/${id}`
      : url.hostname === "music.apple.com" && /^p\.[A-Za-z0-9.-]+$/.test(id) && /^\/[a-z]{2}\/playlist\/(?:[^/]+\/)?pl\.[A-Za-z0-9.-]+\/?$/.test(url.pathname);
  } catch { return false; }
}

export class D1PublicationStore {
  constructor(private readonly db: D1Database) {}

  async due(capability?: string): Promise<PublicationTarget[]> {
    const result = await this.db.withSession("first-primary").prepare(`SELECT p.publisher_key AS publisherKey,
      t.public_capability AS capability, p.provider, p.next_attempt_at AS nextAttemptAt
      FROM thread_publications p JOIN threads t ON t.id = p.thread_id
      WHERE p.connected = 1 AND p.status IN ('pending', 'failed') AND p.next_attempt_at <= ?
      AND (? IS NULL OR t.public_capability = ?) ORDER BY p.next_attempt_at, p.thread_id LIMIT 20`)
      .bind(Date.now(), capability ?? null, capability ?? null).all<PublicationTarget>();
    return result.results;
  }

  async target(publisherKey: string): Promise<PublicationTarget | null> {
    return this.db.withSession("first-primary").prepare(`SELECT p.publisher_key AS publisherKey,
      t.public_capability AS capability, p.provider, p.next_attempt_at AS nextAttemptAt
      FROM thread_publications p JOIN threads t ON t.id = p.thread_id
      WHERE p.publisher_key = ? AND p.connected = 1`).bind(publisherKey).first<PublicationTarget>();
  }

  async verified(publisherKey: string, revision: number, playlistId: string, playlistUrl: string): Promise<void> {
    const target = await this.target(publisherKey);
    if (!target || !isPlaylistUrl(target.provider, playlistId, playlistUrl)) throw new Error("invalid_publication_readback");
    await this.db.withSession("first-primary").prepare(`UPDATE thread_publications SET applied_revision = ?,
      verified_playlist_id = ?, verified_playlist_url = ?,
      status = CASE WHEN requested_revision = ? THEN 'synced' ELSE 'pending' END,
      blocked_reason = NULL, failure_code = NULL, next_attempt_at = 0
      WHERE publisher_key = ? AND connected = 1 AND requested_revision >= ?
      AND (applied_revision IS NULL OR applied_revision <= ?)
      AND (verified_playlist_id IS NULL OR verified_playlist_id = ?)`)
      .bind(revision, playlistId, playlistUrl, revision, publisherKey, revision, revision, playlistId).run();
  }

  async failed(publisherKey: string, revision: number, code: string, blocked: boolean, nextAttemptAt: number): Promise<void> {
    await this.db.withSession("first-primary").prepare(`UPDATE thread_publications SET status = ?,
      blocked_reason = ?, failure_code = ?, next_attempt_at = ?
      WHERE publisher_key = ? AND requested_revision = ? AND connected = 1 AND status != 'synced'`)
      .bind(blocked ? "blocked" : "failed", blocked ? code : null, blocked ? null : code, nextAttemptAt, publisherKey, revision).run();
  }
}
