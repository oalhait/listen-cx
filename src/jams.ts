import type { LinkActions } from "./links.js";
import { createLink, LinkActionError } from "./links.js";
import type { JamStore, JamView } from "./jam-db.js";
import {
  authorizeJamManagementCapability,
  fingerprintJamContributionInput,
  isJamCapability,
  normalizeJamRequestKey,
  normalizeJamTitle,
} from "./jam.js";
import { parseTrackUrl } from "./urls.js";

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
  "jam_contribution_limit_reached",
  "jam_management_denied",
  "contribution_not_found",
] as const;

export type JamActionErrorCode = typeof JAM_ACTION_ERROR_CODES[number];

export class JamActionError extends Error {
  constructor(
    readonly code: JamActionErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 500 | 503,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "JamActionError";
  }
}

export interface JamActions extends LinkActions {
  jamStore: JamStore;
  jamsEnabled: boolean;
}

export interface CreatedJam {
  jamId: string;
  jamUrl: string;
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
}

export interface JamDetails {
  jamId: string;
  jamUrl: string;
  title: string;
  state: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
  activeTrackCount: number;
  totalContributions: number;
  contributionLimit: number;
  tracks: JamTrackView[];
}

function jamUrl(baseUrl: string, jamId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/jams/${jamId}`;
}

function listenLink(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${slug}`;
}

function normalizeJamView(view: JamView, baseUrl: string): JamDetails {
  return {
    jamId: view.jam.publicCapability,
    jamUrl: jamUrl(baseUrl, view.jam.publicCapability),
    title: view.jam.title,
    state: view.jam.closedAt ? "closed" : "open",
    createdAt: view.jam.createdAt,
    closedAt: view.jam.closedAt,
    activeTrackCount: view.contributions.length,
    totalContributions: view.totalContributions,
    contributionLimit: view.contributionLimit,
    tracks: view.contributions.map((contribution) => ({
      contributionId: contribution.id,
      position: contribution.position,
      listenLink: listenLink(baseUrl, contribution.linkSlug),
      title: contribution.title,
      artist: contribution.artist,
      artworkUrl: contribution.artworkUrl,
    })),
  };
}

