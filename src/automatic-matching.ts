import { desiredState, type ThreadView, type DesiredState } from './thread.js';
import type { PublicationTarget } from './publication-db.js';
import { MATCHER_VERSION, type CatalogTrack, type MatchResult } from './track-matching.js';
import type { ParsedTrack, Provider } from './urls.js';

export interface MatchingCatalog {
  get(source: ParsedTrack): Promise<CatalogTrack | null>;
  findMatch(source: CatalogTrack, destination: Provider, storefront: string): Promise<MatchResult>;
}

export async function resolveAutomaticMatches(
  db: D1Database, view: ThreadView, target: PublicationTarget, catalog: MatchingCatalog, storefront: string,
): Promise<DesiredState> {
  const desired = desiredState(view, target.provider);
  let lookups = 0;
  for (const entry of desired.entries) {
    if (entry.identity.status !== 'unresolved' || entry.identity.reason !== 'cross_provider_identity_unresolved') continue;
    const song = view.contributions.find(song => song.id === entry.contributionId)!;
    const saved = await db.withSession('first-primary').prepare(`SELECT result_json FROM automatic_track_matches
      WHERE publisher_key = ? AND contribution_id = ? AND provider = ? AND (status = 'matched' OR attempted_revision = ?)`)
      .bind(target.publisherKey, song.id, target.provider, view.revision).first<string>('result_json');
    let result: MatchResult;
    if (saved) result = JSON.parse(saved);
    else {
      if (lookups >= 5) throw { code: 'matching_pending' };
      lookups += 1;
      const source = await catalog.get(song.source);
      result = source ? await catalog.findMatch(source, target.provider, storefront)
        : { status: 'unavailable', selected: null, candidates: [], method: 'metadata', reason: 'source_unavailable' };
      if (result.selected && (result.status !== 'matched' || result.selected.provider !== target.provider || !result.selected.playable)) {
        throw new Error('invalid_match_result');
      }
      await db.withSession('first-primary').prepare(`INSERT INTO automatic_track_matches
        (publisher_key, contribution_id, provider, storefront, matcher_version, attempted_revision, status, result_json)
        SELECT ?, c.id, ?, ?, ?, ?, ?, ? FROM thread_contributions c JOIN threads t ON t.id = c.thread_id
        WHERE c.id = ? AND t.public_capability = ? AND c.removed_at IS NULL AND c.source_verified = 1
        ON CONFLICT(publisher_key, contribution_id) DO UPDATE SET
          storefront = excluded.storefront, matcher_version = excluded.matcher_version, attempted_revision = excluded.attempted_revision,
          status = excluded.status, result_json = excluded.result_json, created_at = datetime('now')
        WHERE automatic_track_matches.status != 'matched'`)
        .bind(target.publisherKey, target.provider, storefront, MATCHER_VERSION, view.revision, result.status, JSON.stringify(result), song.id, view.publicCapability).run();
    }
    if (result.status === 'matched' && result.selected) {
      entry.identity = { status: 'matched', id: result.selected.id, storefront: result.selected.storefront, method: result.method };
    }
  }
  desired.identitiesComplete = desired.entries.every(entry => entry.identity.status !== 'unresolved');
  return desired;
}
