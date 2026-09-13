import { nanoid } from "nanoid";
import { isManagementAuthorization, type ManagementAuthorization } from "./thread-security.js";
import { ThreadError } from "./thread.js";
import {
  THREAD_MESSAGE_LIMIT,
  THREAD_MESSAGE_MAX_LENGTH,
  THREAD_PARTICIPANT_LIMIT,
  THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT,
  THREAD_VOTE_REQUESTS_PER_THREAD_LIMIT,
  normalizeCollaborationMessage,
  normalizeCollaborationRequestKey,
  normalizeParticipantName,
  normalizeSnapshotOptions,
  validateCollaborationIdentity,
  validateCollaborationVoteRequest,
  type CollaborationIdentity,
  type CollaborationMessage,
  type CollaborationMessageRequest,
  type CollaborationParticipant,
  type CollaborationSnapshot,
  type CollaborationSnapshotOptions,
  type CollaborationVote,
  type CollaborationVoteRequest,
  type CollaborationVoteSummary,
} from "./thread-collaboration.js";

interface ThreadStateRow {
  id: number;
  closed_at: string | null;
  collaboration_revision: number;
}

interface ParticipantRow {
  id: number;
  thread_id: number;
  public_id: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
  closed_at: string | null;
}

interface MessageRow {
  id: number;
  body: string;
  deleted_at: string | null;
  created_at: string;
  participant_public_id: string;
  participant_name: string;
  participant_created_at: string;
  avatar_url: string | null;
}

interface MessageRequestRow extends MessageRow {
  request_key: string;
}

interface VoteRequestRow {
  contribution_id: number;
  vote: "up" | "down" | "clear";
}

interface VoteSummaryRow {
  contribution_id: number;
  upvotes: number;
  downvotes: number;
  score: number;
  my_vote: CollaborationVote | null;
}

type CanonicalIdentity = CollaborationIdentity;

export interface CollaborationJoinResult {
  participant: CollaborationParticipant;
  created: boolean;
}

export interface CollaborationMessageResult {
  message: CollaborationMessage;
  replayed: boolean;
}

export interface CollaborationVoteResult {
  vote: CollaborationVoteSummary;
  replayed: boolean;
}

export type CollaborationModerationResult = "removed" | "already_removed" | "not_found";

const participantSelection = `SELECT p.id, p.thread_id, p.public_id, p.display_name,
  profile.avatar_url, p.created_at, t.closed_at
  FROM thread_collaboration_participants p
  JOIN threads t ON t.id = p.thread_id
  LEFT JOIN accounts account ON account.id = p.account_id
  LEFT JOIN account_profiles profile ON profile.group_id = account.group_id`;

const messageSelection = `SELECT m.id, m.request_key, m.body, m.deleted_at, m.created_at,
  p.public_id AS participant_public_id, p.display_name AS participant_name,
  p.created_at AS participant_created_at, profile.avatar_url
  FROM thread_collaboration_messages m
  JOIN thread_collaboration_participants p ON p.id = m.participant_id
  LEFT JOIN accounts account ON account.id = p.account_id
  LEFT JOIN account_profiles profile ON profile.group_id = account.group_id`;

export class D1ThreadCollaborationStore {
  constructor(private readonly db: D1Database) {}

