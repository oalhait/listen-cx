import { nanoid } from "nanoid";
import type { LinkActions } from "./links.js";
import { LinkActionError } from "./links.js";
import type {
  CollaborationIdentity,
  CollaborationMessage,
  CollaborationParticipant,
  CollaborationVoteIntent,
  CollaborationVoteSummary,
} from "./thread-collaboration.js";
import type { D1ThreadCollaborationStore } from "./thread-collaboration-db.js";
import type { D1ThreadStore, StoredThreadContribution } from "./thread-db.js";
import {
  THREAD_TOTAL_LIMIT,
  ThreadError,
  isThreadCapability,
  mutationFingerprint,
  normalizeRequestKey,
  normalizeThreadTitle,
  sha256,
  verifiedSource,
  type ThreadContributionAttribution,
  type ThreadView,
} from "./thread.js";
import {
  authorizeManagementCapability,
  type ManagementAuthorization,
} from "./thread-security.js";
import { parseTrackUrl } from "./urls.js";

const PARTICIPANT_KEY = /^[A-Za-z0-9_-]{43}$/;
const MUTATION_RETRY_LIMIT = 3;

export const JAM_ACTION_ERROR_CODES = [
  "invalid_jam_title",
  "jams_disabled",
  "jam_limit_reached",
  "jam_storage_unavailable",
  "invalid_jam",
  "jam_not_found",
  "invalid_request_key",
  "request_key_conflict",
  "jam_full",
  "jam_closed",
  "jam_changed",
  "jam_edit_blocked",
  "jam_contribution_limit_reached",
  "jam_management_denied",
  "contribution_not_found",
  "invalid_participant",
  "join_required",
  "participant_limit",
  "invalid_message",
  "message_limit",
  "message_not_found",
  "invalid_cursor",
  "invalid_limit",
  "invalid_vote",
  "invalid_contribution",
  "participant_vote_request_limit",
  "jam_vote_request_limit",
] as const;

export type JamActionErrorCode = typeof JAM_ACTION_ERROR_CODES[number];

export class JamActionError extends Error {
  constructor(
    readonly code: JamActionErrorCode,
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "JamActionError";
  }
}

export interface JamActions extends LinkActions {
  threadStore: D1ThreadStore;
  collaborationStore: D1ThreadCollaborationStore;
  jamsEnabled: boolean;
  /** Wakes provider publication after canonical music-state mutations. */
  onJamChange?: (jamId: string) => void;
}

export interface CreatedJam {
  jamId: string;
  /** Human-facing compatibility URL. */
  jamUrl: string;
  shareUrl: string;
  apiUrl: string;
  managementToken: string;
  title: string;
  state: "open";
  createdAt: string;
}

export interface JamTrackView {
  contributionId: number;
  position: number;
  listenLink: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  addedBy: ThreadContributionAttribution | null;
  upvotes: number;
  downvotes: number;
  score: number;
}

export interface JamDetails {
  jamId: string;
  /** Human-facing compatibility URL. */
  jamUrl: string;
  shareUrl: string;
  apiUrl: string;
  title: string;
  state: "open" | "closed";
  revision: number;
  collaborationRevision: number;
  createdAt: string;
  closedAt: string | null;
  activeTrackCount: number;
  totalContributions: number;
  contributionLimit: number;
  participantCount: number;
  tracks: JamTrackView[];
}

function shareUrl(baseUrl: string, jamId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/t/${jamId}`;
}

function apiUrl(baseUrl: string, jamId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/threads/${jamId}`;
}

