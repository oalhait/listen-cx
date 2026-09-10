import type { LinkRow, LinkStore } from "./db.js";
import type { Resolver } from "./resolve.js";
import { parseTrackUrl } from "./urls.js";

export const LINK_SLUG_PATTERN = /^[23456789abcdefghjkmnpqrstuvwxyz]{7}$/;

export type LinkActionErrorCode =
  | "invalid_track_url"
  | "track_not_found"
  | "provider_unavailable"
  | "storage_unavailable"
  | "invalid_link"
  | "link_not_found";

export class LinkActionError extends Error {
  constructor(
    readonly code: LinkActionErrorCode,
    readonly status: 400 | 404 | 500 | 502,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LinkActionError";
  }
}

export interface LinkActions {
  resolver: Pick<Resolver, "resolve">;
  store: LinkStore;
  baseUrl: string;
}

export interface CreatedLink {
  link: string;
  slug: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
}

export async function createLink(actions: LinkActions, rawUrl: string): Promise<CreatedLink> {
  if (!parseTrackUrl(rawUrl)) {
    throw new LinkActionError(
      "invalid_track_url",
      400,
      "Send a Spotify or Apple Music track URL.",
    );
  }

  let resolved;
  try {
    resolved = await actions.resolver.resolve(rawUrl);
  } catch {
    throw new LinkActionError(
      "provider_unavailable",
      502,
      "Provider unavailable. Try again.",
      true,
    );
  }

  if (!resolved) {
    throw new LinkActionError("track_not_found", 404, "Track not found.");
  }

  let row;
  try {
    row = await actions.store.upsert(resolved);
  } catch {
    throw new LinkActionError(
      "storage_unavailable",
      500,
      "Internal server error.",
      true,
    );
  }

  return {
    link: `${actions.baseUrl.replace(/\/$/, "")}/${row.slug}`,
    slug: row.slug,
    title: row.title,
    artist: row.artist,
    artworkUrl: row.artwork_url,
  };
}

export function linkSlugFromReference(reference: string, baseUrl: string): string | null {
  const value = reference.trim();
  if (LINK_SLUG_PATTERN.test(value)) return value;

  try {
    const candidate = new URL(value);
    const base = new URL(baseUrl);
    if (
      candidate.origin !== base.origin
      || candidate.username
      || candidate.password
      || candidate.search
      || candidate.hash
    ) {
      return null;
    }

    const match = candidate.pathname.match(/^\/([^/]+)\/?$/);
    return match?.[1] && LINK_SLUG_PATTERN.test(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

export async function getLink(
  store: LinkStore,
  reference: string,
  baseUrl: string,
): Promise<LinkRow> {
  const slug = linkSlugFromReference(reference, baseUrl);
  if (!slug) {
    throw new LinkActionError(
      "invalid_link",
      400,
      "Send a seven-character listen.cx slug or a link from this server.",
    );
  }

  let row;
  try {
    row = await store.get(slug);
  } catch {
    throw new LinkActionError(
      "storage_unavailable",
      500,
      "Internal server error.",
      true,
    );
  }

  if (!row) {
    throw new LinkActionError("link_not_found", 404, "Listen link not found.");
  }
  return row;
}