  async isReady(): Promise<boolean> {
    const row = await this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
        'thread_collaboration_state',
        'thread_collaboration_participants',
        'thread_collaboration_messages',
        'thread_collaboration_votes',
        'thread_collaboration_vote_requests'
      )) AS collaboration_tables,
      (SELECT COUNT(*) FROM pragma_table_info('thread_contributions')
        WHERE name = 'added_by_participant_public_id') AS attribution_columns,
      (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name IN (
        'thread_collaboration_vote_request_thread_limit',
        'thread_collaboration_vote_request_participant_limit'
      )) AS vote_limit_triggers`)
      .first<{
        collaboration_tables: number;
        attribution_columns: number;
        vote_limit_triggers: number;
      }>();
    return row?.collaboration_tables === 5
      && row.attribution_columns === 1
      && row.vote_limit_triggers === 2;
  }

  async join(
    capability: string,
    identity: CollaborationIdentity,
    rawDisplayName: string,
  ): Promise<CollaborationJoinResult> {
    const displayName = normalizeParticipantName(rawDisplayName);
    const canonical = await this.canonicalIdentity(identity);
    const db = this.db.withSession("first-primary");
    const existing = await this.findParticipant(db, capability, canonical);
    if (existing) {
      if (existing.display_name === displayName) {
        return { participant: publicParticipant(existing), created: false };
      }
      if (existing.closed_at !== null) throw closedError();
      const renamed = await db
        .prepare(`UPDATE thread_collaboration_participants SET display_name = ?, updated_at = datetime('now')
          WHERE id = ? AND EXISTS (
            SELECT 1 FROM threads WHERE id = thread_collaboration_participants.thread_id AND closed_at IS NULL
          ) RETURNING id`)
        .bind(displayName, existing.id)
        .first<{ id: number }>();
      if (!renamed) throw closedError();
      const current = await this.findParticipant(db, capability, canonical);
      if (!current) throw new Error("Renamed participant could not be read");
      return { participant: publicParticipant(current), created: false };
    }

    const state = await this.threadState(db, capability);
    if (!state) throw notFoundError();
    if (state.closed_at !== null) throw closedError();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const publicId = nanoid(22);
      const inserted = canonical.kind === "anonymous"
        ? await db.prepare(`INSERT OR IGNORE INTO thread_collaboration_participants
            (thread_id, public_id, display_name, anonymous_digest)
          SELECT t.id, ?, ?, ? FROM threads t
          WHERE t.public_capability = ? AND t.closed_at IS NULL
            AND (SELECT COUNT(*) FROM thread_collaboration_participants existing
              WHERE existing.thread_id = t.id) < ?
          RETURNING id`)
          .bind(publicId, displayName, canonical.digest, capability, THREAD_PARTICIPANT_LIMIT)
          .first<{ id: number }>()
        : await db.prepare(`INSERT OR IGNORE INTO thread_collaboration_participants
            (thread_id, public_id, display_name, account_id)
          SELECT t.id, ?, ?, ? FROM threads t
          WHERE t.public_capability = ? AND t.closed_at IS NULL
            AND EXISTS (SELECT 1 FROM accounts WHERE id = ?)
            AND (SELECT COUNT(*) FROM thread_collaboration_participants existing
              WHERE existing.thread_id = t.id) < ?
          RETURNING id`)
          .bind(
            publicId,
            displayName,
            canonical.accountId,
            capability,
            canonical.accountId,
            THREAD_PARTICIPANT_LIMIT,
          )
          .first<{ id: number }>();

      const participant = await this.findParticipant(db, capability, canonical);
      if (participant) {
        if (!inserted && participant.display_name !== displayName) {
          return this.join(capability, canonical, displayName);
        }
        return { participant: publicParticipant(participant), created: inserted !== null };
      }
      if (inserted) throw new Error("Created participant could not be read");
    }

    const current = await this.threadState(db, capability);
    if (!current) throw notFoundError();
    if (current.closed_at !== null) throw closedError();
    const count = await db
      .prepare(`SELECT COUNT(*) AS count FROM thread_collaboration_participants WHERE thread_id = ?`)
      .bind(current.id)
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= THREAD_PARTICIPANT_LIMIT) {
      throw new ThreadError(409, "participant_limit", "This Jam cannot accept more participants.");
    }
    throw new Error("Could not allocate a participant id");
  }

  async participant(
    capability: string,
    identity: CollaborationIdentity,
  ): Promise<CollaborationParticipant | null> {
    const canonical = await this.canonicalIdentity(identity);
    const row = await this.findParticipant(
      this.db.withSession("first-primary"),
      capability,
      canonical,
    );
    return row ? publicParticipant(row) : null;
  }

  async snapshot(
    capability: string,
    identity: CollaborationIdentity | null = null,
    rawOptions: CollaborationSnapshotOptions = {},
  ): Promise<CollaborationSnapshot | null> {
    const options = normalizeSnapshotOptions(rawOptions);
    const canonical = identity ? await this.canonicalIdentity(identity) : null;
    const db = this.db.withSession("first-primary");
    const state = await this.threadState(db, capability);
    if (!state) return null;
    const viewerParticipant = canonical
      ? await this.findParticipant(db, capability, canonical)
      : null;
    const viewerKey = viewerParticipant
      ? await this.participantActorKey(db, viewerParticipant.id)
      : null;

    const [participantCount, voteRows, messageRows] = await Promise.all([
      db.prepare(`SELECT COUNT(DISTINCT CASE
          WHEN p.account_id IS NULL THEN 'anonymous:' || p.id
          ELSE 'account:' || COALESCE(account.group_id, p.account_id)
        END) AS count
        FROM thread_collaboration_participants p
        LEFT JOIN accounts account ON account.id = p.account_id
        WHERE p.thread_id = ?`)
        .bind(state.id)
        .first<{ count: number }>(),
      db.prepare(`WITH ranked_votes AS (
          SELECT v.contribution_id, v.vote,
            CASE WHEN p.account_id IS NULL THEN 'anonymous:' || p.id
              ELSE 'account:' || COALESCE(account.group_id, p.account_id) END AS actor_key,
            ROW_NUMBER() OVER (
              PARTITION BY v.contribution_id,
                CASE WHEN p.account_id IS NULL THEN 'anonymous:' || p.id
                  ELSE 'account:' || COALESCE(account.group_id, p.account_id) END
              ORDER BY p.id
            ) AS actor_rank
          FROM thread_collaboration_votes v
          JOIN thread_collaboration_participants p ON p.id = v.participant_id
          LEFT JOIN accounts account ON account.id = p.account_id
          WHERE v.thread_id = ?
        )
        SELECT c.id AS contribution_id,
          COALESCE(SUM(CASE WHEN ranked.vote = 'up' AND ranked.actor_rank = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
          COALESCE(SUM(CASE WHEN ranked.vote = 'down' AND ranked.actor_rank = 1 THEN 1 ELSE 0 END), 0) AS downvotes,
          COALESCE(SUM(CASE WHEN ranked.actor_rank = 1 THEN CASE ranked.vote WHEN 'up' THEN 1 ELSE -1 END ELSE 0 END), 0) AS score,
          MAX(CASE WHEN ranked.actor_key = ? AND ranked.actor_rank = 1 THEN ranked.vote END) AS my_vote
        FROM thread_contributions c
        LEFT JOIN ranked_votes ranked ON ranked.contribution_id = c.id
        WHERE c.thread_id = ? AND c.removed_at IS NULL
        GROUP BY c.id
        ORDER BY c.sort_order, c.position, c.id`)
        .bind(state.id, viewerKey, state.id)
        .all<VoteSummaryRow>(),
      this.readMessages(db, state.id, options),
    ]);

    const visibleRows = messageRows.results.slice(0, options.limit);
    if (options.initial) visibleRows.reverse();
    const messages = visibleRows.map(publicMessage);
    const fallbackCursor = options.initial ? 0 : options.afterMessageId;
    const messageCursor = messages.reduce(
      (maximum, message) => Math.max(maximum, message.id),
      fallbackCursor,
    );
    const participant = viewerParticipant ? publicParticipant(viewerParticipant) : null;
    return {
      closed: state.closed_at !== null,
      collaborationRevision: state.collaboration_revision,
      participantCount: participantCount?.count ?? 0,
      votes: voteRows.results.map((row) => ({
        contributionId: row.contribution_id,
        upvotes: row.upvotes,
        downvotes: row.downvotes,
        score: row.score,
        myVote: row.my_vote,
      })),
      messages,
      viewer: {
        joined: participant !== null,
        signedIn: identity?.kind === "account",
        displayName: participant?.displayName ?? null,
        avatarUrl: participant?.avatarUrl ?? null,
        participant,
      },
      messageCursor,
      hasMoreMessages: messageRows.results.length > options.limit,
      limits: { messageLength: THREAD_MESSAGE_MAX_LENGTH },
    };
  }

  async postMessage(
    capability: string,
    identity: CollaborationIdentity,
    request: CollaborationMessageRequest,
  ): Promise<CollaborationMessageResult> {
    const text = normalizeCollaborationMessage(request.text);
    const requestKey = normalizeCollaborationRequestKey(request.requestKey);
    const canonical = await this.canonicalIdentity(identity);
    const db = this.db.withSession("first-primary");
    const participant = await this.requireParticipant(db, capability, canonical);
    const replay = await this.messageByKey(db, participant.id, requestKey);
    if (replay) return replayMessage(replay, text);
    if (participant.closed_at !== null) throw closedError();

    const inserted = await db.prepare(`INSERT OR IGNORE INTO thread_collaboration_messages
        (thread_id, participant_id, request_key, body)
      SELECT p.thread_id, p.id, ?, ?
      FROM thread_collaboration_participants p
      JOIN threads t ON t.id = p.thread_id
      WHERE p.id = ? AND t.closed_at IS NULL
        AND (SELECT COUNT(*) FROM thread_collaboration_messages existing
          WHERE existing.thread_id = p.thread_id) < ?
        AND NOT EXISTS (SELECT 1 FROM thread_collaboration_messages existing
          WHERE existing.participant_id = p.id AND existing.request_key = ?)
      RETURNING id`)
      .bind(requestKey, text, participant.id, THREAD_MESSAGE_LIMIT, requestKey)
      .first<{ id: number }>();

    if (inserted) {
      const message = await this.messageById(db, inserted.id);
      if (!message) throw new Error("Created message could not be read");
      return { message: publicMessage(message), replayed: false };
    }

    const raced = await this.messageByKey(db, participant.id, requestKey);
    if (raced) return replayMessage(raced, text);
    const state = await this.threadState(db, capability);
    if (!state) throw notFoundError();
    if (state.closed_at !== null) throw closedError();
    const count = await db
      .prepare(`SELECT COUNT(*) AS count FROM thread_collaboration_messages WHERE thread_id = ?`)
      .bind(state.id)
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= THREAD_MESSAGE_LIMIT) {
      throw new ThreadError(409, "message_limit", "This Jam has reached its message limit.");
    }
    throw new Error("Message could not be saved");
  }

  async setVote(
    capability: string,
    identity: CollaborationIdentity,
    request: CollaborationVoteRequest,
  ): Promise<CollaborationVoteResult> {
    validateCollaborationVoteRequest(request);
    const requestKey = normalizeCollaborationRequestKey(request.requestKey);
    const canonical = await this.canonicalIdentity(identity);
    const db = this.db.withSession("first-primary");
    const participant = await this.requireParticipant(db, capability, canonical);
    const replay = await this.voteRequestByKey(db, participant.id, requestKey);
    if (replay) {
      assertVoteReplay(replay, request);
      return this.voteResult(capability, canonical, request.contributionId, true);
    }
    if (participant.closed_at !== null) throw closedError();

    const mutationToken = nanoid(22);
    const receipt = db.prepare(`INSERT OR IGNORE INTO thread_collaboration_vote_requests
        (thread_id, participant_id, request_key, contribution_id, vote, mutation_token)
      SELECT p.thread_id, p.id, ?, c.id, ?, ?
      FROM thread_collaboration_participants p
      JOIN threads t ON t.id = p.thread_id
      JOIN thread_contributions c ON c.thread_id = p.thread_id AND c.id = ?
      WHERE p.id = ? AND t.closed_at IS NULL AND c.removed_at IS NULL
        AND (SELECT COUNT(*) FROM thread_collaboration_vote_requests existing
          WHERE existing.thread_id = p.thread_id) < ?
        AND (SELECT COUNT(*) FROM thread_collaboration_vote_requests existing
          WHERE existing.participant_id = p.id) < ?
        AND NOT EXISTS (SELECT 1 FROM thread_collaboration_vote_requests existing
          WHERE existing.participant_id = p.id AND existing.request_key = ?)
      RETURNING contribution_id`)
      .bind(
        requestKey,
        request.vote,
        mutationToken,
        request.contributionId,
        participant.id,
        THREAD_VOTE_REQUESTS_PER_THREAD_LIMIT,
        THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT,
        requestKey,
      );
    const clearGroupVotes = db.prepare(`DELETE FROM thread_collaboration_votes
      WHERE contribution_id = ?
        AND participant_id IN (
          SELECT peer.id
          FROM thread_collaboration_participants viewer
          LEFT JOIN accounts viewer_account ON viewer_account.id = viewer.account_id
          JOIN thread_collaboration_participants peer ON peer.thread_id = viewer.thread_id
          LEFT JOIN accounts peer_account ON peer_account.id = peer.account_id
          WHERE viewer.id = ? AND (
            (viewer.account_id IS NULL AND peer.id = viewer.id)
            OR (viewer.account_id IS NOT NULL AND peer.account_id IS NOT NULL
              AND peer_account.group_id = viewer_account.group_id)
          )
        )
        AND (? = 'clear' OR participant_id != ?)
        AND EXISTS (SELECT 1 FROM thread_collaboration_vote_requests
          WHERE mutation_token = ?)`)
      .bind(
        request.contributionId,
        participant.id,
        request.vote,
        participant.id,
        mutationToken,
      );
    const statements = request.vote === "clear"
      ? [receipt, clearGroupVotes]
      : [receipt, clearGroupVotes, db.prepare(`INSERT INTO thread_collaboration_votes
          (thread_id, contribution_id, participant_id, vote)
        SELECT thread_id, contribution_id, participant_id, vote
        FROM thread_collaboration_vote_requests WHERE mutation_token = ?
        ON CONFLICT(participant_id, contribution_id) DO UPDATE SET
          vote = excluded.vote, updated_at = datetime('now')`)
        .bind(mutationToken)];
    const results = await db.batch(statements);
    if (results[0]?.results.length === 1) {
      return this.voteResult(capability, canonical, request.contributionId, false);
    }

    const raced = await this.voteRequestByKey(db, participant.id, requestKey);
    if (raced) {
      assertVoteReplay(raced, request);
      return this.voteResult(capability, canonical, request.contributionId, true);
    }
    const state = await this.threadState(db, capability);
    if (!state) throw notFoundError();
    if (state.closed_at !== null) throw closedError();
    const contribution = await db.prepare(`SELECT c.id FROM thread_contributions c
      WHERE c.id = ? AND c.thread_id = ? AND c.removed_at IS NULL`)
      .bind(request.contributionId, state.id)
      .first<{ id: number }>();
    if (!contribution) {
      throw new ThreadError(404, "contribution_not_found", "This song is not active in the Jam.");
    }
    const counts = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM thread_collaboration_vote_requests request
          WHERE request.thread_id = participant.thread_id) AS thread_vote_requests,
        (SELECT COUNT(*) FROM thread_collaboration_vote_requests request
          WHERE request.participant_id = participant.id) AS participant_vote_requests
      FROM thread_collaboration_participants participant WHERE participant.id = ?`)
      .bind(participant.id)
      .first<{ thread_vote_requests: number; participant_vote_requests: number }>();
    if ((counts?.participant_vote_requests ?? 0) >= THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT) {
      throw new ThreadError(
        409,
        "participant_vote_request_limit",
        "This participant has reached the Jam vote-change limit.",
      );
    }
    if ((counts?.thread_vote_requests ?? 0) >= THREAD_VOTE_REQUESTS_PER_THREAD_LIMIT) {
      throw new ThreadError(
        409,
        "vote_request_limit",
        "This Jam has reached its vote-change limit.",
      );
    }
    throw new Error("Vote could not be saved");
  }

  async moderateMessage(
    authorization: ManagementAuthorization,
    messageId: number,
  ): Promise<CollaborationModerationResult> {
    if (!isManagementAuthorization(authorization)) {
      throw new ThreadError(403, "forbidden", "Management access required.");
    }
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      throw new ThreadError(400, "invalid_message", "Choose a valid message.");
    }
    const db = this.db.withSession("first-primary");
    const row = await db.prepare(`SELECT m.deleted_at, t.closed_at
      FROM thread_collaboration_messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE m.id = ? AND t.public_capability = ?`)
      .bind(messageId, authorization.publicCapability)
      .first<{ deleted_at: string | null; closed_at: string | null }>();
    if (!row) return "not_found";
    if (row.deleted_at !== null) return "already_removed";
    const removed = await db.prepare(`UPDATE thread_collaboration_messages
      SET deleted_at = datetime('now')
      WHERE id = ? AND deleted_at IS NULL AND thread_id = (
        SELECT id FROM threads WHERE public_capability = ?
      ) RETURNING id`)
      .bind(messageId, authorization.publicCapability)
      .first<{ id: number }>();
    if (removed) return "removed";
    const current = await db.prepare(`SELECT m.deleted_at, t.closed_at
      FROM thread_collaboration_messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.id = ? AND t.public_capability = ?`)
      .bind(messageId, authorization.publicCapability)
      .first<{ deleted_at: string | null; closed_at: string | null }>();
    if (!current) return "not_found";
    if (current.deleted_at !== null) return "already_removed";
    throw new Error("Message could not be moderated");
  }

  private async canonicalIdentity(identity: CollaborationIdentity): Promise<CanonicalIdentity> {
    validateCollaborationIdentity(identity);
    if (identity.kind === "anonymous") return identity;
    const account = await this.db.withSession("first-primary")
      .prepare("SELECT group_id FROM accounts WHERE id = ?")
      .bind(identity.accountId)
      .first<{ group_id: string }>();
    if (!account?.group_id) {
      throw new ThreadError(400, "invalid_participant", "The signed-in account is invalid.");
    }
    return { kind: "account", accountId: account.group_id };
  }

  private async findParticipant(
    db: D1DatabaseSession,
    capability: string,
    identity: CanonicalIdentity,
  ): Promise<ParticipantRow | null> {
    const predicate = identity.kind === "anonymous"
      ? "p.anonymous_digest = ?"
      : `p.account_id IN (SELECT member.id FROM accounts member WHERE member.group_id = ?)`;
    const value = identity.kind === "anonymous" ? identity.digest : identity.accountId;
    return db.prepare(`${participantSelection}
      WHERE t.public_capability = ? AND ${predicate}
      ORDER BY p.id LIMIT 1`)
      .bind(capability, value)
      .first<ParticipantRow>();
  }

  private async requireParticipant(
    db: D1DatabaseSession,
    capability: string,
    identity: CanonicalIdentity,
  ): Promise<ParticipantRow> {
    const participant = await this.findParticipant(db, capability, identity);
    if (participant) return participant;
    if (!await this.threadState(db, capability)) throw notFoundError();
    throw new ThreadError(401, "join_required", "Join this Jam before participating.");
  }

  private threadState(
    db: D1DatabaseSession,
    capability: string,
  ): Promise<ThreadStateRow | null> {
    return db.prepare(`SELECT t.id, t.closed_at, state.revision AS collaboration_revision
      FROM threads t JOIN thread_collaboration_state state ON state.thread_id = t.id
      WHERE t.public_capability = ?`)
      .bind(capability)
      .first<ThreadStateRow>();
  }

  private participantActorKey(
    db: D1DatabaseSession,
    participantId: number,
  ): Promise<string | null> {
    return db.prepare(`SELECT CASE WHEN p.account_id IS NULL THEN 'anonymous:' || p.id
      ELSE 'account:' || COALESCE(account.group_id, p.account_id) END AS actor_key
      FROM thread_collaboration_participants p
      LEFT JOIN accounts account ON account.id = p.account_id WHERE p.id = ?`)
      .bind(participantId)
      .first<string>("actor_key");
  }

  private readMessages(
    db: D1DatabaseSession,
    threadId: number,
    options: ReturnType<typeof normalizeSnapshotOptions>,
  ) {
    const direction = options.initial ? "<=" : ">";
    const order = options.initial ? "DESC" : "ASC";
    const cursor = options.initial ? Number.MAX_SAFE_INTEGER : options.afterMessageId;
    return db.prepare(`${messageSelection}
      WHERE m.thread_id = ? AND m.id ${direction} ?
      ORDER BY m.id ${order} LIMIT ?`)
      .bind(threadId, cursor, options.limit + 1)
      .all<MessageRow>();
  }

  private messageById(db: D1DatabaseSession, id: number): Promise<MessageRequestRow | null> {
    return db.prepare(`${messageSelection} WHERE m.id = ?`)
      .bind(id)
      .first<MessageRequestRow>();
  }

  private messageByKey(
    db: D1DatabaseSession,
    participantId: number,
    requestKey: string,
  ): Promise<MessageRequestRow | null> {
    return db.prepare(`${messageSelection}
      WHERE m.request_key = ? AND m.participant_id IN (
        SELECT peer.id
        FROM thread_collaboration_participants viewer
        LEFT JOIN accounts viewer_account ON viewer_account.id = viewer.account_id
        JOIN thread_collaboration_participants peer ON peer.thread_id = viewer.thread_id
        LEFT JOIN accounts peer_account ON peer_account.id = peer.account_id
        WHERE viewer.id = ? AND (
          (viewer.account_id IS NULL AND peer.id = viewer.id)
          OR (viewer.account_id IS NOT NULL AND peer.account_id IS NOT NULL
            AND peer_account.group_id = viewer_account.group_id)
        )
      ) ORDER BY m.participant_id LIMIT 1`)
      .bind(requestKey, participantId)
      .first<MessageRequestRow>();
  }

  private voteRequestByKey(
    db: D1DatabaseSession,
    participantId: number,
    requestKey: string,
  ): Promise<VoteRequestRow | null> {
    return db.prepare(`SELECT request.contribution_id, request.vote
      FROM thread_collaboration_vote_requests request
      JOIN thread_collaboration_participants owner ON owner.id = request.participant_id
      JOIN thread_collaboration_participants viewer ON viewer.id = ?
      LEFT JOIN accounts owner_account ON owner_account.id = owner.account_id
      LEFT JOIN accounts viewer_account ON viewer_account.id = viewer.account_id
      WHERE request.request_key = ? AND owner.thread_id = viewer.thread_id AND (
        (viewer.account_id IS NULL AND owner.id = viewer.id)
        OR (viewer.account_id IS NOT NULL AND owner.account_id IS NOT NULL
          AND owner_account.group_id = viewer_account.group_id)
      ) ORDER BY owner.id LIMIT 1`)
      .bind(participantId, requestKey)
      .first<VoteRequestRow>();
  }

  private async voteResult(
    capability: string,
    identity: CanonicalIdentity,
    contributionId: number,
    replayed: boolean,
  ): Promise<CollaborationVoteResult> {
    const snapshot = await this.snapshot(capability, identity, { limit: 1 });
    if (!snapshot) throw notFoundError();
    const vote = snapshot.votes.find((entry) => entry.contributionId === contributionId) ?? {
      contributionId,
      upvotes: 0,
      downvotes: 0,
      score: 0,
      myVote: null,
    };
    return { vote, replayed };
  }
}

