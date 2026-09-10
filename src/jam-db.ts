import {
  JAM_ACTIVE_CONTRIBUTION_LIMIT,
  JAM_TOTAL_CONTRIBUTION_LIMIT,
  createJamCapabilities,
  isJamCapability,
  normalizeJamRequestKey,
  normalizeJamTitle,
  type JamManagementAuthorization,
  type JamSourceProvider,
} from "./jam.js";

interface JamRow {
  id: number;
  public_capability: string;
  management_digest: string;
  title: string;
  closed_at: string | null;
  created_at: string;
}

interface JamContributionRow {
  id: number;
  thread_id: number;
  link_slug: string;
  request_key: string;
  input_fingerprint: string;
  source_provider: JamSourceProvider;
  source_catalog_id: string;
  source_storefront: string;
  position: number;
  removed_at: string | null;
  created_at: string;
}

interface JamViewRow {
  jam_id: number;
  public_capability: string;
  title: string;
  closed_at: string | null;
  jam_created_at: string;
  total_contributions: number;
  contribution_id: number | null;
  link_slug: string | null;
  position: number | null;
  link_title: string | null;
  link_artist: string | null;
  artwork_url: string | null;
}

interface ContributionClassificationRow {
  closed_at: string | null;
  total_contributions: number;
  active_contributions: number;
  contribution_id: number | null;
  thread_id: number | null;
  link_slug: string | null;
  request_key: string | null;
  input_fingerprint: string | null;
  source_provider: JamSourceProvider | null;
  source_catalog_id: string | null;
  source_storefront: string | null;
  position: number | null;
  removed_at: string | null;
  contribution_created_at: string | null;
}

export interface JamRecord {
  id: number;
  publicCapability: string;
  title: string;
  closedAt: string | null;
  createdAt: string;
}

export interface JamContribution {
  id: number;
  jamId: number;
  linkSlug: string;
  requestKey: string;
  inputFingerprint: string;
  sourceProvider: JamSourceProvider;
  sourceCatalogId: string;
  sourceStorefront: string;
  position: number;
  removedAt: string | null;
  createdAt: string;
}

export interface AcceptJamContributionInput {
  linkSlug: string;
  requestKey: string;
  inputFingerprint: string;
  sourceProvider: JamSourceProvider;
  sourceCatalogId: string;
  sourceStorefront: string;
}

export interface JamViewContribution {
  id: number;
  linkSlug: string;
  position: number;
  title: string;
  artist: string;
  artworkUrl: string | null;
}

export interface JamView {
  jam: JamRecord;
  contributions: JamViewContribution[];
  totalContributions: number;
  contributionLimit: number;
}

export type CreateJamResult =
  | {
      status: "created";
      jam: JamRecord;
      managementCapability: string;
    }
  | { status: "limit_reached" };

export type JamContributionPreflightResult =
  | { status: "continue" }
  | { status: "existing"; contribution: JamContribution }
  | { status: "conflict" }
  | { status: "full" }
  | { status: "closed" }
  | { status: "limit_reached" }
  | { status: "not_found" };

export type AcceptJamContributionResult =
  | { status: "accepted"; contribution: JamContribution }
  | { status: "existing"; contribution: JamContribution }
  | { status: "conflict" }
  | { status: "full" }
  | { status: "closed" }
  | { status: "limit_reached" }
  | { status: "not_found" };

export type RemoveJamContributionResult =
  | { status: "removed"; contribution: JamContribution }
  | { status: "not_found" };

export type CloseJamResult =
  | { status: "closed"; jam: JamRecord }
  | { status: "not_found" };

export interface JamStoreOptions {
  maxJams: number;
  maxContributionsPerJam?: number;
}

export interface JamStore {
  isReady(): Promise<boolean>;
  create(title: string): Promise<CreateJamResult>;
  getManagementDigest(publicCapability: string): Promise<string | null>;
  get(publicCapability: string): Promise<JamView | null>;
  preflightContribution(
    publicCapability: string,
    requestKey: string,
    inputFingerprint: string,
  ): Promise<JamContributionPreflightResult>;
  acceptContribution(
    publicCapability: string,
    input: AcceptJamContributionInput,
  ): Promise<AcceptJamContributionResult>;
  removeContribution(
    authorization: JamManagementAuthorization,
    contributionId: number,
  ): Promise<RemoveJamContributionResult>;
  close(authorization: JamManagementAuthorization): Promise<CloseJamResult>;
}

