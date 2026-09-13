import type { Provider } from "./urls.js";
import { ThreadError, type PublicationStatus } from "./thread.js";

export interface Account {
  id: string;
  groupId: string;
  provider: Provider;
  subject: string;
  label: string;
  credentials: string | null;
}

export interface Subscription extends PublicationStatus {
  accountId: string;
  capability: string;
  title: string;
  publisherKey: string;
  nextAttemptAt: number;
}

type SubscriptionRow = Omit<Subscription, "connected"> & { connected: number };

const accountColumns = "a.id, a.group_id AS groupId, a.provider, a.provider_subject AS subject, a.label, a.encrypted_credentials AS credentials";
const subscriptionSelect = `SELECT s.account_id AS accountId, t.public_capability AS capability,
  t.title, s.provider, s.publisher_key AS publisherKey, s.connected,
  s.requested_revision AS requestedRevision, s.applied_revision AS appliedRevision, s.status,
  s.blocked_reason AS blockedReason, s.failure_code AS failureCode,
  s.verified_playlist_id AS verifiedPlaylistId, s.verified_playlist_url AS verifiedPlaylistUrl,
  s.next_attempt_at AS nextAttemptAt
  FROM thread_subscriptions s JOIN threads t ON t.id = s.thread_id`;

export class D1AccountStore {
  constructor(private readonly db: D1Database) {}

  async upsert(provider: Provider, subject: string, label: string, credentials?: string): Promise<Account> {
    const db = this.db.withSession("first-primary");
    await db.prepare(`INSERT INTO accounts(id, provider, provider_subject, label, encrypted_credentials)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, provider_subject) DO UPDATE SET
      label = excluded.label, encrypted_credentials = COALESCE(excluded.encrypted_credentials, accounts.encrypted_credentials),
      updated_at = datetime('now')`).bind(crypto.randomUUID(), provider, subject, label, credentials ?? null).run();
    return (await db.prepare(`SELECT ${accountColumns} FROM accounts a WHERE a.provider = ? AND a.provider_subject = ?`)
      .bind(provider, subject).first<Account>())!;
  }

  async account(id: string): Promise<Account | null> {
    return this.db.withSession("first-primary").prepare(`SELECT ${accountColumns} FROM accounts a WHERE a.id = ?`)
      .bind(id).first<Account>();
  }

  async connections(accountId: string): Promise<Account[]> {
    const { results } = await this.db.withSession("first-primary").prepare(`SELECT ${accountColumns} FROM accounts a
      WHERE a.group_id = (SELECT group_id FROM accounts WHERE id = ?) ORDER BY a.provider`)
      .bind(accountId).all<Account>();
    return results;
  }

  async linkAccounts(anchorId: string, targetId: string, sessionHash: string): Promise<boolean> {
    const row = await this.db.withSession("first-primary").prepare(`UPDATE OR IGNORE accounts
      SET group_id = (SELECT group_id FROM accounts WHERE id = ?)
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM accounts anchor JOIN account_sessions s ON s.account_id = anchor.id
        WHERE anchor.id = ? AND s.token_hash = ? AND s.expires_at > ?
          AND (accounts.group_id = anchor.group_id OR (
            NOT EXISTS (SELECT 1 FROM accounts member WHERE member.group_id = accounts.group_id AND member.id != accounts.id)
            AND NOT EXISTS (SELECT 1 FROM accounts member WHERE member.group_id = anchor.group_id
              AND member.provider = accounts.provider AND member.id != accounts.id)
          ))
      ) RETURNING id`)
      .bind(anchorId, targetId, anchorId, sessionHash, Date.now()).first<{ id: string }>();
    return row !== null;
  }

