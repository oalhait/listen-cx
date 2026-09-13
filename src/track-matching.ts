export interface CatalogTrack {
  provider: "apple" | "spotify";
  id: string;
  storefront: string;
  title: string;
  artist: string;
  album: string | null;
  releaseDate?: string | null;
  albumId?: string | null;
  durationMs: number | null;
  isrc: string | null;
  explicit: boolean | null;
  playable: boolean;
}

export interface MatchResult {
  status: "matched" | "ambiguous" | "unavailable";
  method: "isrc" | "metadata";
  selected: CatalogTrack | null;
  candidates: CatalogTrack[];
  reason: string;
}

export const MATCHER_VERSION = "catalog-v2";

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function artistKey(value: string): string {
  return normalized(value.replace(/\b(?:feat(?:uring)?|ft|and)\b\.?/gi, " ").replace(/[&,]/g, " "));
}

function artistCredits(value: string): string[] {
  return value.split(/\s*(?:,|&)\s*|\s+(?:and|feat(?:uring)?\.?|ft\.?)\s+/i).map(normalized).filter(Boolean);
}

function featuredCredits(title: string): string[] {
  return [...title.normalize("NFKC").matchAll(/\(\s*(?:feat(?:uring)?|ft)\.?\s+([^()]+)\)/gi)].flatMap((match) => artistCredits(match[1]!));
}

function compatibleArtists(a: CatalogTrack, b: CatalogTrack): boolean {
  if (artistKey(a.artist) === artistKey(b.artist)) return true;
  const sameAlbum = a.album !== null && b.album !== null && normalized(a.album) === normalized(b.album);
  const msAlias = (left: string, right: string) => {
    const leftCredits = artistCredits(left);
    const rightCredits = artistCredits(right);
    return leftCredits.length === 1 && rightCredits.length === 1 && leftCredits[0]!.startsWith("ms ")
      && leftCredits[0]!.slice(3) === rightCredits[0] && rightCredits[0]!.includes(" ");
  };
  if (sameAlbum && (msAlias(a.artist, b.artist) || msAlias(b.artist, a.artist))) return true;
  const featured = featuredCredits(a.title);
  if (!featured.length || featured.join("\0") !== featuredCredits(b.title).join("\0")) return false;
  const aCredits = artistCredits(a.artist);
  const bCredits = artistCredits(b.artist);
  if (!aCredits.length || aCredits[0] !== bCredits[0]) return false;
  const primaryCredits = (credits: string[]) => credits.filter((credit, index) => index === 0 || !featured.includes(credit)).join("\0");
  return primaryCredits(aCredits) === primaryCredits(bCredits);
}

function isrcKey(value: string | null): string | null {
  const key = value?.replace(/[\s-]/g, "").toUpperCase();
  return key && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(key) ? key : null;
}

function knownDuration(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function compatibleRatings(a: CatalogTrack, b: CatalogTrack): boolean {
  if (a.explicit !== null && b.explicit !== null) return a.explicit === b.explicit;
  const apple = a.provider === "apple" ? a : b.provider === "apple" ? b : null;
  const spotify = a.provider === "spotify" ? a : b.provider === "spotify" ? b : null;
  return apple?.explicit === null && spotify?.explicit === false;
}

function equivalentRelease(a: CatalogTrack, b: CatalogTrack): boolean {
  const sharedIsrc = isrcKey(a.isrc) !== null && isrcKey(a.isrc) === isrcKey(b.isrc);
  if (!sharedIsrc) return a.provider === b.provider && a.storefront === b.storefront && a.id === b.id;
  if (a.explicit !== null && b.explicit !== null && a.explicit !== b.explicit) return false;
  return !knownDuration(a.durationMs) || !knownDuration(b.durationMs) || Math.abs(a.durationMs - b.durationMs) <= Math.min(3000, Math.min(a.durationMs, b.durationMs) * 0.02);
}

export function selectTrackMatch(source: CatalogTrack, candidates: CatalogTrack[], method: "isrc" | "metadata"): MatchResult {
  const sourceIsrc = isrcKey(source.isrc);
  const tolerance = knownDuration(source.durationMs) ? Math.min(3000, source.durationMs * 0.02) : null;
  const compatible = candidates.filter((candidate) => {
    if (!candidate.playable || !normalized(source.title) || !artistKey(source.artist)) return false;
    if (normalized(source.title) !== normalized(candidate.title) || !compatibleArtists(source, candidate)) return false;
    if (source.explicit !== null && candidate.explicit !== null && source.explicit !== candidate.explicit) return false;
    if (tolerance !== null && knownDuration(candidate.durationMs) && Math.abs(candidate.durationMs - source.durationMs!) > tolerance) return false;
    return method !== "isrc" || (sourceIsrc !== null && sourceIsrc === isrcKey(candidate.isrc));
  });
  const sufficient = (candidate: CatalogTrack) => method === "isrc" || (knownDuration(source.durationMs) && knownDuration(candidate.durationMs) && compatibleRatings(source, candidate));
  const albumMatch = (candidate: CatalogTrack) => source.album !== null && normalized(source.album) === normalized(candidate.album ?? "");
  const distance = (candidate: CatalogTrack) => knownDuration(source.durationMs) && knownDuration(candidate.durationMs) ? Math.abs(source.durationMs - candidate.durationMs) : Infinity;
  compatible.sort((a, b) => Number(sufficient(b)) - Number(sufficient(a)) || Number(albumMatch(b)) - Number(albumMatch(a)) || distance(a) - distance(b) || a.id.localeCompare(b.id));
  const groups: CatalogTrack[][] = [];
  for (const candidate of compatible) {
    const group = groups.find((members) => members.every((member) => equivalentRelease(member, candidate)));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const suggestions = groups.map((members) => members[0]!);
  const albumSuggestions = method === "metadata" && sourceIsrc === null && source.album !== null ? suggestions.filter(albumMatch) : [];
  const releaseSuggestions = source.releaseDate ? albumSuggestions.filter(candidate => candidate.releaseDate === source.releaseDate) : [];
  const narrowed = suggestions.length > 1 && albumSuggestions.length > 0 && albumSuggestions.every(candidate => candidate.releaseDate)
    && releaseSuggestions.length === 1 ? releaseSuggestions : suggestions;
  const selected = narrowed.length === 1 && sufficient(narrowed[0]!) ? narrowed[0]! : null;
  const reason = !narrowed.length
    ? "No playable candidate passed title, artist, recording-version, explicitness, and duration guards."
    : narrowed.length > 1
      ? "Multiple distinct recording identities remain; select a candidate."
      : !selected
        ? "Matching metadata lacks known duration or compatible content ratings; confirmation is required."
        : `${method === "isrc" ? "Shared ISRC and compatible recording metadata" : releaseSuggestions.length === 1 ? "Matching normalized title, artist, album release, duration, and compatible content ratings" : "Matching normalized title, artist, duration, and compatible content ratings"}; duration tolerance is the smaller of 3 seconds and 2% of source duration.`;
  return { status: selected ? "matched" : narrowed.length ? "ambiguous" : "unavailable", method, selected, candidates: narrowed, reason };
}