/**
 * Jams intentionally reuse the preserved `threads` tables from migration 0002.
 * The product name changed; the durable database contract did not.
 */
export class D1JamStore implements JamStore {
  private readonly maxJams: number;
  private readonly maxContributionsPerJam: number;

  constructor(
    private readonly db: D1Database,
    options: JamStoreOptions,
  ) {
    if (!Number.isSafeInteger(options.maxJams) || options.maxJams < 1) {
      throw new Error("maxJams must be a positive integer");
    }
    this.maxJams = options.maxJams;

    const maxContributionsPerJam =
      options.maxContributionsPerJam ?? JAM_TOTAL_CONTRIBUTION_LIMIT;
    if (
      !Number.isSafeInteger(maxContributionsPerJam) ||
      maxContributionsPerJam < 1 ||
      maxContributionsPerJam > JAM_TOTAL_CONTRIBUTION_LIMIT
    ) {
      throw new Error(
        `maxContributionsPerJam must be an integer between 1 and ${JAM_TOTAL_CONTRIBUTION_LIMIT}`,
      );
    }
    this.maxContributionsPerJam = maxContributionsPerJam;
  }

  async isReady(): Promise<boolean> {
    const result = await this.db
      .prepare("SELECT COUNT(*) AS count FROM threads")
      .first<{ count: number }>();
    return typeof result?.count === "number";
  }

  async create(title: string): Promise<CreateJamResult> {
    const normalizedTitle = normalizeJamTitle(title);
    const db = this.db.withSession("first-primary");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const capabilities = await createJamCapabilities();
      const row = await db
        .prepare(
          `INSERT OR IGNORE INTO threads (public_capability, management_digest, title)
           SELECT ?, ?, ?
           WHERE (SELECT COUNT(*) FROM threads) < ?
           RETURNING *`,
        )
        .bind(
          capabilities.publicCapability,
          capabilities.managementDigest,
          normalizedTitle,
          this.maxJams,
        )
        .first<JamRow>();

      if (row) {
        return {
          status: "created",
          jam: mapJam(row),
          managementCapability: capabilities.managementCapability,
        };
      }

      const count = await db
        .prepare("SELECT COUNT(*) AS count FROM threads")
        .first<{ count: number }>();
      if (typeof count?.count !== "number") {
        throw new Error("Jam count could not be read");
      }
      if (count.count >= this.maxJams) return { status: "limit_reached" };
    }

