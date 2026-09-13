import type { Resolved } from "./resolve.js";
import { parseTrackUrl, type ParsedTrack, type Provider } from "./urls.js";

export const THREAD_ACTIVE_LIMIT = 50;
export const THREAD_TOTAL_LIMIT = 500;
export const THREAD_MUTATION_LIMIT = 2000;
export const THREAD_CREATION_LIMIT = 10000;

export class ThreadError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 502 | 503, public readonly code: string, message: string) {
    super(message);
  }
}

export interface ThreadContribution {
  id: number;
  title: string;
  artist: string;
  artworkUrl: string | null;
  linkSlug: string;
  source: ParsedTrack & { verified: boolean };
  counterpart?: ParsedTrack & { confirmed: true };
}

export interface PublicationStatus {
  provider: Provider;
  connected: boolean;
  requestedRevision: number;
  appliedRevision: number | null;
  status: "pending" | "blocked" | "failed" | "synced";
  blockedReason: string | null;
  failureCode: string | null;
  verifiedPlaylistId: string | null;
  verifiedPlaylistUrl: string | null;
}

export interface ThreadView {
  publicCapability: string;
  title: string;
  revision: number;
  closedAt: string | null;
  contributions: ThreadContribution[];
  publications: PublicationStatus[];
}

export type CatalogIdentity =
  | { status: "verified"; id: string; storefront: string }
  | { status: "unresolved"; reason: "cross_provider_identity_unresolved" | "legacy_source_not_verified" };

export interface DesiredState {
  publicCapability: string;
  title: string;
  revision: number;
  closed: boolean;
  provider: Provider;
  publication: PublicationStatus | null;
  identitiesComplete: boolean;
  entries: { contributionId: number; title: string; artist: string; identity: CatalogIdentity }[];
}

export interface MutationRequest {
  requestKey: string;
  expectedRevision: number;
}

export type ManagementIntent = { kind: "remove"; id: number } | { kind: "reorder"; ids: number[] } | { kind: "close" } | { kind: "connect"; provider: Provider } | { kind: "identify"; id: number; identity: ParsedTrack };
export type MutationIntent = ManagementIntent | { kind: "add"; source: ParsedTrack };
export interface MutationReceipt { revision: number; replayed: boolean }

export function isThreadCapability(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}

function normalizeText(input: string, label: string, limit: number): string {
  const value = input.trim();
  if (!value || [...value].length > limit || /\p{Cc}/u.test(value)) {
    throw new ThreadError(400, "invalid_input", `${label} must contain 1–${limit} characters without control characters.`);
  }
  return value;
}

export function normalizeThreadTitle(value: string): string {
  return normalizeText(value, "Thread title", 80);
}

export function normalizeRequestKey(value: string): string {
  return normalizeText(value, "Request key", 128);
}

export function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ThreadError(400, "invalid_revision", "Send the current Thread revision.");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function mutationFingerprint(intent: MutationIntent): Promise<string> {
  if (intent.kind === "add") return sha256(JSON.stringify(["add", intent.source.provider, intent.source.id, intent.source.storefront]));
  if (intent.kind === "identify") return sha256(JSON.stringify(["identify", intent.id, intent.identity.provider, intent.identity.id, intent.identity.storefront]));
  if (intent.kind === "remove") return sha256(JSON.stringify(["remove", intent.id]));
  if (intent.kind === "reorder") return sha256(JSON.stringify(["reorder", intent.ids]));
  if (intent.kind === "connect") return sha256(JSON.stringify(["connect", intent.provider]));
  return sha256("close");
}

export function verifiedSource(rawUrl: string, resolved: Resolved): ParsedTrack {
  const input = parseTrackUrl(rawUrl);
  const sourceUrl = input?.provider === "spotify" ? resolved.spotifyUrl : resolved.appleUrl;
  const source = sourceUrl ? parseTrackUrl(sourceUrl) : null;
  if (!input || !source || input.provider !== source.provider || input.id !== source.id) {
    throw new ThreadError(422, "unverified_source", "The provider could not verify this track's catalog identity.");
  }
  return input;
}

export function desiredState(view: ThreadView, provider: Provider): DesiredState {
  const entries = view.contributions.map(song => {
    const catalog = song.source.provider === provider ? song.source
      : song.counterpart?.confirmed && song.counterpart.provider === provider ? song.counterpart : null;
    const identity: CatalogIdentity = !song.source.verified
      ? { status: "unresolved", reason: "legacy_source_not_verified" }
      : !catalog
        ? { status: "unresolved", reason: "cross_provider_identity_unresolved" }
        : { status: "verified", id: catalog.id, storefront: catalog.storefront };
    return { contributionId: song.id, title: song.title, artist: song.artist, identity };
  });
  return { publicCapability: view.publicCapability, title: view.title, revision: view.revision, closed: view.closedAt !== null, provider, publication: view.publications.find(publication => publication.provider === provider) ?? null, identitiesComplete: entries.every(entry => entry.identity.status === "verified"), entries };
}
