import type { Provider } from "./urls.js";
import { isManagementAuthorization, type ManagementAuthorization } from "./thread-security.js";
import { ThreadError, type PublicationStatus } from "./thread.js";

export interface PublicationTarget {
  publisherKey: string;
  capability: string;
  provider: Provider;
  nextAttemptAt: number;
  accountId: string | null;
  status: PublicationStatus["status"];
  appliedRevision: number | null;
  requestedRevision: number;
  verifiedPlaylistId: string | null;
  verifiedPlaylistUrl: string | null;
  serviceOwned: boolean;
}

export type CanonicalPublication = Pick<PublicationTarget, "provider" | "status" | "appliedRevision" | "requestedRevision" | "verifiedPlaylistId" | "verifiedPlaylistUrl"> & {
  connected: boolean;
};

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

  async retry(authorization: ManagementAuthorization, provider: Provider): Promise<void> {
    if (!isManagementAuthorization(authorization)) throw new ThreadError(403, "forbidden", "Management access required.");
    const db = this.db.withSession("first-primary");
    await db.batch([
      db.prepare(`DELETE FROM automatic_track_matches WHERE status != 'matched' AND publisher_key IN (
        SELECT publisher_key FROM thread_publications WHERE provider = ? AND connected = 1 AND status != 'synced'
        AND thread_id = (SELECT id FROM threads WHERE public_capability = ?))`).bind(provider, authorization.publicCapability),
      db.prepare(`UPDATE thread_publications SET status = 'pending', blocked_reason = NULL, failure_code = NULL
        WHERE provider = ? AND connected = 1 AND status != 'synced'
        AND thread_id = (SELECT id FROM threads WHERE public_capability = ?)`)
        .bind(provider, authorization.publicCapability),
      db.prepare(`UPDATE thread_subscriptions SET status = 'pending', blocked_reason = NULL, failure_code = NULL
        WHERE provider = 'apple' AND connected = 1
        AND thread_id = (SELECT id FROM threads WHERE public_capability = ?)
        AND EXISTS (SELECT 1 FROM thread_publications service WHERE service.thread_id = thread_subscriptions.thread_id
          AND service.provider = 'apple' AND service.service_owned = 1)`)
        .bind(authorization.publicCapability),
    ]);
  }

  private targets() {
    return `SELECT p.publisher_key AS publisherKey, t.public_capability AS capability,
      p.provider, p.next_attempt_at AS nextAttemptAt, p.account_id AS accountId,
      p.status, p.applied_revision AS appliedRevision, p.requested_revision AS requestedRevision,
      p.verified_playlist_id AS verifiedPlaylistId, p.verified_playlist_url AS verifiedPlaylistUrl,
      p.service_owned AS serviceOwned,
      p.service_ready AS serviceReady
      FROM (
        SELECT publisher_key, thread_id, provider, MAX(next_attempt_at, rate_limit_until) AS next_attempt_at, NULL AS account_id,
          status, applied_revision, requested_revision, verified_playlist_id, verified_playlist_url, connected,
          service_owned, 1 AS service_ready
          FROM thread_publications
        UNION ALL
        SELECT publisher_key, thread_id, provider, MAX(next_attempt_at, rate_limit_until) AS next_attempt_at, account_id,
          status, applied_revision, requested_revision, verified_playlist_id, verified_playlist_url, connected,
          0 AS service_owned,
          CASE WHEN provider != 'apple' OR EXISTS (
            SELECT 1 FROM thread_publications service WHERE service.thread_id = thread_subscriptions.thread_id
              AND service.provider = thread_subscriptions.provider AND service.connected = 1
              AND service.status = 'synced' AND service.applied_revision = thread_subscriptions.requested_revision
          ) THEN 1 ELSE 0 END AS service_ready
          FROM thread_subscriptions
      ) p JOIN threads t ON t.id = p.thread_id`;
  }

  async due(capability?: string): Promise<PublicationTarget[]> {
    const result = await this.db.withSession("first-primary").prepare(`${this.targets()}
      WHERE p.connected = 1 AND p.status IN ('pending', 'failed') AND p.next_attempt_at <= ?
      AND p.service_ready = 1 AND (? IS NULL OR t.public_capability = ?)
      ORDER BY p.next_attempt_at, p.thread_id, p.publisher_key LIMIT 20`)
      .bind(Date.now(), capability ?? null, capability ?? null).all<Omit<PublicationTarget, "serviceOwned"> & { serviceOwned: number }>();
    return result.results.map(target => ({ ...target, serviceOwned: Boolean(target.serviceOwned) }));
  }

  async target(publisherKey: string, includeDisconnected = false): Promise<PublicationTarget | null> {
    const target = await this.db.withSession("first-primary").prepare(`${this.targets()}
      WHERE p.publisher_key = ? AND (p.connected = 1 OR ? = 1)`).bind(publisherKey, includeDisconnected ? 1 : 0)
      .first<Omit<PublicationTarget, "serviceOwned"> & { serviceOwned: number }>();
    return target ? { ...target, serviceOwned: target.serviceOwned === 1 } : null;
  }

  async canonical(capability: string, provider: Provider): Promise<CanonicalPublication | null> {
    const row = await this.db.withSession("first-primary").prepare(`SELECT p.provider, p.connected, p.status,
      p.applied_revision AS appliedRevision, p.requested_revision AS requestedRevision,
      p.verified_playlist_id AS verifiedPlaylistId, p.verified_playlist_url AS verifiedPlaylistUrl
      FROM thread_publications p JOIN threads t ON t.id = p.thread_id
      WHERE t.public_capability = ? AND p.provider = ?`).bind(capability, provider).first<Omit<CanonicalPublication, "connected"> & { connected: number }>();
    return row ? { ...row, connected: row.connected === 1 } : null;
  }

  async verified(publisherKey: string, revision: number, playlistId: string, playlistUrl: string): Promise<void> {
    const target = await this.target(publisherKey);
    if (!target || !isPlaylistUrl(target.provider, playlistId, playlistUrl)) throw new Error("invalid_publication_readback");
    await this.db.withSession("first-primary").prepare(`UPDATE ${target.accountId ? "thread_subscriptions" : "thread_publications"} SET applied_revision = ?,
      verified_playlist_id = ?, verified_playlist_url = ?,
      status = CASE WHEN requested_revision = ? THEN 'synced' ELSE 'pending' END,
      blocked_reason = NULL, failure_code = NULL, next_attempt_at = 0
      WHERE publisher_key = ? AND connected = 1 AND requested_revision >= ?
      AND (applied_revision IS NULL OR applied_revision <= ?)
      AND (? = 1 OR verified_playlist_id IS NULL OR verified_playlist_id = ?)`)
      .bind(revision, playlistId, playlistUrl, revision, publisherKey, revision, revision,
        target.provider === "apple" && (Boolean(target.accountId) || target.serviceOwned) ? 1 : 0, playlistId).run();
  }

  async failed(publisherKey: string, revision: number, code: string, blocked: boolean, nextAttemptAt: number): Promise<void> {
    const target = await this.target(publisherKey);
    if (!target) return;
    const db = this.db.withSession("first-primary");
    const table = target.accountId ? "thread_subscriptions" : "thread_publications";
    const statements = [];
    if (code === "rate_limited") statements.push(db.prepare(`UPDATE ${table}
      SET rate_limit_until = MAX(rate_limit_until, ?) WHERE publisher_key = ?`)
      .bind(nextAttemptAt, publisherKey));
    statements.push(db.prepare(`UPDATE ${table} SET status = ?,
      blocked_reason = ?, failure_code = ?, next_attempt_at = ?
      WHERE publisher_key = ? AND requested_revision = ? AND connected = 1 AND status != 'synced'`)
      .bind(blocked ? "blocked" : "failed", blocked ? code : null, blocked ? null : code, nextAttemptAt, publisherKey, revision));
    if (!target.accountId && target.provider === "apple" && target.serviceOwned) {
      statements.push(db.prepare(`UPDATE thread_subscriptions SET status = ?, blocked_reason = ?, failure_code = ?, next_attempt_at = ?
        WHERE provider = 'apple' AND connected = 1 AND requested_revision = ?
        AND thread_id = (SELECT id FROM threads WHERE public_capability = ?) AND status != 'synced'`)
        .bind(blocked ? "blocked" : "failed", blocked ? code : null, blocked ? null : code,
          nextAttemptAt, revision, target.capability));
    }
    await db.batch(statements);
  }
}
