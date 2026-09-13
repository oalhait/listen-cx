import { D1PublicationStore, type PublicationTarget } from "./publication-db.js";
import { D1ThreadStore } from "./thread-db.js";
import { desiredState, type ThreadView, type DesiredState } from "./thread.js";
import type { Provider } from "./urls.js";

export type PublicationInput = { playlistKey: string; title: string; revision: number; trackIds: string[] };
export type PublicationReadback = { revision: number; playlistId: string; playlistUrl: string };
export type ProviderPublishers = Partial<Record<Provider, (input: PublicationInput) => Promise<PublicationReadback>>>;

function failure(error: unknown): { code: string; blocked: boolean; delay: number } {
  const value = error as { code?: unknown; status?: unknown; retryAfterSeconds?: unknown } | null;
  if (value?.code === "matching_pending") return { code: "matching_pending", blocked: false, delay: 1000 };
  if (value?.status === 429) return { code: "rate_limited", blocked: false,
    delay: typeof value.retryAfterSeconds === "number" && Number.isFinite(value.retryAfterSeconds) && value.retryAfterSeconds > 0
      ? Math.max(60000, value.retryAfterSeconds * 1000) : 60000 };
  if (value?.status === 401 || value?.status === 403) return { code: "publisher_not_authorized", blocked: true, delay: 0 };
  const blocked = new Set(["create_unresolved", "append_only", "provider_drift", "destination_mismatch", "publisher_mismatch", "unresolved_track"]);
  if (typeof value?.code === "string" && blocked.has(value.code)) return { code: value.code, blocked: true, delay: 0 };
  return { code: value?.code === "readback_invalid" ? "readback_invalid" : "provider_unavailable", blocked: false, delay: 60000 };
}

export type IdentityResolver = (view: ThreadView, target: PublicationTarget) => Promise<DesiredState>;

export async function runPublication(db: D1Database, publisherKey: string, publishers: ProviderPublishers, resolve?: IdentityResolver): Promise<number | null> {
  const publications = new D1PublicationStore(db);
  const target = await publications.target(publisherKey);
  if (!target) return null;
  if (target.nextAttemptAt > Date.now()) return target.nextAttemptAt;
  const threads = new D1ThreadStore(db);
  const view = await threads.get(target.capability);
  if (!view) return null;
  let desired = desiredState(view, target.provider);
  if (target.status === "synced" && target.appliedRevision === desired.revision) return null;
  const publish = publishers[target.provider];
  if (!publish) {
    await publications.failed(publisherKey, desired.revision, "publisher_not_authorized", true, 0);
    return null;
  }
  try {
    if (!desired.identitiesComplete && resolve) {
      desired = await resolve(view, target);
      const current = await threads.get(target.capability);
      if (!current) return null;
      if (current.revision !== desired.revision) return Date.now() + 1;
    }
    if (!desired.identitiesComplete) {
      await publications.failed(publisherKey, desired.revision, "identities_incomplete", true, 0);
      return null;
    }
    const result = await publish({ playlistKey: publisherKey, title: desired.title, revision: desired.revision,
      trackIds: desired.entries.map(entry => {
        if (entry.identity.status === "unresolved") throw new Error("identities_incomplete");
        return entry.identity.id;
      }) });
    if (result.revision !== desired.revision) throw { code: "readback_invalid" };
    await publications.verified(publisherKey, result.revision, result.playlistId, result.playlistUrl);
  } catch (error) {
    const result = failure(error);
    const retryAt = result.blocked ? 0 : Date.now() + result.delay;
    await publications.failed(publisherKey, desired.revision, result.code, result.blocked, retryAt);
    if (result.code === "rate_limited") return retryAt;
    const current = await threads.get(target.capability);
    if (current && current.revision > desired.revision) return Date.now() + 1;
    return result.blocked ? null : retryAt;
  }
  const current = await threads.get(target.capability);
  return current && current.revision > desired.revision ? Date.now() + 1 : null;
}
