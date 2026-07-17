import {
  THREAD_ACTIVE_CONTRIBUTION_LIMIT,
  createThreadCapabilities,
  normalizeRequestKey,
  normalizeThreadTitle,
  type SourceProvider,
} from "./thread.js";
import type { ManagementAuthorization } from "./thread-security.js";

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

interface ThreadPageRow {
  thread_id: number;
  public_capability: string;
  title: string;
  closed_at: string | null;
  thread_created_at: string;
  contribution_id: number | null;
  link_slug: string | null;
  position: number | null;
  link_title: string | null;
  link_artist: string | null;
  artwork_url: string | null;
}

interface ContributionClassificationRow {
  closed_at: string | null;
  contribution_id: number | null;
  thread_id: number | null;
  link_slug: string | null;
  request_key: string | null;
  input_fingerprint: string | null;
  source_provider: SourceProvider | null;
  source_catalog_id: string | null;
  source_storefront: string | null;
  position: number | null;
  removed_at: string | null;
  contribution_created_at: string | null;
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

export interface ThreadPageContribution {
  id: number;
  linkSlug: string;
  position: number;
  title: string;
  artist: string;
  artworkUrl: string | null;
}

export interface ThreadPageView {
  thread: ThreadRecord;
  contributions: ThreadPageContribution[];
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

  async getManagementDigest(publicCapability: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT management_digest FROM threads WHERE public_capability = ?")
      .bind(publicCapability)
      .first<{ management_digest: string }>();
    return row?.management_digest ?? null;
  }

  async getView(publicCapability: string): Promise<ThreadView | null> {
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

  async getPageView(publicCapability: string): Promise<ThreadPageView | null> {
    const result = await this.db
      .withSession("first-primary")
      .prepare(
        `SELECT
           t.id AS thread_id,
           t.public_capability,
           t.title,
           t.closed_at,
           t.created_at AS thread_created_at,
           c.id AS contribution_id,
           c.link_slug,
           c.position,
           l.title AS link_title,
           l.artist AS link_artist,
           l.artwork_url
         FROM threads t
         LEFT JOIN thread_contributions c
           ON c.thread_id = t.id AND c.removed_at IS NULL
         LEFT JOIN links l ON l.slug = c.link_slug
         WHERE t.public_capability = ?
         ORDER BY c.position`,
      )
      .bind(publicCapability)
      .all<ThreadPageRow>();
    const [first] = result.results;
    if (!first) return null;

    const contributions = result.results.flatMap((row) => {
      if (row.contribution_id === null) return [];
      if (
        row.link_slug === null ||
        row.position === null ||
        row.link_title === null ||
        row.link_artist === null
      ) {
        throw new Error("Thread contribution link is missing");
      }
      return [{
        id: row.contribution_id,
        linkSlug: row.link_slug,
        position: row.position,
        title: row.link_title,
        artist: row.link_artist,
        artworkUrl: row.artwork_url,
      }];
    });
    return {
      thread: {
        id: first.thread_id,
        publicCapability: first.public_capability,
        title: first.title,
        closedAt: first.closed_at,
        createdAt: first.thread_created_at,
      },
      contributions,
    };
  }

  async exists(publicCapability: string): Promise<boolean> {
    const row = await this.db
      .withSession("first-primary")
      .prepare("SELECT 1 AS found FROM threads WHERE public_capability = ?")
      .bind(publicCapability)
      .first<{ found: number }>();
    return row?.found === 1;
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

    const classification = await db
      .prepare(
        `SELECT
           t.closed_at,
           c.id AS contribution_id,
           c.thread_id,
           c.link_slug,
           c.request_key,
           c.input_fingerprint,
           c.source_provider,
           c.source_catalog_id,
           c.source_storefront,
           c.position,
           c.removed_at,
           c.created_at AS contribution_created_at
         FROM threads t
         LEFT JOIN thread_contributions c
           ON c.thread_id = t.id AND c.request_key = ?
         WHERE t.public_capability = ?`,
      )
      .bind(requestKey, publicCapability)
      .first<ContributionClassificationRow>();
    if (!classification) return { status: "not_found" };

    if (classification.contribution_id !== null) {
      const existing = classificationContribution(classification);
      if (existing.input_fingerprint === input.inputFingerprint) {
        return { status: "existing", contribution: mapContribution(existing) };
      }
      return { status: "conflict" };
    }

    if (classification.closed_at !== null) return { status: "closed" };
    return { status: "full" };
  }

  async removeContribution(
    authorization: ManagementAuthorization,
    contributionId: number,
  ): Promise<RemoveContributionResult> {
    const db = this.db.withSession("first-primary");
    const row = await db
      .prepare(
        `UPDATE thread_contributions
         SET removed_at = datetime('now')
         WHERE id = ? AND thread_id = (
           SELECT id FROM threads
           WHERE public_capability = ?
         )
           AND removed_at IS NULL
         RETURNING *`,
      )
      .bind(contributionId, authorization.publicCapability)
      .first<ThreadContributionRow>();
    if (row) return { status: "removed", contribution: mapContribution(row) };
    const existing = await db
      .prepare(
        `SELECT c.* FROM thread_contributions c
         JOIN threads t ON t.id = c.thread_id
         WHERE c.id = ? AND t.public_capability = ?`,
      )
      .bind(contributionId, authorization.publicCapability)
      .first<ThreadContributionRow>();
    return existing
      ? { status: "removed", contribution: mapContribution(existing) }
      : { status: "not_found" };
  }

  async close(authorization: ManagementAuthorization): Promise<CloseThreadResult> {
    const db = this.db.withSession("first-primary");
    const row = await db
      .prepare(
        `UPDATE threads
         SET closed_at = datetime('now')
         WHERE public_capability = ? AND closed_at IS NULL
         RETURNING *`,
      )
      .bind(authorization.publicCapability)
      .first<ThreadRow>();
    if (row) return { status: "closed", thread: mapThread(row) };
    const existing = await db
      .prepare("SELECT * FROM threads WHERE public_capability = ?")
      .bind(authorization.publicCapability)
      .first<ThreadRow>();
    return existing
      ? { status: "closed", thread: mapThread(existing) }
      : { status: "not_found" };
  }
}

function classificationContribution(row: ContributionClassificationRow): ThreadContributionRow {
  if (
    row.contribution_id === null ||
    row.thread_id === null ||
    row.link_slug === null ||
    row.request_key === null ||
    row.input_fingerprint === null ||
    row.source_provider === null ||
    row.source_catalog_id === null ||
    row.source_storefront === null ||
    row.position === null ||
    row.contribution_created_at === null
  ) {
    throw new Error("Contribution classification is incomplete");
  }
  return {
    id: row.contribution_id,
    thread_id: row.thread_id,
    link_slug: row.link_slug,
    request_key: row.request_key,
    input_fingerprint: row.input_fingerprint,
    source_provider: row.source_provider,
    source_catalog_id: row.source_catalog_id,
    source_storefront: row.source_storefront,
    position: row.position,
    removed_at: row.removed_at,
    created_at: row.contribution_created_at,
  };
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
