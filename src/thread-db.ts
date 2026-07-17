import {
  THREAD_ACTIVE_CONTRIBUTION_LIMIT,
  createThreadCapabilities,
  normalizeRequestKey,
  normalizeThreadTitle,
  type SourceProvider,
} from "./thread.js";

interface ThreadRow {
  id: number;
  public_capability: string;
  management_digest: string;
  title: string;
  closed_at: string | null;
  created_at: string;
}

interface ThreadContributionRow {
  id: number;
  thread_id: number;
  link_slug: string;
  request_key: string;
  input_fingerprint: string;
  source_provider: SourceProvider;
  source_catalog_id: string;
  source_storefront: string;
  position: number;
  removed_at: string | null;
  created_at: string;
}

export interface ThreadRecord {
  id: number;
  publicCapability: string;
  title: string;
  closedAt: string | null;
  createdAt: string;
}

export interface ThreadContribution {
  id: number;
  threadId: number;
  linkSlug: string;
  requestKey: string;
  inputFingerprint: string;
  sourceProvider: SourceProvider;
  sourceCatalogId: string;
  sourceStorefront: string;
  position: number;
  removedAt: string | null;
  createdAt: string;
}

export interface AcceptContributionInput {
  linkSlug: string;
  requestKey: string;
  inputFingerprint: string;
  sourceProvider: SourceProvider;
  sourceCatalogId: string;
  sourceStorefront: string;
}

export type CreateThreadResult =
  | {
      status: "created";
      thread: ThreadRecord;
      managementCapability: string;
    }
  | { status: "limit_reached" };

export type AcceptContributionResult =
  | { status: "accepted"; contribution: ThreadContribution }
  | { status: "existing"; contribution: ThreadContribution }
  | { status: "conflict" }
  | { status: "full" }
  | { status: "closed" }
  | { status: "not_found" };

export type RemoveContributionResult =
  | { status: "removed"; contribution: ThreadContribution }
  | { status: "not_found" };

export type CloseThreadResult =
  | { status: "closed"; thread: ThreadRecord }
  | { status: "not_found" };

export interface ThreadView {
  thread: ThreadRecord;
  contributions: ThreadContribution[];
}

export interface ThreadStoreOptions {
  maxThreads: number;
}

export class D1ThreadStore {
  private readonly maxThreads: number;

  constructor(
    private readonly db: D1Database,
    options: ThreadStoreOptions,
  ) {
    if (!Number.isSafeInteger(options.maxThreads) || options.maxThreads < 1) {
      throw new Error("maxThreads must be a positive integer");
    }
    this.maxThreads = options.maxThreads;
  }

  async create(title: string): Promise<CreateThreadResult> {
    const normalizedTitle = normalizeThreadTitle(title);
    const capabilities = await createThreadCapabilities();
    const db = this.db.withSession("first-primary");
    const row = await db
      .prepare(
        `INSERT INTO threads (public_capability, management_digest, title)
         SELECT ?, ?, ?
         WHERE (SELECT COUNT(*) FROM threads) < ?
         RETURNING *`,
      )
      .bind(
        capabilities.publicCapability,
        capabilities.managementDigest,
        normalizedTitle,
        this.maxThreads,
      )
      .first<ThreadRow>();

    if (!row) return { status: "limit_reached" };
    return {
      status: "created",
      thread: mapThread(row),
      managementCapability: capabilities.managementCapability,
    };
  }

