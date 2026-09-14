import { customAlphabet, nanoid } from "nanoid";
import type { Resolved } from "./resolve.js";
import type { ParsedTrack, Provider } from "./urls.js";
import { isManagementAuthorization, type ManagementAuthorization } from "./thread-security.js";
import {
  THREAD_ACTIVE_LIMIT, THREAD_TOTAL_LIMIT, THREAD_MUTATION_LIMIT, THREAD_CREATION_LIMIT,
  ThreadError, desiredState, isThreadCapability, mutationFingerprint, normalizeRequestKey,
  normalizeThreadTitle, sha256, validateRevision,
  type ManagementIntent, type MutationIntent, type MutationReceipt, type MutationRequest,
  type PublicationStatus, type ThreadContribution, type ThreadView,
} from "./thread.js";

const linkSlug = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 7);

interface SnapshotRow {
  public_capability: string;
  title: string;
  revision: number;
  closed_at: string | null;
  created_at: string;
  total_contributions: number;
  songs: string;
  publications: string;
}

export interface StoredThreadContribution {
  id: number;
  linkSlug: string;
  position: number;
  removedAt: string | null;
}

export class D1ThreadStore {
  constructor(private readonly db: D1Database) {}

  async isReady(): Promise<boolean> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM threads")
      .first<{ count: number }>();
    return typeof row?.count === "number";
  }

  async create(rawTitle: string, creationKey: string): Promise<ThreadView> {
    const title = normalizeThreadTitle(rawTitle);
    if (!isThreadCapability(creationKey)) throw new ThreadError(400, "invalid_key", "Send a valid creation key.");
    const digest = await sha256(creationKey);
    let capability = nanoid(22);
    while (capability === creationKey) capability = nanoid(22);
    const db = this.db.withSession("first-primary");
    await db.batch([
      db.prepare(`INSERT INTO threads(public_capability, management_digest, title)
        SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM thread_creations WHERE request_digest = ?)
        AND (SELECT COUNT(*) FROM threads) < ?`).bind(capability, digest, title, digest, THREAD_CREATION_LIMIT),
      db.prepare(`INSERT INTO thread_creations(request_digest, thread_id)
        SELECT ?, id FROM threads WHERE public_capability = ?`).bind(digest, capability),
    ]);
    const created = await db.prepare(`SELECT t.public_capability, t.title FROM threads t
      JOIN thread_creations c ON c.thread_id = t.id WHERE c.request_digest = ?`)
      .bind(digest).first<{ public_capability: string; title: string }>();
    if (!created) throw new ThreadError(503, "creation_limit", "Thread creation is unavailable. Try again later.");
    if (created.title !== title) throw new ThreadError(409, "request_conflict", "This creation key was already used for a different title.");
    return (await this.get(created.public_capability))!;
  }

  async getManagementDigest(capability: string): Promise<string | null> {
    return this.db.withSession("first-primary").prepare("SELECT management_digest FROM threads WHERE public_capability = ?")
      .bind(capability).first<string>("management_digest");
  }

  async get(capability: string): Promise<ThreadView | null> {
    if (!isThreadCapability(capability)) return null;
    const row = await this.db.withSession("first-primary").prepare(`SELECT
      t.public_capability, t.title, t.revision, t.closed_at, t.created_at,
      (SELECT COUNT(*) FROM thread_contributions history WHERE history.thread_id = t.id) AS total_contributions,
      (SELECT json_group_array(json_patch(json_object('id', s.id, 'title', s.title, 'artist', s.artist,
        'artworkUrl', s.artwork_url, 'linkSlug', s.link_slug,
        'addedBy', CASE
          WHEN s.added_by_participant_public_id IS NOT NULL THEN json_object(
            'participantId', s.participant_public_id,
            'displayName', COALESCE(s.participant_name, 'Guest'),
            'avatarUrl', s.participant_avatar)
          WHEN s.added_by_account_id IS NOT NULL THEN json_object(
            'displayName', COALESCE(s.author_name, 'Listener'), 'avatarUrl', s.author_avatar)
          ELSE NULL END,
        'source', json_object('provider', s.source_provider, 'id', s.source_catalog_id,
        'storefront', s.source_storefront, 'verified', json(CASE s.source_verified WHEN 1 THEN 'true' ELSE 'false' END))),
        COALESCE((SELECT json_object('counterpart', json_object('provider', i.provider, 'id', i.catalog_id,
          'storefront', i.storefront, 'confirmed', json('true'))) FROM thread_identities i WHERE i.contribution_id = s.id), '{}')))
       FROM (SELECT c.*, l.title, l.artist, l.artwork_url,
           p.display_name AS author_name, p.avatar_url AS author_avatar,
           participant.public_id AS participant_public_id,
           participant.display_name AS participant_name,
           participant_profile.avatar_url AS participant_avatar
         FROM thread_contributions c JOIN links l ON l.slug = c.link_slug
         LEFT JOIN accounts a ON a.id = c.added_by_account_id
         LEFT JOIN account_profiles p ON p.group_id = a.group_id
         LEFT JOIN thread_collaboration_participants participant
           ON participant.public_id = c.added_by_participant_public_id
             AND participant.thread_id = c.thread_id
         LEFT JOIN accounts participant_account ON participant_account.id = participant.account_id
         LEFT JOIN account_profiles participant_profile
           ON participant_profile.group_id = participant_account.group_id
         WHERE c.thread_id = t.id AND c.removed_at IS NULL
         ORDER BY c.sort_order, c.position, c.id) s) AS songs,
      (SELECT json_group_array(json_object('provider', p.provider, 'requestedRevision', p.requested_revision,
        'appliedRevision', p.applied_revision, 'status', p.status, 'blockedReason', p.blocked_reason,
        'failureCode', p.failure_code, 'verifiedPlaylistId', p.verified_playlist_id,
        'connected', json(CASE p.connected WHEN 1 THEN 'true' ELSE 'false' END),
        'serviceOwned', json(CASE p.service_owned WHEN 1 THEN 'true' ELSE 'false' END),
        'editLocked', json(CASE p.edit_locked WHEN 1 THEN 'true' ELSE 'false' END),
        'verifiedPlaylistUrl', p.verified_playlist_url))
       FROM thread_publications p WHERE p.thread_id = t.id) AS publications
      FROM threads t WHERE t.public_capability = ?`).bind(capability).first<SnapshotRow>();
    if (!row) return null;
    const contributions: ThreadContribution[] = JSON.parse(row.songs);
    const publications: PublicationStatus[] = JSON.parse(row.publications);
    const matches = await this.db.withSession("first-primary").prepare(`SELECT DISTINCT m.contribution_id,
      m.provider, m.storefront, m.status, m.result_json FROM automatic_track_matches m
      JOIN thread_contributions c ON c.id = m.contribution_id JOIN threads t ON t.id = c.thread_id
      WHERE t.public_capability = ? AND c.removed_at IS NULL`).bind(capability)
      .all<{ contribution_id: number; provider: Provider; storefront: string; status: "matched" | "ambiguous" | "unavailable"; result_json: string }>();
    for (const match of matches.results) {
      const song = contributions.find(song => song.id === match.contribution_id);
      if (!song) continue;
      const result = JSON.parse(match.result_json);
      const brief = (track: { id: string; title: string; artist: string }) => ({ id: track.id, title: track.title, artist: track.artist });
      (song.matches ??= []).push({ provider: match.provider, storefront: match.storefront, status: match.status,
        method: result.method, selected: result.selected ? brief(result.selected) : null, candidates: result.candidates.slice(0, 3).map(brief) });
    }
    return { publicCapability: row.public_capability, title: row.title, revision: row.revision,
      closedAt: row.closed_at, createdAt: row.created_at, totalContributions: row.total_contributions,
      contributions, publications };
  }

  async contributionByRequestKey(capability: string, rawKey: string): Promise<StoredThreadContribution | null> {
    if (!isThreadCapability(capability)) return null;
    const key = normalizeRequestKey(rawKey);
    const row = await this.db.withSession("first-primary").prepare(`SELECT c.id, c.link_slug,
      CASE WHEN c.removed_at IS NULL AND c.sort_order > 0 THEN c.sort_order ELSE c.position END AS position, c.removed_at
      FROM thread_contributions c JOIN threads t ON t.id = c.thread_id
      WHERE t.public_capability = ? AND c.request_key = ?`).bind(capability, key)
      .first<{ id: number; link_slug: string; position: number; removed_at: string | null }>();
    return row ? { id: row.id, linkSlug: row.link_slug, position: row.position, removedAt: row.removed_at } : null;
  }

  async contribution(capability: string, contributionId: number): Promise<StoredThreadContribution | null> {
    if (!isThreadCapability(capability) || !Number.isSafeInteger(contributionId) || contributionId < 1) return null;
    const row = await this.db.withSession("first-primary").prepare(`SELECT c.id, c.link_slug,
      CASE WHEN c.removed_at IS NULL AND c.sort_order > 0 THEN c.sort_order ELSE c.position END AS position, c.removed_at
      FROM thread_contributions c JOIN threads t ON t.id = c.thread_id
      WHERE t.public_capability = ? AND c.id = ?`).bind(capability, contributionId)
      .first<{ id: number; link_slug: string; position: number; removed_at: string | null }>();
    return row ? { id: row.id, linkSlug: row.link_slug, position: row.position, removedAt: row.removed_at } : null;
  }

  async getDesiredState(capability: string, provider: Provider) {
    const view = await this.get(capability);
    return view ? desiredState(view, provider) : null;
  }

  async preflight(capability: string, rawKey: string, fingerprint: string, expectedRevision: number): Promise<MutationReceipt | null> {
    const key = normalizeRequestKey(rawKey);
    validateRevision(expectedRevision);
    const row = await this.db.withSession("first-primary").prepare(`SELECT t.revision, t.closed_at,
      m.fingerprint, m.revision AS receipt_revision FROM threads t
      LEFT JOIN thread_mutations m ON m.thread_id = t.id AND m.request_key = ?
      WHERE t.public_capability = ?`).bind(key, capability)
      .first<{ revision: number; closed_at: string | null; fingerprint: string | null; receipt_revision: number | null }>();
    if (!row) throw new ThreadError(404, "not_found", "Thread not found.");
    if (row.receipt_revision !== null) {
      if (row.fingerprint !== fingerprint) throw new ThreadError(409, "request_conflict", "This request key was already used for a different change.");
      return { revision: row.receipt_revision, replayed: true };
    }
    if (row.closed_at !== null) throw new ThreadError(410, "closed", "This Thread is closed.");
    if (row.revision !== expectedRevision) throw new ThreadError(409, "stale_revision", "The Thread changed. Refresh and try again.");
    if (row.revision >= THREAD_MUTATION_LIMIT) throw new ThreadError(409, "mutation_limit", "This Thread has reached its edit limit.");
    return null;
  }

  async add(capability: string, request: MutationRequest & {
    source: ParsedTrack;
    track: Resolved;
    addedByAccountId?: string | null;
    addedByParticipantId?: string | null;
  }): Promise<MutationReceipt> {
    const { source, track } = request;
    const addedByAccountId = request.addedByAccountId ?? null;
    const addedByParticipantId = request.addedByParticipantId ?? null;
    if (addedByAccountId !== null && addedByParticipantId !== null) {
      throw new ThreadError(400, "invalid_participant", "A song can have only one contributor.");
    }
    if (addedByParticipantId !== null && !isThreadCapability(addedByParticipantId)) {
      throw new ThreadError(400, "invalid_participant", "Choose a valid joined participant.");
    }
    return this.mutate(capability, request, {
      kind: "add",
      source,
      addedByAccountId,
      addedByParticipantId,
    }, (db, token, fingerprint) => {
      const slug = linkSlug();
      return [
        db.prepare(`INSERT INTO links(slug, title, artist, artwork_url, spotify_url, apple_url, complete)
          SELECT ?, ?, ?, ?, ?, ?, 0 FROM threads WHERE public_capability = ? AND mutation_token = ?`)
          .bind(slug, track.title, track.artist, track.artworkUrl, source.provider === "spotify" ? track.spotifyUrl : null,
            source.provider === "apple" ? track.appleUrl : null, capability, token),
        db.prepare(`INSERT INTO thread_contributions(thread_id, link_slug, request_key, input_fingerprint,
          source_provider, source_catalog_id, source_storefront, position, sort_order, source_verified,
          added_by_account_id, added_by_participant_public_id)
          SELECT t.id, ?, ?, ?, ?, ?, ?,
            COALESCE((SELECT MAX(position) FROM thread_contributions WHERE thread_id = t.id), 0) + 1,
            COALESCE((SELECT MAX(sort_order) FROM thread_contributions WHERE thread_id = t.id AND removed_at IS NULL), 0) + 1,
            1, ?, ?
          FROM threads t WHERE t.public_capability = ? AND t.mutation_token = ?`)
          .bind(slug, normalizeRequestKey(request.requestKey), fingerprint, source.provider, source.id,
            source.storefront, addedByAccountId, addedByParticipantId, capability, token),
      ];
    });
  }

  async manage(authorization: ManagementAuthorization, request: MutationRequest & ManagementIntent): Promise<MutationReceipt> {
    if (!isManagementAuthorization(authorization)) throw new ThreadError(403, "forbidden", "Management access required.");
    const capability = authorization.publicCapability;
    return this.mutate(capability, request, request, (db, token) => {
      if (request.kind === "identify") return [db.prepare(`INSERT INTO thread_identities(contribution_id, provider, catalog_id, storefront)
        SELECT c.id, ?, ?, ? FROM thread_contributions c JOIN threads t ON t.id = c.thread_id
        WHERE c.id = ? AND t.public_capability = ? AND t.mutation_token = ?`)
        .bind(request.identity.provider, request.identity.id, request.identity.storefront, request.id, capability, token)];
      if (request.kind === "connect") return [db.prepare(`UPDATE thread_publications SET connected = 1,
        edit_locked = CASE WHEN provider = 'apple' THEN 1 ELSE edit_locked END,
        status = 'pending', blocked_reason = NULL, failure_code = NULL, next_attempt_at = 0
        WHERE provider = ? AND thread_id = (SELECT id FROM threads WHERE public_capability = ? AND mutation_token = ?)`)
        .bind(request.provider, capability, token)];
      if (request.kind === "close") return [db.prepare("UPDATE threads SET closed_at = datetime('now') WHERE public_capability = ? AND mutation_token = ?").bind(capability, token)];
      if (request.kind === "remove") return [db.prepare(`UPDATE thread_contributions SET removed_at = datetime('now')
        WHERE id = ? AND thread_id = (SELECT id FROM threads WHERE public_capability = ? AND mutation_token = ?)`)
        .bind(request.id, capability, token)];
      return [db.prepare(`UPDATE thread_contributions SET sort_order =
        (SELECT CAST(key AS INTEGER) + 1 FROM json_each(?) WHERE value = thread_contributions.id)
        WHERE removed_at IS NULL AND thread_id = (SELECT id FROM threads WHERE public_capability = ? AND mutation_token = ?)`)
        .bind(JSON.stringify(request.ids), capability, token)];
    });
  }

  private async mutate(
    capability: string,
    request: MutationRequest,
    intent: MutationIntent,
    statements: (db: D1DatabaseSession, token: string, fingerprint: string) => D1PreparedStatement[],
  ): Promise<MutationReceipt> {
    const key = normalizeRequestKey(request.requestKey);
    const fingerprint = await mutationFingerprint(intent);
    const replay = await this.preflight(capability, key, fingerprint, request.expectedRevision);
    if (replay) return replay;
    const view = (await this.get(capability))!;
    if (view.revision !== request.expectedRevision) {
      const raced = await this.preflight(capability, key, fingerprint, request.expectedRevision);
      if (raced) return raced;
      throw new ThreadError(409, "stale_revision", "The Thread changed. Refresh and try again.");
    }
    if ((intent.kind === "remove" || intent.kind === "reorder")
      && view.publications.some(p => p.provider === "apple" && p.connected && p.editLocked)) {
      throw new ThreadError(409, "apple_append_only", "Apple Music supports additions only. Remove and reorder are unavailable for this Thread.");
    }
    if (intent.kind === "connect" && view.publications.some(p => p.provider === intent.provider && p.connected)) {
      throw new ThreadError(409, "already_connected", "This music app is already connected.");
    }
    if (intent.kind === "reorder") {
      const activeIds = new Set(view.contributions.map(song => song.id));
      if (intent.ids.length !== activeIds.size || new Set(intent.ids).size !== activeIds.size || intent.ids.some(id => !activeIds.has(id))) {
        throw new ThreadError(400, "invalid_order", "Include every current song exactly once.");
      }
    }
    if (intent.kind === "remove" && !view.contributions.some(song => song.id === intent.id)) {
      throw new ThreadError(404, "contribution_not_found", "This song is not in the Thread.");
    }
    if (intent.kind === "identify") {
      const song = view.contributions.find(song => song.id === intent.id);
      if (!song) throw new ThreadError(404, "contribution_not_found", "This song is not in the Thread.");
      if (!song.source.verified) throw new ThreadError(422, "unverified_source", "This song's source catalog identity has not been verified.");
      const { provider, id, storefront } = intent.identity;
      if (provider === song.source.provider || !/^[a-z]{2}$/.test(storefront)
        || (provider === "spotify" ? !/^[A-Za-z0-9]{22}$/.test(id) || storefront !== "us" : provider !== "apple" || !/^[0-9]+$/.test(id))) {
        throw new ThreadError(400, "invalid_counterpart", "Choose a verified track from the other music app.");
      }
      if (song.counterpart) throw new ThreadError(409, "identity_already_confirmed", "This song already has a confirmed counterpart.");
    }
    if (intent.kind === "add" && view.contributions.length >= THREAD_ACTIVE_LIMIT) {
      throw new ThreadError(409, "full", `A Thread can contain up to ${THREAD_ACTIVE_LIMIT} songs.`);
    }
    const db = this.db.withSession("first-primary");
    const token = nanoid(22);
    const addCondition = intent.kind === "add" ? `AND (SELECT COUNT(*) FROM thread_contributions WHERE thread_id = threads.id) < ${THREAD_TOTAL_LIMIT}` : "";
    const editCondition = intent.kind === "remove" || intent.kind === "reorder"
      ? "AND NOT EXISTS (SELECT 1 FROM thread_publications WHERE thread_id = threads.id AND provider = 'apple' AND connected = 1 AND edit_locked = 1)" : "";
    const identityCondition = intent.kind === "identify" ? `AND EXISTS (
      SELECT 1 FROM thread_contributions c WHERE c.id = ? AND c.thread_id = threads.id
      AND c.removed_at IS NULL AND c.source_verified = 1 AND c.source_provider != ?
      AND NOT EXISTS (SELECT 1 FROM thread_identities i WHERE i.contribution_id = c.id))` : "";
    const identityBindings = intent.kind === "identify" ? [intent.id, intent.identity.provider] : [];
    const results = await db.batch([
      db.prepare(`UPDATE threads SET revision = revision + 1, mutation_token = ?
        WHERE public_capability = ? AND revision = ? AND closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM thread_mutations WHERE thread_id = threads.id AND request_key = ?)
        ${addCondition} ${editCondition} ${identityCondition} RETURNING revision`).bind(token, capability, request.expectedRevision, key, ...identityBindings),
      ...statements(db, token, fingerprint),
      db.prepare(`INSERT INTO thread_mutations(thread_id, request_key, fingerprint, revision)
        SELECT id, ?, ?, revision FROM threads WHERE public_capability = ? AND mutation_token = ?`)
        .bind(key, fingerprint, capability, token),
    ]);
    if (results[0]?.results.length === 1) return { revision: request.expectedRevision + 1, replayed: false };
    const raced = await this.preflight(capability, key, fingerprint, request.expectedRevision);
    if (raced) return raced;
    if (intent.kind === "identify") throw new ThreadError(409, "identity_conflict", "This song changed. Refresh and try again.");
    throw new ThreadError(409, "contribution_limit", "This Thread has reached its contribution limit.");
  }
}