    throw new Error("Could not allocate unique Jam capabilities");
  }

  async getManagementDigest(publicCapability: string): Promise<string | null> {
    if (!isJamCapability(publicCapability)) return null;
    const row = await this.db
      .prepare("SELECT management_digest FROM threads WHERE public_capability = ?")
      .bind(publicCapability)
      .first<{ management_digest: string }>();
    return row?.management_digest ?? null;
  }

  async get(publicCapability: string): Promise<JamView | null> {
    if (!isJamCapability(publicCapability)) return null;
    const result = await this.db
      .withSession("first-primary")
      .prepare(
        `SELECT
           t.id AS jam_id,
           t.public_capability,
           t.title,
           t.closed_at,
           t.created_at AS jam_created_at,
           (SELECT COUNT(*) FROM thread_contributions history WHERE history.thread_id = t.id)
             AS total_contributions,
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
      .all<JamViewRow>();
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
        throw new Error("Jam contribution link is missing");
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
      jam: {
        id: first.jam_id,
        publicCapability: first.public_capability,
        title: first.title,
        closedAt: first.closed_at,
        createdAt: first.jam_created_at,
      },
      contributions,
      totalContributions: first.total_contributions,
      contributionLimit: this.maxContributionsPerJam,
    };
  }

  async preflightContribution(
    publicCapability: string,
    rawRequestKey: string,
    inputFingerprint: string,
  ): Promise<JamContributionPreflightResult> {
    if (!isJamCapability(publicCapability)) return { status: "not_found" };
    const requestKey = normalizeJamRequestKey(rawRequestKey);
    const classification = await this.classifyContribution(
      this.db.withSession("first-primary"),
      publicCapability,
      requestKey,
    );
    if (!classification) return { status: "not_found" };
    if (classification.contribution_id !== null) {
      const existing = mapContribution(classificationContribution(classification));
      return existing.inputFingerprint === inputFingerprint
        ? { status: "existing", contribution: existing }
        : { status: "conflict" };
    }
    if (classification.closed_at !== null) return { status: "closed" };
    if (classification.total_contributions >= this.maxContributionsPerJam) {
      return { status: "limit_reached" };
    }
    return classification.active_contributions >= JAM_ACTIVE_CONTRIBUTION_LIMIT
      ? { status: "full" }
      : { status: "continue" };
  }

  async acceptContribution(
    publicCapability: string,
    input: AcceptJamContributionInput,
  ): Promise<AcceptJamContributionResult> {
    if (!isJamCapability(publicCapability)) return { status: "not_found" };
    const requestKey = normalizeJamRequestKey(input.requestKey);
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
           AND (
             SELECT COUNT(*) FROM thread_contributions history
             WHERE history.thread_id = t.id
           ) < ?
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
        this.maxContributionsPerJam,
        requestKey,
        JAM_ACTIVE_CONTRIBUTION_LIMIT,
      )
      .first<JamContributionRow>();

    if (inserted) {
      return { status: "accepted", contribution: mapContribution(inserted) };
    }

    const classification = await this.classifyContribution(db, publicCapability, requestKey);
    if (!classification) return { status: "not_found" };
    if (classification.contribution_id !== null) {
      const existing = mapContribution(classificationContribution(classification));
      return existing.inputFingerprint === input.inputFingerprint
        ? { status: "existing", contribution: existing }
        : { status: "conflict" };
    }
    if (classification.closed_at !== null) return { status: "closed" };
    if (classification.total_contributions >= this.maxContributionsPerJam) {
      return { status: "limit_reached" };
    }
    return { status: "full" };
  }

  async removeContribution(
    authorization: JamManagementAuthorization,
    contributionId: number,
  ): Promise<RemoveJamContributionResult> {
    if (!Number.isSafeInteger(contributionId) || contributionId < 1) {
      return { status: "not_found" };
    }

    const db = this.db.withSession("first-primary");
    const row = await db
      .prepare(
        `UPDATE thread_contributions
         SET removed_at = datetime('now')
         WHERE id = ? AND thread_id = (
           SELECT id FROM threads WHERE public_capability = ?
         )
           AND removed_at IS NULL
         RETURNING *`,
      )
      .bind(contributionId, authorization.publicCapability)
      .first<JamContributionRow>();
    if (row) return { status: "removed", contribution: mapContribution(row) };

    const existing = await db
      .prepare(
        `SELECT c.* FROM thread_contributions c
         JOIN threads t ON t.id = c.thread_id
         WHERE c.id = ? AND t.public_capability = ?`,
      )
      .bind(contributionId, authorization.publicCapability)
      .first<JamContributionRow>();
    return existing
      ? { status: "removed", contribution: mapContribution(existing) }
      : { status: "not_found" };
  }

  async close(authorization: JamManagementAuthorization): Promise<CloseJamResult> {
    const db = this.db.withSession("first-primary");
    const row = await db
      .prepare(
        `UPDATE threads
         SET closed_at = datetime('now')
         WHERE public_capability = ? AND closed_at IS NULL
         RETURNING *`,
      )
      .bind(authorization.publicCapability)
      .first<JamRow>();
    if (row) return { status: "closed", jam: mapJam(row) };

    const existing = await db
      .prepare("SELECT * FROM threads WHERE public_capability = ?")
      .bind(authorization.publicCapability)
      .first<JamRow>();
    return existing
      ? { status: "closed", jam: mapJam(existing) }
      : { status: "not_found" };
  }

  private async classifyContribution(
    db: D1DatabaseSession,
    publicCapability: string,
    requestKey: string,
  ): Promise<ContributionClassificationRow | null> {
    return db
      .prepare(
        `SELECT
           t.closed_at,
           (
             SELECT COUNT(*) FROM thread_contributions history
             WHERE history.thread_id = t.id
           ) AS total_contributions,
           (
             SELECT COUNT(*) FROM thread_contributions active
             WHERE active.thread_id = t.id AND active.removed_at IS NULL
           ) AS active_contributions,
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
  }
}

function classificationContribution(row: ContributionClassificationRow): JamContributionRow {
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
    throw new Error("Jam contribution classification is incomplete");
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

function mapJam(row: JamRow): JamRecord {
  return {
    id: row.id,
    publicCapability: row.public_capability,
    title: row.title,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

function mapContribution(row: JamContributionRow): JamContribution {
  return {
    id: row.id,
    jamId: row.thread_id,
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