function publicParticipant(row: ParticipantRow): CollaborationParticipant {
  return {
    id: row.public_id,
    displayName: row.display_name,
    avatarUrl: safeAvatarUrl(row.avatar_url),
    joinedAt: row.created_at,
  };
}

function publicMessage(row: MessageRow): CollaborationMessage {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    author: {
      id: row.participant_public_id,
      displayName: row.participant_name,
      avatarUrl: safeAvatarUrl(row.avatar_url),
      joinedAt: row.participant_created_at,
    },
    text: deleted ? "" : row.body,
    createdAt: row.created_at,
    deleted,
  };
}

function replayMessage(row: MessageRequestRow, text: string): CollaborationMessageResult {
  if (row.body !== text) {
    throw new ThreadError(
      409,
      "request_conflict",
      "This request key was already used for another message.",
    );
  }
  return { message: publicMessage(row), replayed: true };
}

function assertVoteReplay(
  row: VoteRequestRow,
  request: CollaborationVoteRequest,
): void {
  if (row.contribution_id !== request.contributionId || row.vote !== request.vote) {
    throw new ThreadError(
      409,
      "request_conflict",
      "This request key was already used for another vote.",
    );
  }
}

function safeAvatarUrl(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function notFoundError(): ThreadError {
  return new ThreadError(404, "not_found", "Jam not found.");
}

function closedError(): ThreadError {
  return new ThreadError(409, "closed", "This Jam is closed to collaboration.");
}