  async getByManagementDigest(
    publicCapability: string,
    managementDigest: string,
  ): Promise<ThreadRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM threads
         WHERE public_capability = ? AND management_digest = ?`,
      )
      .bind(publicCapability, managementDigest)
      .first<ThreadRow>();
    return row ? mapThread(row) : null;
  }

  async getActive(publicCapability: string): Promise<ThreadView | null> {
    const db = this.db.withSession("first-primary");
    const thread = await db
      .prepare("SELECT * FROM threads WHERE public_capability = ?")
      .bind(publicCapability)
      .first<ThreadRow>();
    if (!thread) return null;

    const result = await db
      .prepare(
        `SELECT * FROM thread_contributions
         WHERE thread_id = ? AND removed_at IS NULL
         ORDER BY position`,
      )
      .bind(thread.id)
      .all<ThreadContributionRow>();
    return {
      thread: mapThread(thread),
      contributions: result.results.map(mapContribution),
    };
  }

  async acceptContribution(
    publicCapability: string,
    input: AcceptContributionInput,
  ): Promise<AcceptContributionResult> {
    const requestKey = normalizeRequestKey(input.requestKey);
    const db = this.db.withSession("first-primary");
    const inserted = await db
      .prepare(
        `INSERT INTO thread_contributions
           (thread_id, link_slug, request_key, input_fingerprint, source_provider,
            source_catalog_id, source_storefront, position)
         SELECT t.id, ?, ?, ?, ?, ?, ?,
                COALESCE((
                  SELECT MAX(existing.position)
                  FROM thread_contributions existing
                  WHERE existing.thread_id = t.id
                ), 0) + 1
         FROM threads t
         WHERE t.public_capability = ?
           AND t.closed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM thread_contributions existing
             WHERE existing.thread_id = t.id AND existing.request_key = ?
           )
           AND (
             SELECT COUNT(*) FROM thread_contributions active
             WHERE active.thread_id = t.id AND active.removed_at IS NULL
           ) < ?
         RETURNING *`,
      )
      .bind(
        input.linkSlug,
        requestKey,
        input.inputFingerprint,
        input.sourceProvider,
        input.sourceCatalogId,
        input.sourceStorefront,
        publicCapability,
        requestKey,
        THREAD_ACTIVE_CONTRIBUTION_LIMIT,
      )
      .first<ThreadContributionRow>();

    if (inserted) {
      return { status: "accepted", contribution: mapContribution(inserted) };
    }

    const thread = await db
      .prepare("SELECT * FROM threads WHERE public_capability = ?")
      .bind(publicCapability)
      .first<ThreadRow>();
    if (!thread) return { status: "not_found" };

    const existing = await db
      .prepare(
        `SELECT * FROM thread_contributions
         WHERE thread_id = ? AND request_key = ?`,
      )
      .bind(thread.id, requestKey)
      .first<ThreadContributionRow>();
    if (existing) {
      if (existing.input_fingerprint === input.inputFingerprint) {
        return { status: "existing", contribution: mapContribution(existing) };
      }
      return { status: "conflict" };
    }

    if (thread.closed_at !== null) return { status: "closed" };
    return { status: "full" };
  }

  async removeContribution(
    publicCapability: string,
    contributionId: number,
    managementDigest: string,
  ): Promise<RemoveContributionResult> {
    const row = await this.db
      .withSession("first-primary")
      .prepare(
        `UPDATE thread_contributions
         SET removed_at = COALESCE(removed_at, datetime('now'))
         WHERE id = ? AND thread_id = (
           SELECT id FROM threads
           WHERE public_capability = ? AND management_digest = ?
         )
         RETURNING *`,
      )
      .bind(contributionId, publicCapability, managementDigest)
      .first<ThreadContributionRow>();
    return row
      ? { status: "removed", contribution: mapContribution(row) }
      : { status: "not_found" };
  }

  async close(
    publicCapability: string,
    managementDigest: string,
  ): Promise<CloseThreadResult> {
    const row = await this.db
      .withSession("first-primary")
      .prepare(
        `UPDATE threads
         SET closed_at = COALESCE(closed_at, datetime('now'))
         WHERE public_capability = ? AND management_digest = ?
         RETURNING *`,
      )
      .bind(publicCapability, managementDigest)
      .first<ThreadRow>();
    return row ? { status: "closed", thread: mapThread(row) } : { status: "not_found" };
  }
}

function mapThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    publicCapability: row.public_capability,
    title: row.title,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

function mapContribution(row: ThreadContributionRow): ThreadContribution {
  return {
    id: row.id,
    threadId: row.thread_id,
    linkSlug: row.link_slug,
    requestKey: row.request_key,
    inputFingerprint: row.input_fingerprint,
    sourceProvider: row.source_provider,
    sourceCatalogId: row.source_catalog_id,
    sourceStorefront: row.source_storefront,
    position: row.position,
    removedAt: row.removed_at,
    createdAt: row.created_at,
  };
}
