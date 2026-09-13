export type HistoryOwner = { accountId: string | null; browserDigest: string | null };
export type ThreadHistoryEntry = { capability: string; title: string; createdAt: string; closedAt: string | null; songCount: number };

export class D1ThreadHistoryStore {
  constructor(private readonly db: D1Database) {}

  async remember(capability: string, owner: HistoryOwner): Promise<void> {
    if (!owner.accountId && !owner.browserDigest) throw new Error("history_owner_required");
    await this.db.withSession("first-primary").prepare(`INSERT OR IGNORE INTO thread_history(owner_key, thread_id, account_id, browser_digest)
      SELECT ?, id, ?, ? FROM threads WHERE public_capability = ?`)
      .bind(owner.accountId ? `account:${owner.accountId}` : `browser:${owner.browserDigest}`, owner.accountId,
        owner.accountId ? null : owner.browserDigest, capability).run();
  }

  async list(owner: HistoryOwner): Promise<ThreadHistoryEntry[]> {
    const { results } = await this.db.withSession("first-primary").prepare(`SELECT t.public_capability AS capability, t.title,
      t.created_at AS createdAt, t.closed_at AS closedAt,
      (SELECT COUNT(*) FROM thread_contributions c WHERE c.thread_id = t.id AND c.removed_at IS NULL) AS songCount
      FROM threads t WHERE EXISTS (SELECT 1 FROM thread_history h WHERE h.thread_id = t.id
        AND (h.account_id = ? OR h.browser_digest = ?))
      ORDER BY t.created_at DESC, t.id DESC`)
      .bind(owner.accountId, owner.browserDigest).all<ThreadHistoryEntry>();
    return results;
  }

  async saveBrowserHistory(accountId: string, browserDigest: string): Promise<void> {
    await this.db.withSession("first-primary").prepare(`INSERT OR IGNORE INTO thread_history(owner_key, thread_id, account_id)
      SELECT ?, thread_id, ? FROM thread_history WHERE browser_digest = ?`)
      .bind(`account:${accountId}`, accountId, browserDigest).run();
  }
}