function listenLink(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${slug}`;
}

function validateJamId(jamId: string): string {
  const normalized = jamId.trim();
  if (!isThreadCapability(normalized)) {
    throw new JamActionError("invalid_jam", 400, "Send a valid Jam id.");
  }
  return normalized;
}

function ensureJamsEnabled(actions: JamActions): void {
  if (!actions.jamsEnabled) {
    throw new JamActionError(
      "jams_disabled",
      403,
      "Jams are not enabled in this environment.",
    );
  }
}

function mapThreadError(error: ThreadError): JamActionError {
  switch (error.code) {
    case "creation_limit":
      return new JamActionError("jam_limit_reached", 503, "Jam creation is temporarily unavailable.", true);
    case "not_found":
      return new JamActionError("jam_not_found", 404, "Jam not found.");
    case "closed":
      return new JamActionError("jam_closed", 409, "This Jam is closed.");
    case "stale_revision":
      return new JamActionError("jam_changed", 409, "The Jam changed. Retry the operation.", true);
    case "request_conflict":
      return new JamActionError("request_key_conflict", 409, "That request key was already used for another change.");
    case "full":
      return new JamActionError("jam_full", 409, "This Jam already has 50 active tracks.");
    case "contribution_limit":
    case "mutation_limit":
      return new JamActionError("jam_contribution_limit_reached", 409, "This Jam has reached its lifetime change limit.");
    case "apple_append_only":
      return new JamActionError("jam_edit_blocked", 409, error.message);
    case "contribution_not_found":
      return new JamActionError("contribution_not_found", 404, "Jam track not found.");
    case "invalid_input":
      return new JamActionError("invalid_request_key", 400, "Request key must be between 1 and 128 characters.");
    case "invalid_participant":
      return new JamActionError("invalid_participant", 400, error.message);
    case "join_required":
      return new JamActionError("join_required", 401, error.message);
    case "participant_limit":
      return new JamActionError("participant_limit", 409, error.message);
    case "invalid_message":
      return new JamActionError("invalid_message", 400, error.message);
    case "message_limit":
      return new JamActionError("message_limit", 409, error.message);
    case "message_not_found":
      return new JamActionError("message_not_found", 404, error.message);
    case "invalid_cursor":
      return new JamActionError("invalid_cursor", 400, error.message);
    case "invalid_limit":
      return new JamActionError("invalid_limit", 400, error.message);
    case "invalid_vote":
      return new JamActionError("invalid_vote", 400, error.message);
    case "invalid_contribution":
      return new JamActionError("invalid_contribution", 400, error.message);
    case "participant_vote_request_limit":
      return new JamActionError("participant_vote_request_limit", 409, error.message);
    case "vote_request_limit":
      return new JamActionError("jam_vote_request_limit", 409, error.message);
    default:
      return new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
}

function storageError(error: unknown): JamActionError {
  return error instanceof ThreadError
    ? mapThreadError(error)
    : new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
}

async function anonymousIdentity(participantKey: string): Promise<CollaborationIdentity> {
  if (!PARTICIPANT_KEY.test(participantKey)) {
    throw new JamActionError(
      "invalid_participant",
      400,
      "Send a valid private participant key.",
    );
  }
  return { kind: "anonymous", digest: await sha256(participantKey) };
}

async function collaborationSnapshot(actions: JamActions, jamId: string) {
  try {
    const snapshot = await actions.collaborationStore.snapshot(jamId, null);
    if (!snapshot) throw new JamActionError("jam_not_found", 404, "Jam not found.");
    return snapshot;
  } catch (error) {
    if (error instanceof JamActionError) throw error;
    throw storageError(error);
  }
}

function normalizeJamView(
  view: ThreadView,
  baseUrl: string,
  collaboration: { collaborationRevision: number; participantCount: number; votes: CollaborationVoteSummary[] },
): JamDetails {
  const sharingUrl = shareUrl(baseUrl, view.publicCapability);
  const votes = new Map(collaboration.votes.map((vote) => [vote.contributionId, vote]));
  return {
    jamId: view.publicCapability,
    jamUrl: sharingUrl,
    shareUrl: sharingUrl,
    apiUrl: apiUrl(baseUrl, view.publicCapability),
    title: view.title,
    state: view.closedAt ? "closed" : "open",
    revision: view.revision,
    collaborationRevision: collaboration.collaborationRevision,
    createdAt: view.createdAt ?? "",
    closedAt: view.closedAt,
    activeTrackCount: view.contributions.length,
    totalContributions: view.totalContributions ?? view.contributions.length,
    contributionLimit: THREAD_TOTAL_LIMIT,
    participantCount: collaboration.participantCount,
    tracks: view.contributions.map((contribution, index) => {
      const vote = votes.get(contribution.id);
      return {
        contributionId: contribution.id,
        position: index + 1,
        listenLink: listenLink(baseUrl, contribution.linkSlug),
        title: contribution.title,
        artist: contribution.artist,
        artworkUrl: contribution.artworkUrl,
        addedBy: contribution.addedBy ?? null,
        upvotes: vote?.upvotes ?? 0,
        downvotes: vote?.downvotes ?? 0,
        score: vote?.score ?? 0,
      };
    }),
  };
}

export async function createJam(actions: JamActions, rawTitle: string): Promise<CreatedJam> {
  ensureJamsEnabled(actions);
  let title: string;
  try {
    title = normalizeThreadTitle(rawTitle);
  } catch {
    throw new JamActionError(
      "invalid_jam_title",
      400,
      "Jam title must be between 1 and 80 characters.",
    );
  }

  const managementToken = nanoid(22);
  let view: ThreadView;
  try {
    view = await actions.threadStore.create(title, managementToken);
  } catch (error) {
    throw storageError(error);
  }
  const sharingUrl = shareUrl(actions.baseUrl, view.publicCapability);
  return {
    jamId: view.publicCapability,
    jamUrl: sharingUrl,
    shareUrl: sharingUrl,
    apiUrl: apiUrl(actions.baseUrl, view.publicCapability),
    managementToken,
    title: view.title,
    state: "open",
    createdAt: view.createdAt ?? "",
  };
}

export async function getJam(actions: JamActions, rawJamId: string): Promise<JamDetails> {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  try {
    const [view, collaboration] = await Promise.all([
      actions.threadStore.get(jamId),
      collaborationSnapshot(actions, jamId),
    ]);
    if (!view) throw new JamActionError("jam_not_found", 404, "Jam not found.");
    return normalizeJamView(view, actions.baseUrl, collaboration);
  } catch (error) {
    if (error instanceof JamActionError) throw error;
    throw storageError(error);
  }
}

async function contributionResult(
  actions: JamActions,
  jamId: string,
  requestKey: string,
  status: "accepted" | "existing",
) {
  const contribution = await actions.threadStore.contributionByRequestKey(jamId, requestKey);
  if (!contribution) {
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  return {
    status,
    jamId,
    requestKey,
    contributionId: contribution.id,
    position: contribution.position,
    listenLink: listenLink(actions.baseUrl, contribution.linkSlug),
  };
}

export async function addTrackToJam(
  actions: JamActions,
  rawJamId: string,
  rawUrl: string,
  rawRequestKey: string,
  participantKey?: string,
) {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  const parsedTrack = parseTrackUrl(rawUrl);
  if (!parsedTrack) {
    throw new LinkActionError("invalid_track_url", 400, "Send a Spotify or Apple Music track URL.");
  }
  let requestKey: string;
  try {
    requestKey = normalizeRequestKey(rawRequestKey);
  } catch {
    throw new JamActionError("invalid_request_key", 400, "Request key must be between 1 and 128 characters.");
  }

  const identity = participantKey === undefined ? null : await anonymousIdentity(participantKey);
  let view: ThreadView | null;
  let addedByParticipantId: string | null = null;
  try {
    view = await actions.threadStore.get(jamId);
    if (!view) throw new JamActionError("jam_not_found", 404, "Jam not found.");
    if (identity) {
      const participant = await actions.collaborationStore.participant(jamId, identity);
      if (!participant) {
        throw new JamActionError(
          "join_required",
          401,
          "Join this Jam with this participant key before adding attributed tracks.",
        );
      }
      addedByParticipantId = participant.id;
    }
    const fingerprint = await mutationFingerprint({
      kind: "add",
      source: parsedTrack,
      addedByParticipantId,
    });
    const replay = await actions.threadStore.preflight(jamId, requestKey, fingerprint, view.revision);
    if (replay) {
      actions.onJamChange?.(jamId);
      return contributionResult(actions, jamId, requestKey, "existing");
    }
  } catch (error) {
    if (error instanceof JamActionError) throw error;
    throw storageError(error);
  }

  let track;
  try {
    track = await actions.resolver.resolve(rawUrl);
  } catch {
    throw new LinkActionError("provider_unavailable", 502, "The music provider is unavailable.", true);
  }
  if (!track) throw new LinkActionError("track_not_found", 404, "Track not found.");

  let source;
  try {
    source = verifiedSource(rawUrl, track);
  } catch {
    throw new LinkActionError("invalid_track_url", 400, "The provider could not verify this track URL.");
  }

  for (let attempt = 0; attempt < MUTATION_RETRY_LIMIT; attempt += 1) {
    try {
      const receipt = await actions.threadStore.add(jamId, {
        source,
        track,
        requestKey,
        expectedRevision: view.revision,
        addedByParticipantId,
      });
      actions.onJamChange?.(jamId);
      return contributionResult(actions, jamId, requestKey, receipt.replayed ? "existing" : "accepted");
    } catch (error) {
      if (error instanceof ThreadError && error.code === "stale_revision" && attempt + 1 < MUTATION_RETRY_LIMIT) {
        view = await actions.threadStore.get(jamId);
        if (!view) throw new JamActionError("jam_not_found", 404, "Jam not found.");
        continue;
      }
      if (error instanceof ThreadError) throw storageError(error);
      const committed = await actions.threadStore.contributionByRequestKey(jamId, requestKey).catch(() => null);
      if (committed) {
        actions.onJamChange?.(jamId);
        return contributionResult(actions, jamId, requestKey, "existing");
      }
      throw storageError(error);
    }
  }
  throw new JamActionError("jam_changed", 409, "The Jam changed. Retry the operation.", true);
}

async function authorizeManagement(
  actions: JamActions,
  rawJamId: string,
  managementToken: string,
): Promise<ManagementAuthorization> {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  try {
    const authorization = await authorizeManagementCapability(
      actions.threadStore,
      jamId,
      managementToken.trim(),
    );
    if (authorization) return authorization;
  } catch {
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  throw new JamActionError("jam_management_denied", 403, "The Jam management token is invalid.");
}

export async function removeTrackFromJam(
  actions: JamActions,
  rawJamId: string,
  managementToken: string,
  contributionId: number,
) {
  const authorization = await authorizeManagement(actions, rawJamId, managementToken);
  let contribution: StoredThreadContribution | null;
  let view: ThreadView | null;
  try {
    [contribution, view] = await Promise.all([
      actions.threadStore.contribution(authorization.publicCapability, contributionId),
      actions.threadStore.get(authorization.publicCapability),
    ]);
  } catch (error) {
    throw storageError(error);
  }
  if (!contribution || !view) {
    throw new JamActionError("contribution_not_found", 404, "Jam track not found.");
  }
  if (contribution.removedAt === null) {
    try {
      await actions.threadStore.manage(authorization, {
        kind: "remove",
        id: contributionId,
        requestKey: nanoid(),
        expectedRevision: view.revision,
      });
      actions.onJamChange?.(authorization.publicCapability);
    } catch (error) {
      const current = await actions.threadStore.contribution(authorization.publicCapability, contributionId).catch(() => null);
      if (!current?.removedAt) throw storageError(error);
      contribution = current;
      actions.onJamChange?.(authorization.publicCapability);
    }
  }
  return {
    status: "removed" as const,
    jamId: authorization.publicCapability,
    contributionId: contribution.id,
    position: contribution.position,
  };
}

export async function closeJam(
  actions: JamActions,
  rawJamId: string,
  managementToken: string,
) {
  const authorization = await authorizeManagement(actions, rawJamId, managementToken);
  let view: ThreadView | null;
  try {
    view = await actions.threadStore.get(authorization.publicCapability);
    if (!view) throw new JamActionError("jam_not_found", 404, "Jam not found.");
    if (!view.closedAt) {
      try {
        await actions.threadStore.manage(authorization, {
          kind: "close",
          requestKey: nanoid(),
          expectedRevision: view.revision,
        });
        actions.onJamChange?.(authorization.publicCapability);
        view = await actions.threadStore.get(authorization.publicCapability);
      } catch (error) {
        const current = await actions.threadStore.get(authorization.publicCapability).catch(() => null);
        if (!current?.closedAt) throw error;
        view = current;
        actions.onJamChange?.(authorization.publicCapability);
      }
    }
  } catch (error) {
    if (error instanceof JamActionError) throw error;
    throw storageError(error);
  }
  return {
    status: "closed" as const,
    jamId: authorization.publicCapability,
    closedAt: view?.closedAt ?? null,
  };
}

export async function joinJam(
  actions: JamActions,
  rawJamId: string,
  displayName: string,
  participantKey: string,
): Promise<{ status: "joined" | "existing"; participant: CollaborationParticipant }> {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  const identity = await anonymousIdentity(participantKey);
  try {
    const result = await actions.collaborationStore.join(jamId, identity, displayName);
    return { status: result.created ? "joined" : "existing", participant: result.participant };
  } catch (error) {
    throw storageError(error);
  }
}

export async function postJamMessage(
  actions: JamActions,
  rawJamId: string,
  participantKey: string,
  text: string,
  requestKey: string,
): Promise<{ message: CollaborationMessage; replayed: boolean }> {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  const identity = await anonymousIdentity(participantKey);
  try {
    return await actions.collaborationStore.postMessage(jamId, identity, { text, requestKey });
  } catch (error) {
    throw storageError(error);
  }
}

export async function listJamMessages(
  actions: JamActions,
  rawJamId: string,
  afterMessageId?: number,
  limit?: number,
) {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  try {
    const snapshot = await actions.collaborationStore.snapshot(jamId, null, { afterMessageId, limit });
    if (!snapshot) throw new JamActionError("jam_not_found", 404, "Jam not found.");
    return {
      jamId,
      state: snapshot.closed ? "closed" as const : "open" as const,
      collaborationRevision: snapshot.collaborationRevision,
      participantCount: snapshot.participantCount,
      messages: snapshot.messages,
      nextCursor: snapshot.messageCursor,
      hasMore: snapshot.hasMoreMessages,
    };
  } catch (error) {
    if (error instanceof JamActionError) throw error;
    throw storageError(error);
  }
}

export async function setJamTrackVote(
  actions: JamActions,
  rawJamId: string,
  participantKey: string,
  contributionId: number,
  vote: CollaborationVoteIntent,
  requestKey: string,
): Promise<{ vote: CollaborationVoteSummary; replayed: boolean }> {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  const identity = await anonymousIdentity(participantKey);
  try {
    return await actions.collaborationStore.setVote(jamId, identity, {
      contributionId,
      vote,
      requestKey,
    });
  } catch (error) {
    throw storageError(error);
  }
}

export async function removeJamMessage(
  actions: JamActions,
  rawJamId: string,
  managementToken: string,
  messageId: number,
) {
  const authorization = await authorizeManagement(actions, rawJamId, managementToken);
  try {
    const status = await actions.collaborationStore.moderateMessage(authorization, messageId);
    if (status === "not_found") {
      throw new JamActionError("message_not_found", 404, "Jam message not found.");
    }
    return { status, jamId: authorization.publicCapability, messageId };
  } catch (error) {
    if (error instanceof JamActionError) throw error;
    throw storageError(error);
  }
}