  async setCredentials(id: string, credentials: string): Promise<void> {
    await this.db.withSession("first-primary").prepare("UPDATE accounts SET encrypted_credentials = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(credentials, id).run();
  }

  async createSession(accountId: string, tokenHash: string, expiresAt: number): Promise<void> {
    await this.db.withSession("first-primary").prepare("INSERT INTO account_sessions(account_id, token_hash, expires_at) VALUES (?, ?, ?)")
      .bind(accountId, tokenHash, expiresAt).run();
  }

  async session(tokenHash: string): Promise<Account | null> {
    return this.db.withSession("first-primary").prepare(`SELECT ${accountColumns} FROM accounts a
      JOIN account_sessions s ON s.account_id = a.id WHERE s.token_hash = ? AND s.expires_at > ?`)
      .bind(tokenHash, Date.now()).first<Account>();
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.withSession("first-primary").prepare("DELETE FROM account_sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  async rotateSession(accountId: string, previousHash: string, tokenHash: string, expiresAt: number): Promise<boolean> {
    const db = this.db.withSession("first-primary");
    const results = await db.batch([
      db.prepare(`INSERT INTO account_sessions(account_id, token_hash, expires_at)
        SELECT account_id, ?, ? FROM account_sessions
        WHERE account_id = ? AND token_hash = ? AND expires_at > ? RETURNING token_hash`)
        .bind(tokenHash, expiresAt, accountId, previousHash, Date.now()),
      db.prepare("DELETE FROM account_sessions WHERE account_id = ? AND token_hash = ?").bind(accountId, previousHash),
    ]);
    return results[0]!.results.length === 1;
  }

  async putOAuth(stateHash: string, browserHash: string, payload: string, expiresAt: number): Promise<void> {
    await this.db.withSession("first-primary").prepare("INSERT INTO account_oauth(state_hash, browser_hash, encrypted_payload, expires_at) VALUES (?, ?, ?, ?)")
      .bind(stateHash, browserHash, payload, expiresAt).run();
  }

  async consumeOAuth(stateHash: string, browserHash: string): Promise<{ payload: string } | null> {
    return this.db.withSession("first-primary").prepare(`DELETE FROM account_oauth
      WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING encrypted_payload AS payload`)
      .bind(stateHash, browserHash, Date.now()).first<{ payload: string }>();
  }

  async cancelOAuth(browserHash: string): Promise<void> {
    await this.db.withSession("first-primary").prepare("DELETE FROM account_oauth WHERE browser_hash = ?").bind(browserHash).run();
  }

  async completeOAuthSession(stateHash: string, browserHash: string, accountId: string, tokenHash: string, expiresAt: number): Promise<boolean> {
    const db = this.db.withSession("first-primary");
    const result = await db.batch([
      db.prepare(`INSERT INTO account_sessions(account_id, token_hash, expires_at)
        SELECT ?, ?, ? FROM account_oauth WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING token_hash`)
        .bind(accountId, tokenHash, expiresAt, stateHash, browserHash, Date.now()),
      db.prepare("DELETE FROM account_oauth WHERE state_hash = ? AND browser_hash = ?").bind(stateHash, browserHash),
    ]);
    return result[0]!.results.length === 1;
  }

  async subscribe(accountId: string, capability: string): Promise<Subscription> {
    const db = this.db.withSession("first-primary");
    await db.prepare(`INSERT INTO thread_subscriptions(account_id, thread_id, provider, publisher_key, requested_revision)
      SELECT a.id, t.id, a.provider, ?, t.revision FROM accounts a CROSS JOIN threads t
      WHERE a.id = ? AND t.public_capability = ?
      ON CONFLICT(account_id, thread_id) DO UPDATE SET connected = 1,
      requested_revision = excluded.requested_revision, status = 'pending', blocked_reason = NULL,
      failure_code = NULL, updated_at = datetime('now') WHERE thread_subscriptions.connected = 0`)
      .bind(crypto.randomUUID(), accountId, capability).run();
    const row = await db.prepare(`${subscriptionSelect} WHERE s.account_id = ? AND t.public_capability = ?`)
      .bind(accountId, capability).first<SubscriptionRow>();
    if (!row) throw new ThreadError(404, "not_found", "Account or Thread not found.");
    return { ...row, connected: row.connected === 1 };
  }

  async subscription(accountId: string, capability: string): Promise<Subscription | null> {
    const row = await this.db.withSession("first-primary").prepare(`${subscriptionSelect} WHERE s.account_id = ? AND t.public_capability = ?`)
      .bind(accountId, capability).first<SubscriptionRow>();
    return row ? { ...row, connected: row.connected === 1 } : null;
  }

  async subscriptions(accountId: string): Promise<Subscription[]> {
    const { results } = await this.db.withSession("first-primary").prepare(`${subscriptionSelect} WHERE s.account_id = ? ORDER BY s.created_at DESC, s.thread_id DESC`)
      .bind(accountId).all<SubscriptionRow>();
    return results.map(row => ({ ...row, connected: row.connected === 1 }));
  }

  async retry(accountId: string, capability: string): Promise<void> {
    await this.db.withSession("first-primary").prepare(`UPDATE thread_subscriptions SET status = 'pending',
      blocked_reason = NULL, failure_code = NULL, updated_at = datetime('now')
      WHERE account_id = ? AND connected = 1 AND status != 'synced'
      AND thread_id = (SELECT id FROM threads WHERE public_capability = ?)`)
      .bind(accountId, capability).run();
  }

  async unsubscribe(accountId: string, capability: string): Promise<void> {
    await this.db.withSession("first-primary").prepare(`UPDATE thread_subscriptions SET connected = 0, updated_at = datetime('now')
      WHERE account_id = ? AND thread_id = (SELECT id FROM threads WHERE public_capability = ?)`)
      .bind(accountId, capability).run();
  }
}