function validateJamId(jamId: string): string {
  const normalized = jamId.trim();
  if (!isJamCapability(normalized)) {
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

function jamStatusError(status: "conflict" | "full" | "closed" | "limit_reached" | "not_found"): JamActionError {
  switch (status) {
    case "conflict":
      return new JamActionError(
        "request_key_conflict",
        409,
        "That request key was already used for another track.",
      );
    case "full":
      return new JamActionError("jam_full", 409, "This Jam already has 50 active tracks.");
    case "closed":
      return new JamActionError("jam_closed", 409, "This Jam is closed to new tracks.");
    case "limit_reached":
      return new JamActionError(
        "jam_contribution_limit_reached",
        409,
        "This Jam has reached its lifetime contribution limit.",
      );
    case "not_found":
      return new JamActionError("jam_not_found", 404, "Jam not found.");
  }
}

async function discardUnreferencedLink(actions: JamActions, slug: string): Promise<void> {
  try {
    await actions.store.deleteIfUnreferenced(slug);
  } catch {
    // Cleanup must not replace the action's stable error. The guarded DELETE is
    // safe to retry because it never removes a link referenced by a Jam.
  }
}

export async function createJam(actions: JamActions, rawTitle: string): Promise<CreatedJam> {
  ensureJamsEnabled(actions);
  let title: string;
  try {
    title = normalizeJamTitle(rawTitle);
  } catch {
    throw new JamActionError(
      "invalid_jam_title",
      400,
      "Jam title must be between 1 and 80 characters.",
    );
  }

  let result;
  try {
    result = await actions.jamStore.create(title);
  } catch {
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  if (result.status === "limit_reached") {
    throw new JamActionError(
      "jam_limit_reached",
      503,
      "Jam creation is temporarily unavailable.",
      true,
    );
  }
  return {
    jamId: result.jam.publicCapability,
    jamUrl: jamUrl(actions.baseUrl, result.jam.publicCapability),
    managementToken: result.managementCapability,
    title: result.jam.title,
    state: "open",
    createdAt: result.jam.createdAt,
  };
}

export async function getJam(actions: JamActions, rawJamId: string): Promise<JamDetails> {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  let view;
  try {
    view = await actions.jamStore.get(jamId);
  } catch {
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  if (!view) throw new JamActionError("jam_not_found", 404, "Jam not found.");
  return normalizeJamView(view, actions.baseUrl);
}

export async function addTrackToJam(
  actions: JamActions,
  rawJamId: string,
  rawUrl: string,
  rawRequestKey: string,
) {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  const parsedTrack = parseTrackUrl(rawUrl);
  if (!parsedTrack) {
    throw new LinkActionError(
      "invalid_track_url",
      400,
      "Send a Spotify or Apple Music track URL.",
    );
  }
  let requestKey: string;
  try {
    requestKey = normalizeJamRequestKey(rawRequestKey);
  } catch {
    throw new JamActionError(
      "invalid_request_key",
      400,
      "Request key must be between 1 and 128 characters.",
    );
  }
  const sourceIdentity = {
    sourceProvider: parsedTrack.provider,
    sourceCatalogId: parsedTrack.id,
    sourceStorefront: parsedTrack.storefront,
  };
  const inputFingerprint = await fingerprintJamContributionInput(sourceIdentity);

  let preflight;
  try {
    preflight = await actions.jamStore.preflightContribution(
      jamId,
      requestKey,
      inputFingerprint,
    );
  } catch {
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  if (preflight.status === "existing") {
    return {
      status: "existing" as const,
      jamId,
      requestKey,
      contributionId: preflight.contribution.id,
      position: preflight.contribution.position,
      listenLink: listenLink(actions.baseUrl, preflight.contribution.linkSlug),
    };
  }
  if (preflight.status !== "continue") throw jamStatusError(preflight.status);

  const createdLink = await createLink(actions, rawUrl);
  let accepted;
  try {
    accepted = await actions.jamStore.acceptContribution(jamId, {
      ...sourceIdentity,
      linkSlug: createdLink.slug,
      requestKey,
      inputFingerprint,
    });
  } catch {
    await discardUnreferencedLink(actions, createdLink.slug);
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  if (accepted.status !== "accepted" && accepted.status !== "existing") {
    await discardUnreferencedLink(actions, createdLink.slug);
    throw jamStatusError(accepted.status);
  }
  if (accepted.status === "existing" && accepted.contribution.linkSlug !== createdLink.slug) {
    await discardUnreferencedLink(actions, createdLink.slug);
  }
  return {
    status: accepted.status,
    jamId,
    requestKey,
    contributionId: accepted.contribution.id,
    position: accepted.contribution.position,
    listenLink: listenLink(actions.baseUrl, accepted.contribution.linkSlug),
  };
}

async function authorizeManagement(
  actions: JamActions,
  rawJamId: string,
  managementToken: string,
) {
  ensureJamsEnabled(actions);
  const jamId = validateJamId(rawJamId);
  let authorization;
  try {
    authorization = await authorizeJamManagementCapability(
      actions.jamStore,
      jamId,
      managementToken.trim(),
    );
  } catch {
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  if (!authorization) {
    throw new JamActionError(
      "jam_management_denied",
      403,
      "The Jam management token is invalid.",
    );
  }
  return authorization;
}

export async function removeTrackFromJam(
  actions: JamActions,
  rawJamId: string,
  managementToken: string,
  contributionId: number,
) {
  ensureJamsEnabled(actions);
  const authorization = await authorizeManagement(actions, rawJamId, managementToken);
  let result;
  try {
    result = await actions.jamStore.removeContribution(authorization, contributionId);
  } catch {
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  if (result.status === "not_found") {
    throw new JamActionError("contribution_not_found", 404, "Jam track not found.");
  }
  return {
    status: "removed" as const,
    jamId: authorization.publicCapability,
    contributionId: result.contribution.id,
    position: result.contribution.position,
  };
}

export async function closeJam(
  actions: JamActions,
  rawJamId: string,
  managementToken: string,
) {
  const authorization = await authorizeManagement(actions, rawJamId, managementToken);
  let result;
  try {
    result = await actions.jamStore.close(authorization);
  } catch {
    throw new JamActionError("jam_storage_unavailable", 500, "Jam storage is unavailable.", true);
  }
  if (result.status === "not_found") {
    throw new JamActionError("jam_not_found", 404, "Jam not found.");
  }
  return {
    status: "closed" as const,
    jamId: result.jam.publicCapability,
    closedAt: result.jam.closedAt,
  };
}
