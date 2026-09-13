CREATE TABLE automatic_track_matches (
  publisher_key TEXT NOT NULL,
  contribution_id INTEGER NOT NULL REFERENCES thread_contributions(id),
  provider TEXT NOT NULL CHECK (provider IN ('spotify', 'apple')),
  storefront TEXT NOT NULL,
  matcher_version TEXT NOT NULL,
  attempted_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('matched', 'ambiguous', 'unavailable')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (publisher_key, contribution_id)
);
CREATE INDEX automatic_track_matches_contribution ON automatic_track_matches(contribution_id);

UPDATE thread_publications SET status = 'pending', blocked_reason = NULL, next_attempt_at = 0
WHERE connected = 1 AND status = 'blocked' AND blocked_reason = 'identities_incomplete';
UPDATE thread_subscriptions SET status = 'pending', blocked_reason = NULL, next_attempt_at = 0
WHERE connected = 1 AND status = 'blocked' AND blocked_reason = 'identities_incomplete';
