import { normalizeProfile, type PublicProfile } from './profile.js';
import { ThreadError } from './thread.js';

export class D1ProfileStore {
  constructor(private readonly db: D1Database) {}

  private async ensure(accountId: string): Promise<void> {
    await this.db.withSession('first-primary').prepare(`INSERT OR IGNORE INTO account_profiles(group_id)
      SELECT group_id FROM accounts WHERE id = ?`).bind(accountId).run();
  }

  async get(accountId: string): Promise<PublicProfile> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT
      COALESCE(p.display_name, 'Listener') AS displayName, p.avatar_url AS avatarUrl
      FROM accounts a LEFT JOIN account_profiles p ON p.group_id = a.group_id WHERE a.id = ?`)
      .bind(accountId).first<PublicProfile>();
    if (!row) throw new ThreadError(401, 'sign_in_required', 'Sign in to your music account first.');
    return row;
  }

  async seed(accountId: string, value: PublicProfile): Promise<void> {
    const profile = normalizeProfile(value);
    await this.ensure(accountId);
    await this.db.withSession('first-primary').prepare(`UPDATE account_profiles SET display_name = ?, avatar_url = ?,
      seeded = 1, updated_at = datetime('now') WHERE group_id = (SELECT group_id FROM accounts WHERE id = ?)
      AND customized = 0 AND seeded = 0`).bind(profile.displayName, profile.avatarUrl, accountId).run();
  }

  async update(accountId: string, value: { displayName: unknown; avatarUrl: unknown }): Promise<PublicProfile> {
    const profile = normalizeProfile(value);
    await this.ensure(accountId);
    const db = this.db.withSession('first-primary');
    await db.batch([
      db.prepare(`UPDATE account_profiles SET display_name = ?, avatar_url = ?,
        customized = 1, updated_at = datetime('now') WHERE group_id = (SELECT group_id FROM accounts WHERE id = ?)`)
        .bind(profile.displayName, profile.avatarUrl, accountId),
      db.prepare(`DELETE FROM profile_photos WHERE group_id = (SELECT group_id FROM accounts WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM account_profiles p WHERE substr(p.avatar_url, -length('/profile-photos/' || profile_photos.id)) = '/profile-photos/' || profile_photos.id)`)
        .bind(accountId),
    ]);
    return this.get(accountId);
  }

  async updatePhoto(accountId: string, displayName: unknown, bytes: Uint8Array, baseUrl: string): Promise<PublicProfile> {
    const id = crypto.randomUUID();
    const profile = normalizeProfile({ displayName, avatarUrl: `${baseUrl}/profile-photos/${id}` });
    await this.ensure(accountId);
    const db = this.db.withSession('first-primary');
    await db.batch([
      db.prepare(`INSERT INTO profile_photos(group_id, id, bytes)
        SELECT group_id, ?, ? FROM accounts WHERE id = ?
        ON CONFLICT(group_id) DO UPDATE SET id = excluded.id, bytes = excluded.bytes`)
        .bind(id, bytes.slice().buffer, accountId),
      db.prepare(`UPDATE account_profiles SET display_name = ?, avatar_url = ?, customized = 1,
        updated_at = datetime('now') WHERE group_id = (SELECT group_id FROM accounts WHERE id = ?)`)
        .bind(profile.displayName, profile.avatarUrl, accountId),
    ]);
    return this.get(accountId);
  }

  async photo(id: string): Promise<Uint8Array | null> {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const row = await this.db.withSession('first-primary').prepare('SELECT bytes FROM profile_photos WHERE id = ?')
      .bind(id).first<{ bytes: number[] }>();
    return row ? new Uint8Array(row.bytes) : null;
  }

  async claimSeed(accountId: string): Promise<boolean> {
    await this.ensure(accountId);
    const row = await this.db.withSession('first-primary').prepare(`UPDATE account_profiles SET seed_attempt_at = ?
      WHERE group_id = (SELECT group_id FROM accounts WHERE id = ?) AND customized = 0 AND seeded = 0
      AND seed_attempt_at < ? RETURNING group_id`).bind(Date.now(), accountId, Date.now() - 3600000).first();
    return row !== null;
  }
}
