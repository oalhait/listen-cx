import type { PublicProfile } from "./profile.js";
import { ThreadError, normalizeRequestKey } from "./thread.js";

export const THREAD_PARTICIPANT_LIMIT = 2_000;
export const THREAD_MESSAGE_LIMIT = 2_000;
export const THREAD_MESSAGE_PAGE_LIMIT = 100;
export const THREAD_VOTE_REQUESTS_PER_THREAD_LIMIT = 10_000;
export const THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT = 1_000;
export const THREAD_PARTICIPANT_NAME_MAX_LENGTH = 40;
export const THREAD_MESSAGE_MAX_LENGTH = 500;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

export type CollaborationIdentity =
  | { kind: "anonymous"; digest: string }
  | { kind: "account"; accountId: string };

export type CollaborationVote = "up" | "down";
export type CollaborationVoteIntent = CollaborationVote | "clear";

export interface CollaborationParticipant extends PublicProfile {
  id: string;
  joinedAt: string;
}

export interface CollaborationMessage {
  id: number;
  author: CollaborationParticipant;
  text: string;
  createdAt: string;
  deleted: boolean;
}

export interface CollaborationVoteSummary {
  contributionId: number;
  upvotes: number;
  downvotes: number;
  score: number;
  myVote: CollaborationVote | null;
}

export interface CollaborationViewer {
  joined: boolean;
  signedIn: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  participant: CollaborationParticipant | null;
}

export interface CollaborationSnapshot {
  closed: boolean;
  collaborationRevision: number;
  participantCount: number;
  votes: CollaborationVoteSummary[];
  messages: CollaborationMessage[];
  viewer: CollaborationViewer;
  messageCursor: number;
  hasMoreMessages: boolean;
  limits: {
    messageLength: number;
  };
}

export interface CollaborationMessageRequest {
  text: string;
  requestKey: string;
}

export interface CollaborationVoteRequest {
  contributionId: number;
  vote: CollaborationVoteIntent;
  requestKey: string;
}

export interface CollaborationSnapshotOptions {
  afterMessageId?: number;
  limit?: number;
}

export function validateCollaborationIdentity(identity: CollaborationIdentity): void {
  if (identity.kind === "anonymous") {
    if (!SHA256_HEX.test(identity.digest)) {
      throw new ThreadError(400, "invalid_participant", "The participant session is invalid.");
    }
    return;
  }
  if (
    typeof identity.accountId !== "string"
    || identity.accountId.length < 1
    || identity.accountId.length > 128
    || /\p{Cc}/u.test(identity.accountId)
  ) {
    throw new ThreadError(400, "invalid_participant", "The signed-in account is invalid.");
  }
}

export function normalizeParticipantName(value: string): string {
  return normalizeText(value, "Display name", THREAD_PARTICIPANT_NAME_MAX_LENGTH, false);
}

export function normalizeCollaborationMessage(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  const length = [...normalized].length;
  if (
    length < 1
    || length > THREAD_MESSAGE_MAX_LENGTH
    || CONTROL_CHARACTER_EXCEPT_NEWLINE.test(normalized)
  ) {
    throw new ThreadError(
      400,
      "invalid_message",
      `Messages must contain 1–${THREAD_MESSAGE_MAX_LENGTH} characters without control characters.`,
    );
  }
  return normalized;
}

export function normalizeCollaborationRequestKey(value: string): string {
  return normalizeRequestKey(value);
}

export function normalizeSnapshotOptions(
  options: CollaborationSnapshotOptions,
): Required<CollaborationSnapshotOptions> & { initial: boolean } {
  const initial = options.afterMessageId === undefined;
  const afterMessageId = options.afterMessageId ?? 0;
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(afterMessageId) || afterMessageId < 0) {
    throw new ThreadError(400, "invalid_cursor", "Use a valid message cursor.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > THREAD_MESSAGE_PAGE_LIMIT) {
    throw new ThreadError(
      400,
      "invalid_limit",
      `Request between 1 and ${THREAD_MESSAGE_PAGE_LIMIT} messages.`,
    );
  }
  return { afterMessageId, limit, initial };
}

export function validateCollaborationVoteRequest(request: CollaborationVoteRequest): void {
  if (!Number.isSafeInteger(request.contributionId) || request.contributionId < 1) {
    throw new ThreadError(400, "invalid_contribution", "Choose a valid song.");
  }
  if (!(["up", "down", "clear"] as const).includes(request.vote)) {
    throw new ThreadError(400, "invalid_vote", "Choose up, down, or clear.");
  }
  normalizeCollaborationRequestKey(request.requestKey);
}

function normalizeText(value: string, label: string, limit: number, allowNewline: boolean): string {
  if (typeof value !== "string") {
    throw new ThreadError(400, "invalid_participant", `${label} must contain 1–${limit} characters.`);
  }
  const normalized = value.trim();
  const control = allowNewline ? CONTROL_CHARACTER_EXCEPT_NEWLINE : /\p{Cc}/u;
  if ([...normalized].length < 1 || [...normalized].length > limit || control.test(normalized)) {
    throw new ThreadError(
      400,
      "invalid_participant",
      `${label} must contain 1–${limit} characters without control characters.`,
    );
  }
  return normalized;
}
